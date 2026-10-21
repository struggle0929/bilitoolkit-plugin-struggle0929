import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const code = ts.transpileModule(readFileSync(new URL('../src/services/blind-options.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { buildBlindOptions, reconcileBlindRecords } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)
const record = (giftId, giftNum, extra = {}) => ({
  giftId,
  giftNum,
  giftName: '盲盒',
  giftImg: '',
  paidBattery: 1,
  isBag: false,
  isRefunded: false,
  ...extra,
})

test('blind selection ranks paid box quantity instead of price or result-gift count, excluding bags and returned records', () => {
  const options = buildBlindOptions(
    [
      { id: '32251', name: '心动盲盒', image: 'heart.png', price: 150, blind: true },
      { id: '35206', name: '幸运盲盒', image: 'lucky.png', price: 10, blind: true },
    ],
    [
      record('32251', 2),
      record('35206', 3),
      record('35206', 4),
      record('32251', 100, { isBag: true }),
      record('32251', 200, { isRefunded: true }),
      record('32251', 300, { paidBattery: 0 }),
    ],
  )
  assert.deepEqual(
    options.slice(0, 2).map((item) => [item.id, item.investedCount]),
    [
      ['35206', 7],
      ['32251', 2],
    ],
  )
  assert.equal(options[0].image, 'lucky.png')
  assert.ok(options.some((item) => item.investedCount === 0))
})

test('catalog options, removed boxes in history and a manually entered ID coexist without duplicate IDs', () => {
  const options = buildBlindOptions(
    [
      { id: '888', name: '新活动', image: 'activity.png', price: 50, blind: true },
      { id: '999', name: '普通礼物', image: '', price: 1 },
    ],
    [record('777', 1, { giftName: '已下架盲盒', giftImg: 'historic.png' })],
    '123456789012345678',
  )
  assert.ok(options.some((item) => item.id === '888' && item.image === 'activity.png'))
  assert.ok(options.some((item) => item.id === '777' && item.image === 'historic.png'))
  assert.ok(options.some((item) => item.id === '123456789012345678'))
  assert.ok(!options.some((item) => item.id === '999'))
  assert.equal(new Set(options.map((item) => item.id)).size, options.length)
})

test('ledger totals and returned draws retain separate date ranges when older outcomes are unavailable', () => {
  const older = Date.parse('2025-11-02T21:28:58+08:00') / 1000
  const newer = Date.parse('2026-08-21T20:25:05+08:00') / 1000
  const result = reconcileBlindRecords(
    {
      boxId: '32251',
      records: [{ timestamp: newer, giftNum: 46 }],
    },
    [
      record('32251', 135, { timestamp: older }),
      record('32251', 46, { timestamp: newer }),
      record('35206', 160, { timestamp: older }),
      record('32251', 5, { timestamp: older, isRefunded: true }),
    ],
  )
  assert.equal(result.ledgerQuantity, 181)
  assert.equal(result.drawQuantity, 46)
  assert.equal(result.unreturnedQuantity, 135)
  assert.deepEqual(result.ledgerRange, { start: older, end: newer })
  assert.deepEqual(result.drawRange, { start: newer, end: newer })
  assert.equal(reconcileBlindRecords({ boxId: '32251', records: [] }, []).drawRange, null)
})
