export interface ConsumptionRecord {
  id: string
  timestamp: number
  giftId: string
  giftName: string
  giftImg: string
  giftNum: number
  anchorId: string
  anchorName: string
  paidBattery: number
  refundBattery: number
  netBattery: number
  isBag: boolean
  isRefunded: boolean
  raw: Record<string, unknown>
}

export interface CollectionSnapshot {
  formatVersion: 1
  uid: string
  records: ConsumptionRecord[]
  updatedAt: string
  coverage: 'complete' | 'partial'
  pages: number
  nextId?: string
  warning?: string
}

export interface PayRecordPage {
  code: number
  message?: string
  msg?: string
  data?: {
    list: Record<string, unknown>[]
    params?: { next_id?: number | string; month?: string }
  }
}

export interface ConsumptionSummary {
  netBattery: number
  paidBattery: number
  refundBattery: number
  consumptionCount: number
  giftTypeCount: number
  anchorCount: number
  earliest: number | null
  latest: number | null
  months: { key: string; battery: number; count: number }[]
  anchors: { id: string; name: string; battery: number; count: number }[]
  gifts: { id: string; name: string; image: string; count: number; battery: number }[]
}
