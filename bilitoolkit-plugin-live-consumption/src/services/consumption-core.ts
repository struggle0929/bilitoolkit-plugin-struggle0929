import type { ConsumptionRecord, ConsumptionSummary } from '../types/consumption.js'

export function parseAmount(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const text = String(value).replace(/,/g, '').trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error('账单金额格式不受支持，已停止统计以避免错误金额')
  const amount = Number(text)
  if (!Number.isFinite(amount)) throw new Error('账单金额超出有效范围')
  return amount
}

export function normalizeRecord(raw: Record<string, unknown>): ConsumptionRecord {
  if (raw.id === undefined || raw.id === null || raw.id === '' || !Number.isFinite(Number(raw.timestamp))) {
    throw new Error('消费记录缺少有效的流水号或时间')
  }
  // pay_coin=0 is authoritative; a gift's face value must not become cash spending.
  const paidBattery = parseAmount(
    raw.pay_coin === undefined || raw.pay_coin === null || raw.pay_coin === '' ? raw.coin : raw.pay_coin,
  )
  const refundBattery = parseAmount(raw.refund_price)
  const isBag = raw.bag_desc === '包裹道具'
  const isRefunded = raw.status_msg === '已退回'
  return {
    id: String(raw.id),
    timestamp: Number(raw.timestamp),
    giftId: String(raw.gift_id ?? ''),
    giftName: String(raw.gift_name ?? '未知礼物'),
    giftImg: String(raw.gift_img ?? ''),
    giftNum: Math.max(0, Number(raw.gift_num ?? 1) || 0),
    anchorId: String(raw.ruid ?? ''),
    anchorName: String(raw.r_uname ?? '未知主播'),
    paidBattery,
    refundBattery,
    netBattery: isBag || isRefunded ? 0 : Math.max(0, paidBattery - refundBattery),
    isBag,
    isRefunded,
    raw,
  }
}

/** The fresh record wins, including corrected refunds; do not key on timestamp or name. */
export function mergeRecords(previous: ConsumptionRecord[], fresh: ConsumptionRecord[]): ConsumptionRecord[] {
  const byId = new Map(previous.map((record) => [record.id, record]))
  for (const record of fresh) byId.set(record.id, record)
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))
}

export function summarizeRecords(records: ConsumptionRecord[]): ConsumptionSummary {
  const paid = records.filter((record) => !record.isBag)
  const spending = paid.filter((record) => !record.isRefunded)
  const months = new Map<string, { key: string; battery: number; count: number }>()
  const anchors = new Map<string, { id: string; name: string; battery: number; count: number }>()
  const gifts = new Map<string, { id: string; name: string; image: string; count: number; battery: number }>()
  for (const record of spending) {
    const key = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date(record.timestamp * 1000))
    const month = months.get(key) ?? { key, battery: 0, count: 0 }
    month.battery += record.netBattery
    month.count++
    months.set(key, month)
    const anchorId = record.anchorId || 'unknown'
    const anchor = anchors.get(anchorId) ?? {
      id: anchorId,
      name: record.anchorName || '未知主播',
      battery: 0,
      count: 0,
    }
    anchor.battery += record.netBattery
    anchor.count++
    anchors.set(anchorId, anchor)
    const giftKey = `${record.giftId}_${record.giftName}`
    const gift = gifts.get(giftKey) ?? {
      id: record.giftId,
      name: record.giftName,
      image: record.giftImg,
      count: 0,
      battery: 0,
    }
    gift.count += record.giftNum
    gift.battery += record.netBattery
    gifts.set(giftKey, gift)
  }
  const round = (value: number) => Math.round(value * 10000) / 10000
  const timestamps = records.map((record) => record.timestamp).sort((a, b) => a - b)
  return {
    netBattery: round(spending.reduce((sum, record) => sum + record.netBattery, 0)),
    paidBattery: round(paid.reduce((sum, record) => sum + record.paidBattery, 0)),
    refundBattery: round(
      paid.reduce((sum, record) => sum + (record.isRefunded ? record.paidBattery : record.refundBattery), 0),
    ),
    consumptionCount: spending.length,
    giftTypeCount: gifts.size,
    anchorCount: anchors.size,
    earliest: timestamps[0] ?? null,
    latest: timestamps[timestamps.length - 1] ?? null,
    months: [...months.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((row) => ({ ...row, battery: round(row.battery) })),
    anchors: [...anchors.values()]
      .sort((a, b) => b.battery - a.battery)
      .map((row) => ({ ...row, battery: round(row.battery) })),
    gifts: [...gifts.values()]
      .sort((a, b) => b.battery - a.battery)
      .map((row) => ({ ...row, battery: round(row.battery) })),
  }
}

export function recordsToCsv(records: ConsumptionRecord[]): string {
  const cell = (value: unknown) => {
    const text = String(value ?? '')
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return `"${safe.replace(/"/g, '""')}"`
  }
  const rows: unknown[][] = [
    [
      '流水号',
      '时间（北京时间）',
      '主播UID',
      '主播',
      '礼物ID',
      '礼物',
      '数量',
      '支付电池',
      '退款电池',
      '净消费电池',
      '包裹道具',
      '已退回',
    ],
  ]
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' })
  for (const record of records)
    rows.push([
      record.id,
      date.format(new Date(record.timestamp * 1000)),
      record.anchorId,
      record.anchorName,
      record.giftId,
      record.giftName,
      record.giftNum,
      record.paidBattery,
      record.refundBattery,
      record.netBattery,
      record.isBag ? '是' : '否',
      record.isRefunded ? '是' : '否',
    ])
  return '\ufeff' + rows.map((row) => row.map(cell).join(',')).join('\r\n')
}
