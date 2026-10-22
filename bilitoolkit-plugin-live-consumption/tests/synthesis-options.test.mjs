import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
function moduleUrl(file) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}
const { buildSynthesisOptions, withinSynthesisWindow } = await import(moduleUrl('../src/services/synthesis-options.ts'))
const { synthesisActivities } = await import(moduleUrl('../src/data/synthesis-activities.ts'))
const record = (giftName, timestamp, extra = {}) => ({ giftName, timestamp, giftImg: '', isRefunded: false, ...extra })

test('activity selector ranks recent participation first, uses known configuration dates and leaves unknown dates last', () => {
  const activities = [
    { id: 'unknown', name: '日期未知活动', materials: ['未知材料'], products: ['未知产物'] },
    { id: 'older', name: '旧活动', materials: ['旧材料'], products: ['旧产物'] },
    { id: 'newer', name: '新活动', materials: ['新材料'], products: ['新产物'] },
    { id: 'configured', name: '有日期未参与', materials: ['未用材料'], products: [], endTime: 200 },
  ]
  const options = buildSynthesisOptions(
    activities,
    [record('旧材料', 100), record('新材料', 300), record('旧材料', 400, { isRefunded: true })],
    [],
  )
  assert.deepEqual(
    options.map((item) => item.id),
    ['newer', 'configured', 'older', 'unknown'],
  )
  assert.equal(options[0].dateSource, 'record')
  assert.equal(options[1].dateSource, 'configuration')
  assert.equal(options[3].dateSource, 'unknown')
})

test('activities sharing a material are disambiguated by their configured dates and product grace period', () => {
  const activity = { id: 'a', name: '卡牌', startTime: 1000, endTime: 2000, materials: ['翻牌'], products: ['产物'] }
  assert.equal(withinSynthesisWindow(record('翻牌', 999), activity), false)
  assert.equal(withinSynthesisWindow(record('翻牌', 2000), activity), true)
  assert.equal(withinSynthesisWindow(record('翻牌', 2001), activity), false)
  assert.equal(withinSynthesisWindow(record('产物', 2000 + 176400, { isBag: true }), activity), true)
  assert.equal(withinSynthesisWindow(record('产物', 2001 + 176400, { isBag: true }), activity), false)
  assert.equal(withinSynthesisWindow(record('产物', 2001, { isBag: false }), activity), false)
  const options = buildSynthesisOptions([activity], [record('翻牌', 999999)], [])
  assert.equal(options[0].latestRecordAt, undefined)
  assert.equal(options[0].sortTimestamp, activity.endTime)
})

test('activity presets include historical rules and prefer catalog product icons with ledger fallback', () => {
  assert.equal(new Set(synthesisActivities.map((item) => item.id)).size, synthesisActivities.length)
  assert.ok(synthesisActivities.length >= 10)
  for (const item of synthesisActivities) {
    assert.ok(item.name && item.materials.length && item.products.length)
    assert.ok(item.startTime === undefined || item.endTime === undefined || item.startTime <= item.endTime)
  }
  const activity = { id: 'a', name: '活动', materials: ['材料'], products: ['产物'] }
  const rows = [record('材料', 100, { giftImg: 'ledger.png' })]
  assert.equal(
    buildSynthesisOptions([activity], rows, [{ id: '1', name: '产物', image: 'catalog.png', price: 1 }])[0].image,
    'catalog.png',
  )
  assert.equal(buildSynthesisOptions([activity], rows, [])[0].image, 'ledger.png')
})
