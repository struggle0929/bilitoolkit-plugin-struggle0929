import type { CollectionSnapshot, ConsumptionRecord, PayRecordPage } from '../types/consumption.js'
import { md5 } from './md5.js'
import { mergeRecords, normalizeRecord } from './consumption-core.js'
import { parseLosslessJson } from './lossless-json.js'

export const PAY_RECORD_ENDPOINT = 'https://api.live.bilibili.com/xlive/revenue/v2/giftStream/payRecord'
const APP_SECRET = '560c52ccd288fed045859ed18bffd973'

export function buildPayRecordUrl(nextId?: string, now = Date.now()): string {
  const params: Record<string, string> = {
    actionKey: 'appkey',
    appkey: '1d8b6e7d45233436',
    build: '8870400',
    c_locale: 'zh-Hans_CN',
    channel: 'oppo',
    coin_type: 'gold',
    device: 'android',
    disable_rcmd: '0',
    mobi_app: 'android',
    page_size: '50',
    platform: 'android',
    s_locale: 'zh-Hans_CN',
    statistics: JSON.stringify({ appId: 1, platform: 3, version: '8.87.0', abtest: '' }),
    ts: String(Math.floor(now / 1000)),
    version: '8.87.0',
  }
  if (nextId) params.next_id = nextId
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key]!)}`)
    .join('&')
  params.sign = md5(canonical + APP_SECRET)
  return `${PAY_RECORD_ENDPOINT}?${new URLSearchParams(params)}`
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('查询已停止', 'AbortError')
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    aborted(signal)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('查询已停止', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function defaultRequest(url: string, signal?: AbortSignal): Promise<PayRecordPage> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  aborted(signal)
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal })
    if (!response.ok) throw new Error(`账单请求失败：HTTP ${response.status}`)
    return parseLosslessJson(await response.text()) as PayRecordPage
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('账单请求超时，请检查网络后重试')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function collectConsumption(options: {
  uid: string
  existing?: CollectionSnapshot
  mode: 'full' | 'incremental'
  signal?: AbortSignal
  onProgress?: (progress: { pages: number; records: number }) => void
  request?: (url: string, signal?: AbortSignal) => Promise<PayRecordPage>
  maxPages?: number
  delayMs?: number
}): Promise<CollectionSnapshot> {
  const { uid, mode, signal, onProgress, request = defaultRequest, maxPages = 1000, delayMs = 350 } = options
  if (!/^\d+$/.test(uid)) throw new Error('请先选择本人已登录的账号')
  if (options.existing && options.existing.uid !== uid) throw new Error('缓存账号不一致，已拒绝混用账单')
  const existing = options.existing
  const previous = existing?.records ?? []
  const incremental = mode === 'incremental' && existing?.coverage === 'complete' && previous.length > 0
  const lastTime = previous.reduce((max, record) => Math.max(max, record.timestamp), 0)
  const cutoff = incremental ? lastTime - 7 * 86400 : 0
  const fresh: ConsumptionRecord[] = []
  const knownIds = new Set(previous.map((record) => record.id))
  const freshIds = new Set<string>()
  let pages = 0,
    nextId: string | undefined,
    complete = false,
    warning: string | undefined
  const cursors = new Set<string>()
  try {
    while (pages < maxPages) {
      aborted(signal)
      let response: PayRecordPage | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        aborted(signal)
        try {
          response = await request(buildPayRecordUrl(nextId), signal)
          break
        } catch (error) {
          if (signal?.aborted || attempt === 2) throw error
          await delay(/412|429/.test(String(error)) ? 30000 : 500 * 2 ** attempt, signal)
        }
      }
      if (!response) throw new Error('未收到消费查询响应')
      if (response.code === -101 || response.code === 3 || /未登录/.test(response.message ?? response.msg ?? '')) {
        throw new Error('登录凭据失效，请在账号管理中重新登录后再查询')
      }
      if (response.code !== 0 || !Array.isArray(response.data?.list))
        throw new Error(response.message || response.msg || '消费接口返回了未知格式')
      pages++
      const list = response.data.list.map(normalizeRecord)
      const duplicatePage = list.every((record) => freshIds.has(record.id))
      fresh.push(...list)
      for (const record of list) {
        knownIds.add(record.id)
        freshIds.add(record.id)
      }
      onProgress?.({ pages, records: knownIds.size })
      const cursor = response.data.params?.next_id
      const following =
        cursor === undefined || cursor === null || String(cursor) === '0' || String(cursor) === ''
          ? undefined
          : String(cursor)
      if (list.length === 0 || !following) {
        complete = true
        nextId = undefined
        break
      }
      // Some endpoints keep returning the last row/cursor instead of next_id=0.
      if (duplicatePage && nextId === following) {
        complete = true
        nextId = undefined
        break
      }
      if (incremental && list.some((record) => record.timestamp < cutoff)) {
        complete = true
        nextId = undefined
        break
      }
      if (cursors.has(following) || nextId === following) {
        warning = '接口游标重复，已保留已取得的数据；请稍后完整重查'
        nextId = following
        break
      }
      cursors.add(following)
      nextId = following
      await delay(delayMs, signal)
    }
    if (!complete && !warning) warning = `已达到 ${maxPages} 页的单次查询上限，当前结果不代表全部历史`
  } catch (error) {
    warning = signal?.aborted ? '查询已停止，当前显示已取得的数据' : error instanceof Error ? error.message : '查询失败'
    if (!fresh.length) throw new Error(warning)
  }
  return {
    formatVersion: 1,
    uid,
    records: mergeRecords(mode === 'full' && complete ? [] : previous, fresh),
    updatedAt: new Date().toISOString(),
    coverage: complete ? 'complete' : 'partial',
    pages,
    nextId,
    warning,
  }
}
