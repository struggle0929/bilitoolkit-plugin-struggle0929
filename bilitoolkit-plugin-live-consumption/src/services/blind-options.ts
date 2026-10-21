import type { ConsumptionRecord } from '../types/consumption.js'
import type { GiftInfo } from './extended-query.js'

export interface BlindOption {
  id: string
  name: string
  image: string
  investedCount: number
}
// Historic candidates stay available when removed from the current gift catalog.
const historicBoxes: Omit<BlindOption, 'investedCount'>[] = [
  {
    id: '32251',
    name: '心动盲盒',
    image: 'https://s1.hdslb.com/bfs/live/38f645d811537b50873718cecbfd84cd28af50ed.png',
  },
  {
    id: '35206',
    name: '幸运盲盒',
    image: 'https://s1.hdslb.com/bfs/live/d9bf4b2234e854b0badbd509edf59b5bf0361b7f.png',
  },
  {
    id: '35684',
    name: '活动盲盒（历史选项）',
    image: 'https://s1.hdslb.com/bfs/live/48307f9c584235ade71c59de9c93eaa607b03388.png',
  },
]

export function buildBlindOptions(catalog: GiftInfo[], records: ConsumptionRecord[], selectedId = ''): BlindOption[] {
  const options = new Map<string, BlindOption>()
  for (const box of historicBoxes) options.set(box.id, { ...box, investedCount: 0 })
  for (const gift of catalog) {
    if (!gift.blind && !/盲盒/.test(gift.name) && !options.has(gift.id)) continue
    const previous = options.get(gift.id)
    options.set(gift.id, {
      id: gift.id,
      name: gift.name || previous?.name || `盲盒 ${gift.id}`,
      image: gift.image || previous?.image || '',
      investedCount: 0,
    })
  }
  // Recover removed boxes and their icons from the user's already fetched ledger.
  for (const record of records) {
    if (!/盲盒/.test(record.giftName) && !options.has(record.giftId)) continue
    const previous = options.get(record.giftId)
    options.set(record.giftId, {
      id: record.giftId,
      name: previous?.name || record.giftName,
      image: previous?.image || record.giftImg,
      investedCount: 0,
    })
  }
  for (const record of records) {
    const box = options.get(record.giftId)
    if (box && !record.isBag && !record.isRefunded && record.paidBattery > 0) box.investedCount += record.giftNum
  }
  if (/^\d+$/.test(selectedId) && !options.has(selectedId))
    options.set(selectedId, { id: selectedId, name: `盲盒 ${selectedId}`, image: '', investedCount: 0 })
  return [...options.values()].sort(
    (a, b) => b.investedCount - a.investedCount || a.id.localeCompare(b.id, 'en', { numeric: true }),
  )
}
