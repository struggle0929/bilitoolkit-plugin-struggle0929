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
const lossless = moduleUrl('../src/services/lossless-json.ts')
const core = moduleUrl('../src/services/consumption-core.ts')
const extended = moduleUrl('../src/services/extended-query.ts', {
  './consumption-core.js': core,
  './lossless-json.js': lossless,
})
const { collectReceived, collectLiveSessions, collectLiveGifts, loadLiveBase } = await import(
  moduleUrl('../src/services/anchor-query.ts', { './lossless-json.js': lossless, './extended-query.js': extended })
)
const ok = (data) => ({ code: 0, data })
const base = { uid: '123', startDate: '2026-10-01', endDate: '2026-10-20', csrf: 'test-token-not-real', delayMs: 0 }

test('received gift history starts at page zero, formats dates and never persists its CSRF credential', async () => {
  let calls = 0
  const result = await collectReceived({
    ...base,
    request: async (form) => {
      assert.equal(form.get('page'), String(calls++))
      assert.equal(form.get('begin_date'), '20261001')
      assert.equal(form.get('csrf'), base.csrf)
      return ok({ ready: 1, total_page: 2, list: [{ id: String(calls), uid: '123456789012345678', num: 1 }] })
    },
  })
  assert.equal(result.pages, 2)
  assert.equal(result.records.length, 2)
  assert.equal(result.coverage, 'complete')
  assert.ok(!JSON.stringify(result).includes(base.csrf))
})
test('not-ready income is retried and never reported as confirmed empty history', async () => {
  let calls = 0
  const result = await collectReceived({
    ...base,
    request: async () =>
      ++calls < 3 ? ok({ ready: 0, total_page: 0, list: [] }) : ok({ ready: 1, total_page: 1, list: [{ id: '1' }] }),
  })
  assert.equal(calls, 3)
  assert.equal(result.records.length, 1)
  await assert.rejects(
    collectReceived({ ...base, request: async () => ok({ ready: 0, total_page: 0, list: [] }) }),
    /尚未就绪/,
  )
})
test('income invalid dates, expired session and early transport failure do not produce successful empty snapshots', async () => {
  await assert.rejects(collectReceived({ ...base, endDate: '2026-12-20' }), /31 天/)
  await assert.rejects(collectReceived({ ...base, request: async () => ({ code: -101, message: '未登录' }) }), /未登录/)
  let calls = 0
  const result = await collectReceived({
    ...base,
    request: async () => {
      if (++calls === 1) return ok({ ready: 1, total_page: 3, list: [{ id: '1' }] })
      throw new Error('网络失败')
    },
  })
  assert.equal(result.coverage, 'partial')
  assert.equal(result.records.length, 1)
})
test('own-anchor session queries keep seven-day boundary and follow string cursors', async () => {
  const now = 1800000000000,
    seconds = now / 1000
  let calls = 0
  const result = await collectLiveSessions({
    uid: '123',
    now,
    delayMs: 0,
    request: async (url) => {
      if (++calls === 1)
        return ok({
          list: [{ live_id: '1973811870218154002', start_time: seconds - 60 }],
          next_start_time: '17999999999999999',
        })
      assert.equal(new URL(url).searchParams.get('end_time'), '17999999999999999')
      return ok({ list: [{ live_id: 'older', start_time: seconds - 8 * 86400 }], last: false })
    },
  })
  assert.equal(result.coverage, 'complete')
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].live_id, '1973811870218154002')
})
test('session gifts follow index/date pairs and stop only on the declared end marker', async () => {
  let calls = 0
  const result = await collectLiveGifts({
    uid: '123',
    liveId: 'abc',
    startTime: 100,
    endTime: 200,
    delayMs: 0,
    request: async (url) => {
      const query = new URL(url).searchParams
      assert.equal(query.get('live_key'), 'abc')
      if (++calls === 1) return ok({ gift_income_details: [{ gift_value: 1000 }], next_index: 5, log_date: '20261020' })
      assert.equal(query.get('index'), '5')
      assert.equal(query.get('log_date'), '20261020')
      return ok({ gift_income_details: [], next_index: -1, log_date: '' })
    },
  })
  assert.equal(result.coverage, 'complete')
  assert.equal(result.records.length, 1)
})
test('playback signed URLs and tokens are stripped from the metadata exported to the UI', async () => {
  const result = await loadLiveBase({
    liveId: 'abc',
    startTime: 100,
    endTime: 200,
    request: async () =>
      ok({
        list: [
          {
            start_time: 100,
            end_time: 200,
            stream: 'sensitive-playback-url',
            stream_url: 'also-sensitive',
            token: 'secret',
            duration: 100,
          },
        ],
      }),
  })
  assert.deepEqual(result, { list: [{ start_time: 100, end_time: 200, duration: 100 }] })
})
