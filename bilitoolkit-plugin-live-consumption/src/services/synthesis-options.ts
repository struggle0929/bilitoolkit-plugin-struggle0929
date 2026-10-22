import type { ConsumptionRecord } from '../types/consumption.js'
import type { GiftInfo } from './extended-query.js'

export interface SynthesisActivity {
  id: string
  name: string
  materials: string[]
  products: string[]
  startTime?: number
  endTime?: number
}
export interface SynthesisOption extends SynthesisActivity {
  image: string
  latestRecordAt?: number
  sortTimestamp?: number
  dateSource: 'record' | 'configuration' | 'unknown'
}

export function withinSynthesisWindow(record: ConsumptionRecord, activity: SynthesisActivity): boolean {
  if (activity.startTime !== undefined && record.timestamp < activity.startTime) return false
  const extension = record.isBag && activity.products.some((name) => record.giftName.includes(name)) ? 176400 : 0
  return activity.endTime === undefined || record.timestamp <= activity.endTime + extension
}

export function buildSynthesisOptions(
  activities: SynthesisActivity[],
  records: ConsumptionRecord[],
  catalog: GiftInfo[],
): SynthesisOption[] {
  return activities
    .map((activity) => {
      const names = [...activity.materials, ...activity.products]
      const matchesName = (name: string) => names.some((part) => name.includes(part))
      const matches = records.filter((record) => {
        if (record.isRefunded || !matchesName(record.giftName)) return false
        return withinSynthesisWindow(record, activity)
      })
      const latestRecordAt = matches.length ? Math.max(...matches.map((row) => row.timestamp)) : undefined
      const sortTimestamp = latestRecordAt ?? activity.endTime ?? activity.startTime
      const catalogGift = [...activity.products]
        .reverse()
        .map((name) => catalog.find((gift) => gift.name === name && gift.image))
        .find(Boolean)
      const image = catalogGift?.image || matches.find((record) => record.giftImg)?.giftImg || ''
      return {
        ...activity,
        image,
        latestRecordAt,
        sortTimestamp,
        dateSource:
          latestRecordAt !== undefined
            ? ('record' as const)
            : sortTimestamp !== undefined
              ? ('configuration' as const)
              : ('unknown' as const),
      }
    })
    .sort((a, b) => (b.sortTimestamp ?? 0) - (a.sortTimestamp ?? 0) || a.name.localeCompare(b.name, 'zh-CN'))
}
