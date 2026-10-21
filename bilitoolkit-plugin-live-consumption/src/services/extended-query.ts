import { parseAmount } from './consumption-core.js'
import { parseLosslessJson } from './lossless-json.js'

const LIVE = 'https://api.live.bilibili.com'
export const BLIND_INFO_ENDPOINT = LIVE + '/xlive/general-interface/v1/blindFirstWin/getInfo'
export const BLIND_RECORD_ENDPOINT = LIVE + '/xlive/general-interface/v1/blind-box/drawStream'
export interface GiftInfo {
  id: string
  name: string
  image: string
  price: number
  blind?: boolean
}
export interface BlindConfig {
  id: string
  name: string
  price: number
  priceKnown?: boolean
  gifts: (GiftInfo & { chance?: string | number; isWin: boolean })[]
}
export interface BlindRecord {
  id: string
  giftId: string
  giftName: string
  giftImg: string
  giftNum: number
  originalGiftId: string
  originalGiftName: string
  timestamp: number
  anchorId: string
  anchorName: string
}
export interface BlindSnapshot {
  uid: string
  boxId: string
  records: BlindRecord[]
  config: BlindConfig
  updatedAt: string
  coverage: 'complete' | 'partial'
  pages: number
  warning?: string
}
export interface BagRecord {
  id: string
  name: string
  image: string
  count: number
  price: number
  locked: boolean
  lockedText: string
  expireAt?: number
}
type ApiRow = Record<string, unknown>
export interface LiveResponse {
  code: number
  message?: string
  msg?: string
  data?: Record<string, unknown>
}
export type LiveRequest = (url: string, signal?: AbortSignal) => Promise<LiveResponse>
const object = (value: unknown): ApiRow =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ApiRow) : {}
const list = (value: unknown): ApiRow[] => (Array.isArray(value) ? value.map(object) : [])
const quantity = (value: unknown) => {
  const count = Number(value)
  if (!Number.isFinite(count) || count < 0) throw new Error('礼物数量格式异常')
  return count
}
export function parseBlindTimestamp(value: unknown): number {
  const text = String(value ?? '').trim()
  let seconds: number
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text)
    seconds = numeric > 1e12 ? numeric / 1000 : numeric
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)) {
    // drawStream returns Beijing wall-clock strings, unlike payRecord Unix seconds.
    seconds = Date.parse(text.replace(' ', 'T') + '+08:00') / 1000
  } else if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    seconds = Date.parse(text) / 1000
  } else throw new Error('盲盒记录缺少有效时间')
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('盲盒记录缺少有效时间')
  return seconds
}
function check(response: LiveResponse): ApiRow {
  if (response.code === -101 || response.code === 3) throw new Error('登录凭据失效，请重新选择并授权本人账号')
  if (response.code !== 0) throw new Error(response.message || response.msg || `查询失败（${response.code}）`)
  if (!response.data || typeof response.data !== 'object') throw new Error('查询接口未返回有效数据')
  return response.data
}
function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('查询已停止', 'AbortError')
}
export const requestLive: LiveRequest = async (url, signal) => {
  // Keep credentials within Bilibili; response data never includes the request Cookie.
  if (new URL(url).origin !== LIVE) throw new Error('仅允许请求 B 站直播接口')
  assertActive(signal)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 20000)
  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`查询失败：HTTP ${response.status}`)
    return parseLosslessJson(await response.text()) as LiveResponse
  } catch (cause) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('查询超时，请稍后重试')
    throw cause
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
export async function loadGiftCatalog(signal?: AbortSignal, request = requestLive): Promise<GiftInfo[]> {
  const data = check(
    await request(LIVE + '/xlive/web-room/v1/giftPanel/giftConfig?platform=pc&room_id=1844040969', signal),
  )
  if (!Array.isArray(data.list)) throw new Error('礼物配置格式不受支持')
  return list(data.list).map((gift) => ({
    id: String(gift.id),
    name: String(gift.name ?? ''),
    image: String(gift.img_basic || gift.webp || gift.gif || ''),
    price: parseAmount(gift.price) / 100,
    blind: /盲盒/.test(String(gift.name ?? '')) || Number(gift.gift_type) === 6,
  }))
}
export async function loadBlindConfig(
  boxId: string,
  signal?: AbortSignal,
  request = requestLive,
): Promise<BlindConfig> {
  if (!/^\d+$/.test(boxId)) throw new Error('请输入有效的盲盒礼物 ID')
  const data = check(await request(`${BLIND_INFO_ENDPOINT}?gift_id=${encodeURIComponent(boxId)}`, signal))
  if (!Array.isArray(data.gifts) || data.gifts.length === 0)
    throw new Error('该礼物未返回盲盒配置，可能已下架或不是盲盒')
  return {
    id: boxId,
    name: String(data.blind_gift_name || `盲盒 ${boxId}`),
    price: parseAmount(data.blind_price) / 100,
    priceKnown: data.blind_price !== undefined && data.blind_price !== null,
    gifts: list(data.gifts).map((gift) => ({
      id: String(gift.gift_id),
      name: String(gift.gift_name ?? ''),
      image: String(gift.gift_img ?? ''),
      price: parseAmount(gift.price) / 100,
      chance: typeof gift.chance === 'string' || typeof gift.chance === 'number' ? gift.chance : undefined,
      isWin: gift.is_win_gift === true || gift.is_win_gift === 1 || gift.is_win_gift === '1',
    })),
  }
}
function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    assertActive(signal)
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('查询已停止', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
export async function collectBlindRecords(options: {
  uid: string
  boxId: string
  config: BlindConfig
  signal?: AbortSignal
  onProgress?: (progress: { pages: number; records: number }) => void
  request?: LiveRequest
  maxPages?: number
  delayMs?: number
}): Promise<BlindSnapshot> {
  const { uid, boxId, config, signal, request = requestLive, maxPages = 100, delayMs = 350 } = options
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(boxId) || boxId !== config.id) throw new Error('账号或盲盒配置不一致')
  const records: BlindRecord[] = []
  const seenPages = new Set<string>()
  const seenCursors = new Set<string>()
  const seenIds = new Set<string>()
  let params: Record<string, string> = {},
    pages = 0,
    complete = false,
    warning: string | undefined
  try {
    while (pages < maxPages) {
      assertActive(signal)
      const query = new URLSearchParams({ ...params, gift_id: boxId, page_size: '50' })
      const data = check(await request(`${BLIND_RECORD_ENDPOINT}?${query}`, signal))
      if (!Array.isArray(data.list)) throw new Error('盲盒记录格式不受支持')
      const raw = list(data.list)
      pages++
      if (!raw.length) {
        complete = true
        break
      }
      const fingerprint = JSON.stringify(raw)
      if (seenPages.has(fingerprint)) {
        warning = '接口重复返回同一页，当前结果不代表全部历史'
        break
      }
      seenPages.add(fingerprint)
      for (const [index, row] of raw.entries()) {
        const timestamp = parseBlindTimestamp(row.timestamp)
        // No stable ID is supplied in some versions. Preserve identical legitimate
        // draws in a page rather than collapsing same-second gifts by timestamp.
        const stableId = row.id === undefined || row.id === null ? undefined : String(row.id)
        if (stableId && seenIds.has(stableId)) continue
        if (stableId) seenIds.add(stableId)
        records.push({
          id: stableId || `page:${pages}:row:${index}`,
          giftId: String(row.gift_id ?? ''),
          giftName: String(row.gift_name ?? '未知礼物'),
          giftImg: String(row.gift_img ?? ''),
          giftNum: quantity(row.gift_num ?? 1),
          originalGiftId: String(row.original_gift_id ?? boxId),
          originalGiftName: String(row.original_gift_name ?? config.name),
          timestamp,
          anchorId: String(row.ruid ?? ''),
          anchorName: String(row.rname ?? row.r_uname ?? '未知主播'),
        })
      }
      options.onProgress?.({ pages, records: records.length })
      const next = object(data.params)
      const flag = next.have_more ?? data.isMore ?? data.has_more
      if (flag === undefined || ![true, 1, '1'].includes(flag as boolean | number | string)) {
        if (flag === undefined) warning = '接口未返回是否有下一页的标志，已保留当前记录'
        else complete = true
        break
      }
      params = {}
      // Forward only scalar pagination fields; never let a cursor redirect a request.
      for (const [key, value] of Object.entries(next)) {
        if (['have_more', 'gift_id', 'page_size'].includes(key)) continue
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value))
          params[key] = String(value)
      }
      const cursor = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString()
      if (!cursor || seenCursors.has(cursor)) {
        warning = '盲盒分页游标缺失或重复，已保留部分结果'
        break
      }
      seenCursors.add(cursor)
      await wait(delayMs, signal)
    }
    if (!complete && !warning) warning = `已达到 ${maxPages} 页查询上限，当前结果不代表全部历史`
  } catch (cause) {
    warning = signal?.aborted ? '查询已停止，已保留部分结果' : cause instanceof Error ? cause.message : '盲盒查询失败'
    if (!records.length) throw new Error(warning)
  }
  return {
    uid,
    boxId,
    records,
    config,
    updatedAt: new Date().toISOString(),
    coverage: complete ? 'complete' : 'partial',
    pages,
    warning,
  }
}
export async function loadBagInventory(signal?: AbortSignal, request = requestLive): Promise<BagRecord[]> {
  const data = check(await request(LIVE + '/xlive/web-room/v1/gift/bag_list?room_id=23915535', signal))
  if (!Array.isArray(data.list)) throw new Error('包裹接口未返回有效列表')
  const config = new Map(list(data.gift_config).map((gift) => [String(gift.id), gift]))
  return list(data.list).map((row) => {
    const gift = config.get(String(row.gift_id)) || {}
    return {
      id: String(row.gift_id),
      name: String(row.gift_name ?? gift.name ?? '未知礼物'),
      image: String(gift.img_basic || row.gift_img || ''),
      count: quantity(row.gift_num ?? 0),
      price: parseAmount(gift.price) / 100,
      locked: row.is_locked === true || row.is_locked === 1 || row.is_locked === '1',
      lockedText: String(row.locked_text ?? ''),
      expireAt: Number(row.expire_at ?? row.expire_time) || undefined,
    }
  })
}
export async function loadRewardCatalog(
  signal?: AbortSignal,
  request = requestLive,
): Promise<{
  guardIds: string[]
  redPacketIds: string[]
  warnings: string[]
}> {
  const warnings: string[] = [],
    guardIds: string[] = [],
    redPacketIds: string[] = []
  try {
    const data = check(await request(LIVE + '/xlive/general-interface/v1/guardBenefit/GiftPanel', signal))
    if (!Array.isArray(data.list)) throw new Error('天选礼物配置格式异常')
    guardIds.push(...list(data.list).map((gift) => String(gift.id)))
  } catch (cause) {
    if (signal?.aborted) throw cause
    warnings.push(cause instanceof Error ? cause.message : '天选礼物配置获取失败')
  }
  try {
    const data = check(
      await request(
        LIVE +
          '/xlive/lottery-interface/v1/popularityRedPocket/RedPocketDetail?room_id=23915535&ruid=488750234&platform=pc&rp_type=1',
        signal,
      ),
    )
    if (!Array.isArray(data.item)) throw new Error('红包礼物配置格式异常')
    for (const row of list(data.item))
      for (const award of list(row.award_info)) if (award.award_id) redPacketIds.push(String(award.award_id))
  } catch (cause) {
    if (signal?.aborted) throw cause
    warnings.push(cause instanceof Error ? cause.message : '红包礼物配置获取失败')
  }
  return { guardIds: [...new Set(guardIds)], redPacketIds: [...new Set(redPacketIds)], warnings }
}
