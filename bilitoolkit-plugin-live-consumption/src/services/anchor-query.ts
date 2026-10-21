import { parseLosslessJson } from './lossless-json.js'
import { requestLive, type LiveRequest, type LiveResponse } from './extended-query.js'

const ROOT = 'https://api.live.bilibili.com'
export interface QuerySnapshot {
  uid: string
  kind: string
  records: Record<string, unknown>[]
  updatedAt: string
  coverage: 'complete' | 'partial'
  pages: number
  warning?: string
}
type QueryOptions = {
  uid: string
  signal?: AbortSignal
  onProgress?: (progress: { pages: number; records: number }) => void
  maxPages?: number
  delayMs?: number
}
function dataOf(response: LiveResponse) {
  if (response.code !== 0)
    throw new Error(response.message || response.msg || `主播查询失败（${response.code}），请确认本人账号拥有对应权限`)
  if (!response.data) throw new Error('主播接口未返回数据')
  return response.data
}
function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('主播接口返回的记录格式不受支持')
  return value as Record<string, unknown>[]
}
function check(options: QueryOptions) {
  if (!/^\d+$/.test(options.uid)) throw new Error('请先选择并授权本人账号')
  if (options.signal?.aborted) throw new DOMException('查询已停止', 'AbortError')
}
async function delay(options: QueryOptions) {
  check(options)
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('查询已停止', 'AbortError'))
    }
    const timer = setTimeout(() => {
      options.signal?.removeEventListener('abort', abort)
      resolve()
    }, options.delayMs ?? 350)
    options.signal?.addEventListener('abort', abort, { once: true })
  })
}
function result(
  options: QueryOptions,
  kind: string,
  records: Record<string, unknown>[],
  pages: number,
  complete: boolean,
  warning?: string,
): QuerySnapshot {
  return {
    uid: options.uid,
    kind,
    records,
    updatedAt: new Date().toISOString(),
    pages,
    coverage: complete ? 'complete' : 'partial',
    warning,
  }
}
function failure(cause: unknown, options: QueryOptions, records: unknown[]): string {
  const warning = options.signal?.aborted
    ? '查询已停止，保留已取得的记录'
    : cause instanceof Error
      ? cause.message
      : '主播查询失败'
  if (!records.length) throw new Error(warning)
  return warning
}
async function postReceived(body: URLSearchParams, signal?: AbortSignal): Promise<LiveResponse> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 20000)
  try {
    // This POST reads the logged-in anchor's own gift history; it does not send gifts.
    const response = await fetch(ROOT + '/xlive/revenue/v1/giftStream/getReceivedGiftStream', {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!response.ok) throw new Error(`收礼查询失败：HTTP ${response.status}`)
    return parseLosslessJson(await response.text()) as LiveResponse
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
export async function collectReceived(
  options: QueryOptions & {
    startDate: string
    endDate: string
    csrf: string
    request?: (body: URLSearchParams, signal?: AbortSignal) => Promise<LiveResponse>
  },
): Promise<QuerySnapshot> {
  check(options)
  const { startDate, endDate, csrf, request = postReceived } = options
  const start = Date.parse(startDate + 'T00:00:00+08:00'),
    end = Date.parse(endDate + 'T00:00:00+08:00')
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
    !Number.isFinite(start + end) ||
    end < start ||
    end - start > 30 * 86400000
  )
    throw new Error('请选择起止日期，单次收礼查询最多 31 天；更早记录可分段查询')
  if (!csrf || /[\r\n;]/.test(csrf)) throw new Error('缺少 B 站请求校验凭据，请重新授权本人账号')
  const records: Record<string, unknown>[] = [],
    fingerprints = new Set<string>()
  let pages = 0,
    complete = false,
    warning: string | undefined
  try {
    while (pages < (options.maxPages ?? 1000)) {
      check(options)
      const body = new URLSearchParams({
        page: String(pages),
        gift_id: '0',
        begin_date: startDate.replace(/-/g, ''),
        end_date: endDate.replace(/-/g, ''),
        uname: '',
        goods_id: '',
        csrf_token: csrf,
        csrf,
      })
      let data = dataOf(await request(body, options.signal))
      // ready=0 is asynchronous preparation, never a confirmed empty history.
      for (let attempt = 0; Number(data.ready) === 0 && Number(data.total_page) === 0 && attempt < 3; attempt++) {
        await delay(options)
        data = dataOf(await request(body, options.signal))
      }
      if (Number(data.ready) === 0 && Number(data.total_page) === 0)
        throw new Error('收礼数据尚未就绪，请稍后重试；不能据此判定没有记录')
      const rows = asRows(data.list)
      pages++
      if (rows.length) {
        const fingerprint = JSON.stringify(rows)
        if (fingerprints.has(fingerprint)) {
          warning = '收礼接口重复返回同一页，当前结果不完整'
          break
        }
        fingerprints.add(fingerprint)
        records.push(...rows)
      }
      options.onProgress?.({ pages, records: records.length })
      const total = Number(data.total_page)
      if (Number.isFinite(total) && total >= 0 && pages >= total) {
        complete = true
        break
      }
      if (!rows.length) {
        warning = '收礼接口返回空页但未确认总页数，当前结果不完整'
        break
      }
      await delay(options)
    }
    if (!complete && !warning) warning = '达到收礼查询页数上限，当前结果不完整'
  } catch (cause) {
    warning = failure(cause, options, records)
  }
  return result(options, 'received', records, pages, complete, warning)
}
export async function collectLiveSessions(
  options: QueryOptions & { request?: LiveRequest; now?: number },
): Promise<QuerySnapshot> {
  check(options)
  const request = options.request ?? requestLive,
    records: Record<string, unknown>[] = [],
    seen = new Set<string>()
  const cutoff = Math.floor((options.now ?? Date.now()) / 1000) - 7 * 86400
  let cursor = '',
    pages = 0,
    complete = false,
    warning: string | undefined
  try {
    while (pages < (options.maxPages ?? 20)) {
      check(options)
      const params = new URLSearchParams({ source: '1' })
      if (cursor) params.set('end_time', cursor)
      const data = dataOf(
        await request(
          ROOT + '/xlive/anchor-task-interface/api/v1/GetHistoryLiveStreamRecordListNew?' + params,
          options.signal,
        ),
      )
      const rows = asRows(data.list)
      pages++
      records.push(...rows.filter((row) => Number(row.start_time) >= cutoff))
      options.onProgress?.({ pages, records: records.length })
      if (data.last === true || !rows.length || rows.some((row) => Number(row.start_time) < cutoff)) {
        complete = true
        break
      }
      cursor = String(data.next_start_time ?? '')
      if (!cursor || seen.has(cursor)) {
        warning = '直播场次分页游标缺失或重复，当前结果不完整'
        break
      }
      seen.add(cursor)
      await delay(options)
    }
    if (!complete && !warning) warning = '达到直播场次查询页数上限，当前结果不完整'
  } catch (cause) {
    warning = failure(cause, options, records)
  }
  return result(options, 'live-sessions-7days', records, pages, complete, warning)
}
type SessionOptions = { liveId: string; startTime: number; endTime: number; signal?: AbortSignal }
function sessionParams(options: SessionOptions): URLSearchParams {
  if (
    !options.liveId ||
    !Number.isFinite(options.startTime) ||
    !Number.isFinite(options.endTime) ||
    options.endTime < options.startTime
  )
    throw new Error('请选择有效的直播场次')
  return new URLSearchParams({
    live_key: options.liveId,
    start_time: String(options.startTime),
    end_time: String(options.endTime),
  })
}
export async function collectLiveGifts(
  options: QueryOptions & SessionOptions & { request?: LiveRequest },
): Promise<QuerySnapshot> {
  check(options)
  const request = options.request ?? requestLive,
    records: Record<string, unknown>[] = [],
    seen = new Set<string>()
  let index = '0',
    logDate = '',
    pages = 0,
    complete = false,
    warning: string | undefined
  try {
    while (pages < (options.maxPages ?? 500)) {
      check(options)
      const params = sessionParams(options)
      params.set('type', '1')
      params.set('index', index)
      params.set('log_date', logDate)
      params.set('page_size', '50')
      const data = dataOf(
        await request(
          ROOT + '/xlive/anchor-center-interface/v1/anchorLiveData/GetLiveRecordInfos?' + params,
          options.signal,
        ),
      )
      records.push(...asRows(data.gift_income_details))
      pages++
      options.onProgress?.({ pages, records: records.length })
      const nextIndex = String(data.next_index ?? ''),
        nextDate = String(data.log_date ?? '')
      if (nextIndex === '-1' && !nextDate) {
        complete = true
        break
      }
      const cursor = JSON.stringify([nextIndex, nextDate])
      if (!nextIndex || seen.has(cursor) || (index === nextIndex && logDate === nextDate)) {
        warning = '场次收礼游标缺失或重复，当前结果不完整'
        break
      }
      seen.add(cursor)
      index = nextIndex
      logDate = nextDate
      await delay(options)
    }
    if (!complete && !warning) warning = '达到场次收礼查询页数上限，当前结果不完整'
  } catch (cause) {
    warning = failure(cause, options, records)
  }
  return result(options, 'live-gifts-' + options.liveId, records, pages, complete, warning)
}
export async function loadLiveBase(
  options: SessionOptions & { request?: LiveRequest },
): Promise<Record<string, unknown>> {
  const params = sessionParams(options)
  params.set('source', '1')
  const data = dataOf(
    await (options.request ?? requestLive)(
      ROOT + '/xlive/anchor-center-interface/v1/anchorLiveData/GetLiveBaseInfo?' + params,
      options.signal,
    ),
  )
  // The service can return signed playback URLs. They are not needed for a bill
  // query, so remove them before this data reaches UI, caches or exports.
  const omit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(omit)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !/url|stream|token|cookie|sign|authorization/i.test(key))
          .map(([key, val]) => [key, omit(val)]),
      )
    return value
  }
  return omit(data) as Record<string, unknown>
}
