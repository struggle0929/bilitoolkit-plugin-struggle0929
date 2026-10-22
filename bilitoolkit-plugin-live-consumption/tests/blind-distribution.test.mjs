import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const code = ts.transpileModule(
  readFileSync(new URL('../src/services/blind-distribution.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText
const { summarizeBlindDistribution } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)
const gift = (id, name, count) => ({ giftId: id, giftName: name, giftNum: count, giftImg: '' })
test('one marshmallow and one pillow display equal 50 percent shares', () => {
  const summary = summarizeBlindDistribution([gift('1', '棉花糖', 1), gift('2', '爱心抱枕', 1)])
  assert.equal(summary.total, 2)
  assert.deepEqual(
    summary.gifts.map((row) => row.percentage),
    [50, 50],
  )
  assert.ok(summary.gifts[0].color !== summary.gifts[1].color)
})
test('distribution groups by gift and uses quantity rather than transaction count or price, keeping unknown-price gifts', () => {
  const summary = summarizeBlindDistribution([gift('1', '棉花糖', 2), gift('1', '棉花糖', 1), gift('2', '爱心抱枕', 1)])
  assert.deepEqual(
    summary.gifts.map((row) => [row.name, row.count, row.percentage]),
    [
      ['棉花糖', 3, 75],
      ['爱心抱枕', 1, 25],
    ],
  )
  assert.deepEqual(summarizeBlindDistribution([]), { total: 0, gifts: [] })
})
