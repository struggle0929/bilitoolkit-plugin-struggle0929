import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
function moduleUrl(file, replacements = {}) {
  let code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(from, to)
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}
const core = moduleUrl('../src/services/consumption-core.ts')
const lossless = moduleUrl('../src/services/lossless-json.ts')
const api = moduleUrl('../src/services/extended-query.ts', {
  './consumption-core.js': core,
  './lossless-json.js': lossless,
})
const presets = moduleUrl('../src/data/synthesis-activities.ts')
const {
  refreshSelectionMetadata,
  initialSelectionMetadata,
  loadActivityRules,
  restoreSelectionMetadata,
  parseActivityRules,
  ACTIVITY_CONFIG_URL,
} = await import(
  moduleUrl('../src/services/selection-metadata.ts', {
    '../data/synthesis-activities.js': presets,
    './extended-query.js': api,
  })
)
const activity = { id: 'new', name: '新活动', materials: ['新材料'], products: ['新产物'] }

test('a catalog refresh adds new blind boxes and activity rules while keeping historical entries', async () => {
  const previous = initialSelectionMetadata()
  previous.gifts = [{ id: '1', name: '旧盲盒', image: 'old.png', price: 1, blind: true }]
  const result = await refreshSelectionMetadata(previous, {
    catalogRequest: async () => [{ id: '2', name: '新盲盒', image: 'new.png', price: 2, blind: true }],
    activityRequest: async () => [activity],
  })
  assert.deepEqual(
    result.metadata.gifts.map((gift) => gift.id),
    ['1', '2'],
  )
  assert.ok(result.metadata.activities.some((rule) => rule.id === 'new'))
  assert.ok(result.metadata.activities.some((rule) => rule.id === '玲珑宝斋'))
  assert.ok(result.metadata.catalogUpdatedAt && result.metadata.activitiesUpdatedAt)
  assert.deepEqual(result.warnings, [])
  assert.equal(previous.gifts.length, 1)
})

test('failed metadata sources retain their previous successful timestamps and do not discard old options', async () => {
  const previous = {
    ...initialSelectionMetadata(),
    catalogUpdatedAt: '2026-10-01T00:00:00Z',
    activitiesUpdatedAt: '2026-10-01T00:00:00Z',
  }
  const result = await refreshSelectionMetadata(previous, {
    catalogRequest: async () => {
      throw new Error('网络失败')
    },
    activityRequest: async () => [],
  })
  assert.equal(result.metadata.catalogUpdatedAt, previous.catalogUpdatedAt)
  assert.equal(result.metadata.activitiesUpdatedAt, previous.activitiesUpdatedAt)
  assert.equal(result.metadata.activities, previous.activities)
  assert.equal(result.warnings.length, 2)
})

test('public activity refresh omits credentials and referrer and only keeps activity rule fields', async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, ACTIVITY_CONFIG_URL)
      assert.equal(new URL(url).search, '')
      assert.equal(options.credentials, 'omit')
      assert.equal(options.referrerPolicy, 'no-referrer')
      assert.equal(options.body, undefined)
      assert.equal(options.headers, undefined)
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: { synthesis_activities: [{ ...activity, cookie: 'must-not-retain', uid: 'must-not-retain' }] },
        }),
      }
    }
    const result = await loadActivityRules()
    assert.equal(result.length, 1)
    assert.ok(!JSON.stringify(result).includes('must-not-retain'))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('cache restoration rejects invalid dates and preserves local fallback without retaining unknown fields', () => {
  assert.throws(() => parseActivityRules([{ ...activity, start_time: 200, end_time: 100 }]), /日期/)
  const restored = restoreSelectionMetadata({ formatVersion: 1, gifts: [], activities: [activity], cookie: 'discard' })
  assert.ok(restored.activities.some((item) => item.id === 'new'))
  assert.ok(!JSON.stringify(restored).includes('discard'))
  assert.equal(restoreSelectionMetadata({ formatVersion: 99 }).gifts.length, 0)
})
