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
const { loadBlindConfig, collectBlindRecords, loadBagInventory, loadRewardCatalog, requestLive, parseBlindTimestamp } =
  await import(
    moduleUrl('../src/services/extended-query.ts', { './consumption-core.js': core, './lossless-json.js': lossless })
  )
const config = { id: '32251', name: '心动盲盒', price: 150, gifts: [], priceKnown: true }
const row = (extra = {}) => ({
  gift_id: 123,
  gift_name: '奖品',
  gift_num: 1,
  timestamp: 1770000000,
  ruid: '12345678901234567',
  rname: '主播',
  ...extra,
})
const response = (list, params = { have_more: false }) => ({ code: 0, data: { list, params } })

test('real blind wall-clock times use Beijing timezone independently of the operating system timezone', () => {
  const expected = Date.parse('2026-10-20T01:23:45+08:00') / 1000
  assert.equal(parseBlindTimestamp('2026-10-20 01:23:45'), expected)
  assert.equal(parseBlindTimestamp('2026-10-20T01:23:45+08:00'), expected)
  assert.equal(parseBlindTimestamp(expected), expected)
  assert.equal(parseBlindTimestamp(expected * 1000), expected)
  assert.throws(() => parseBlindTimestamp(undefined), /有效时间/)
})

test('blind configuration converts gold units to batteries without rounding away fractions', async () => {
  const result = await loadBlindConfig('32251', undefined, async (url) => {
    assert.equal(new URL(url).searchParams.get('gift_id'), '32251')
    return {
      code: 0,
      data: {
        blind_price: 15000,
        blind_gift_name: '心动盲盒',
        gifts: [{ gift_id: '98765432198765432', price: 125, gift_name: '奖品', is_win_gift: 1, chance: '0.1' }],
      },
    }
  })
  assert.equal(result.price, 150)
  assert.equal(result.gifts[0].price, 1.25)
  assert.equal(result.gifts[0].id, '98765432198765432')
  assert.equal(result.gifts[0].isWin, true)
})

test('blind pagination preserves exact cursor, and does not collapse legitimate same-second identical draws', async () => {
  let calls = 0
  const result = await collectBlindRecords({
    uid: '123',
    boxId: config.id,
    config,
    delayMs: 0,
    request: async (url) => {
      calls++
      const query = new URL(url).searchParams
      if (calls === 1) return response([row(), row()], { have_more: true, last_id: '1973811870218154002' })
      assert.equal(query.get('last_id'), '1973811870218154002')
      assert.equal(query.get('have_more'), null)
      return response([row({ timestamp: 1760000000 })])
    },
  })
  assert.equal(result.coverage, 'complete')
  assert.equal(result.records.length, 3)
  assert.equal(new Set(result.records.map((item) => item.id)).size, 3)
  assert.equal(result.records[0].anchorId, '12345678901234567')
})

test('blind errors after a successful page, repeated pages, absent pagination, and limits remain partial', async () => {
  const base = { uid: '123', boxId: config.id, config, delayMs: 0 }
  let calls = 0
  const failed = await collectBlindRecords({
    ...base,
    request: async () => {
      if (++calls === 1) return response([row()], { have_more: true, last_id: '1' })
      throw new Error('网络失败')
    },
  })
  assert.equal(failed.coverage, 'partial')
  assert.equal(failed.records.length, 1)
  assert.match(failed.warning, /网络失败/)
  const repeated = await collectBlindRecords({
    ...base,
    request: async () => response([row()], { have_more: true, last_id: '1' }),
  })
  assert.equal(repeated.coverage, 'partial')
  assert.equal(repeated.records.length, 1)
  const absent = await collectBlindRecords({ ...base, request: async () => response([row()], {}) })
  assert.equal(absent.coverage, 'partial')
  const limited = await collectBlindRecords({
    ...base,
    maxPages: 1,
    request: async () => response([row()], { have_more: true, last_id: '1' }),
  })
  assert.match(limited.warning, /上限/)
})

test('historical box query works with unknown prices and login failure never replaces cache with empty success', async () => {
  const result = await collectBlindRecords({
    uid: '123',
    boxId: config.id,
    config: { ...config, price: 0, priceKnown: false },
    request: async () => response([row()]),
  })
  assert.equal(result.records.length, 1)
  assert.equal(result.config.priceKnown, false)
  await assert.rejects(
    collectBlindRecords({
      uid: '123',
      boxId: config.id,
      config,
      request: async () => ({ code: -101, message: '未登录' }),
    }),
    /登录/,
  )
  await assert.rejects(collectBlindRecords({ uid: '123', boxId: '999', config }), /不一致/)
})

test('bag inventory keeps free gifts separate from spending and preserves lock restrictions', async () => {
  const result = await loadBagInventory(undefined, async () => ({
    code: 0,
    data: {
      list: [
        {
          gift_id: '99',
          gift_name: '奖品',
          gift_num: 3,
          is_locked: 1,
          locked_text: '限某主播使用',
          expire_at: 1800000000,
        },
      ],
      gift_config: [{ id: '99', price: 1200, img_basic: 'https://example.test/gift.png' }],
    },
  }))
  assert.equal(result[0].price, 12)
  assert.equal(result[0].count, 3)
  assert.equal(result[0].locked, true)
  assert.equal(result[0].lockedText, '限某主播使用')
  assert.equal(result[0].expireAt, 1800000000)
})

test('reward catalog distinguishes partial configuration from an empty successful list', async () => {
  const result = await loadRewardCatalog(undefined, async (url) =>
    url.includes('GiftPanel')
      ? { code: 0, data: { list: [{ id: '1' }, { id: '1' }] } }
      : { code: 123, message: '红包不可用' },
  )
  assert.deepEqual(result.guardIds, ['1'])
  assert.deepEqual(result.redPacketIds, [])
  assert.deepEqual(result.warnings, ['红包不可用'])
})

test('credentialed transport refuses third-party and non-HTTPS endpoints before fetching', async () => {
  await assert.rejects(requestLive('https://example.com'), /仅允许/)
  await assert.rejects(requestLive('http://api.live.bilibili.com'), /仅允许/)
})
