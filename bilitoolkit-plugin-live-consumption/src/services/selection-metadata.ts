import { synthesisActivities } from '../data/synthesis-activities.js'
import { loadGiftCatalog, type GiftInfo } from './extended-query.js'
import type { SynthesisActivity } from './synthesis-options.js'

export const ACTIVITY_CONFIG_URL = 'https://bili-bili.icu/api/config'
export interface SelectionMetadata {
  formatVersion: 1
  gifts: GiftInfo[]
  activities: SynthesisActivity[]
  catalogUpdatedAt?: string
  activitiesUpdatedAt?: string
}
export function initialSelectionMetadata(): SelectionMetadata {
  return {
    formatVersion: 1,
    gifts: [],
    activities: synthesisActivities.map((item) => ({
      ...item,
      materials: [...item.materials],
      products: [...item.products],
    })),
  }
}
export function parseActivityRules(value: unknown): SynthesisActivity[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('活动规则列表格式不受支持')
  const names = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 200) throw new Error('活动材料或产物格式不受支持')
    return [
      ...new Set(
        value
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= 160)
          .map((item) => item.trim()),
      ),
    ]
  }
  const result = new Map<string, SynthesisActivity>()
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new Error('活动规则格式不受支持')
    const row = item as Record<string, unknown>
    const id = String(row.id ?? '').trim(),
      name = String(row.name ?? '').trim()
    if (!id || !name || id.length > 160 || name.length > 160) throw new Error('活动名称或标识格式异常')
    const materials = names(row.materials),
      products = names(row.products)
    if (!materials.length || !products.length) throw new Error('活动缺少材料或产物规则')
    const timestamp = (value: unknown) => (value === undefined || value === null ? undefined : Number(value))
    const startTime = timestamp(row.start_time ?? row.startTime),
      endTime = timestamp(row.end_time ?? row.endTime)
    if (
      [startTime, endTime].some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0)) ||
      (startTime !== undefined && endTime !== undefined && startTime > endTime)
    )
      throw new Error('活动日期配置异常')
    result.set(id, { id, name, materials, products, startTime, endTime })
  }
  return [...result.values()]
}
export function mergeActivityRules(previous: SynthesisActivity[], current: SynthesisActivity[]): SynthesisActivity[] {
  const map = new Map(previous.map((item) => [item.id, item]))
  for (const item of current) map.set(item.id, item)
  return [...map.values()]
}
export async function loadActivityRules(signal?: AbortSignal): Promise<SynthesisActivity[]> {
  if (signal?.aborted) throw new DOMException('已停止刷新', 'AbortError')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 12000)
  try {
    // Public rules only. No account ID, Cookie, referrer or bill is sent here.
    const response = await fetch(ACTIVITY_CONFIG_URL, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`活动配置请求失败：HTTP ${response.status}`)
    const result = (await response.json()) as { code?: number; data?: { synthesis_activities?: unknown } }
    if (result.code !== 0) throw new Error('活动配置服务返回失败')
    const activities = parseActivityRules(result.data?.synthesis_activities)
    if (!activities.length) throw new Error('活动配置为空，保留已有规则')
    return activities
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
export function restoreSelectionMetadata(value: unknown): SelectionMetadata {
  const fallback = initialSelectionMetadata()
  if (!value || typeof value !== 'object') return fallback
  const row = value as Partial<SelectionMetadata>
  if (row.formatVersion !== 1 || !Array.isArray(row.gifts) || row.gifts.length > 10000) return fallback
  const gifts = row.gifts
    .filter(
      (gift) =>
        gift &&
        /^\d+$/.test(gift.id) &&
        typeof gift.name === 'string' &&
        typeof gift.image === 'string' &&
        Number.isFinite(gift.price),
    )
    .map((gift) => ({ id: gift.id, name: gift.name, image: gift.image, price: gift.price, blind: gift.blind === true }))
  let activities = fallback.activities
  try {
    activities = mergeActivityRules(activities, parseActivityRules(row.activities))
  } catch {
    /* Use bundled rules if cached rules are damaged. */
  }
  return {
    formatVersion: 1,
    gifts,
    activities,
    catalogUpdatedAt: typeof row.catalogUpdatedAt === 'string' ? row.catalogUpdatedAt : undefined,
    activitiesUpdatedAt: typeof row.activitiesUpdatedAt === 'string' ? row.activitiesUpdatedAt : undefined,
  }
}
export async function refreshSelectionMetadata(
  previous: SelectionMetadata,
  options: {
    signal?: AbortSignal
    catalogRequest?: (signal?: AbortSignal) => Promise<GiftInfo[]>
    activityRequest?: (signal?: AbortSignal) => Promise<SynthesisActivity[]>
  } = {},
): Promise<{ metadata: SelectionMetadata; warnings: string[] }> {
  const responses = await Promise.allSettled([
    (options.catalogRequest ?? loadGiftCatalog)(options.signal),
    (options.activityRequest ?? loadActivityRules)(options.signal),
  ])
  const metadata: SelectionMetadata = { ...previous }
  const warnings: string[] = []
  if (responses[0].status === 'fulfilled') {
    if (responses[0].value.length) {
      // Preserve removed gift metadata so historic options retain their icons.
      const gifts = new Map(previous.gifts.map((gift) => [gift.id, gift]))
      for (const gift of responses[0].value) gifts.set(gift.id, gift)
      metadata.gifts = [...gifts.values()]
      metadata.catalogUpdatedAt = new Date().toISOString()
    } else warnings.push('礼物目录为空，已保留已有选项')
  } else warnings.push('礼物目录刷新失败，已保留已有选项')
  if (responses[1].status === 'fulfilled') {
    if (responses[1].value.length) {
      metadata.activities = mergeActivityRules(previous.activities, responses[1].value)
      metadata.activitiesUpdatedAt = new Date().toISOString()
    } else warnings.push('活动配置为空，已保留已有规则')
  } else warnings.push('活动规则刷新失败，已保留本地规则')
  return { metadata, warnings }
}
