import type { BlindRecord } from './extended-query.js'

export function summarizeBlindDistribution(records: BlindRecord[]) {
  const gifts = new Map<string, { id: string; name: string; image: string; count: number }>()
  let total = 0
  for (const record of records) {
    if (!Number.isFinite(record.giftNum) || record.giftNum <= 0) continue
    const key = record.giftId || record.giftName
    const gift = gifts.get(key) ?? { id: key, name: record.giftName, image: record.giftImg, count: 0 }
    gift.count += record.giftNum
    total += record.giftNum
    if (!gift.image && record.giftImg) gift.image = record.giftImg
    gifts.set(key, gift)
  }
  return {
    total,
    gifts: [...gifts.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
      .map((gift, index) => ({
        ...gift,
        percentage: total ? (gift.count / total) * 100 : 0,
        color: `hsl(${Math.round(index * 137.508 + 246) % 360} 62% 61%)`,
      })),
  }
}
