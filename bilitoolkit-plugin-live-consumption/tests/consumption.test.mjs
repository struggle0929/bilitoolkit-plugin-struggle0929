import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function moduleUrl(file, replacements = {}) {
  let code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(from, to)
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}
const md5Url = moduleUrl('../src/services/md5.ts')
const coreUrl = moduleUrl('../src/services/consumption-core.ts')
const losslessUrl = moduleUrl('../src/services/lossless-json.ts')
const { parseLosslessJson } = await import(losslessUrl)
const { md5 } = await import(md5Url)
const { normalizeRecord, mergeRecords, summarizeRecords, recordsToCsv } = await import(coreUrl)
const { buildPayRecordUrl, collectConsumption } = await import(
  moduleUrl('../src/services/consumption-api.ts', {
    './md5.js': md5Url,
    './consumption-core.js': coreUrl,
    './lossless-json.js': losslessUrl,
  })
)
const row = (id, extra = {}) => ({
  id,
  timestamp: 1767225600 + Number(id),
  gift_id: 10,
  gift_name: '礼物',
  gift_num: 1,
  ruid: 123,
  r_uname: '主播',
  coin: '10',
  pay_coin: '10',
  ...extra,
})
const page = (list, next_id = 0) => ({ code: 0, data: { list, params: { next_id } } })
const snapshot = (records) => ({
  uid: '123',
  records: records.map(normalizeRecord),
  pages: 1,
  updatedAt: '2026-01-01T00:00:00Z',
  coverage: 'complete',
})

test('MD5 agrees with independent crypto implementation for RFC vectors, Unicode and multiple blocks', () => {
  for (const input of ['', 'a', 'abc', 'message digest', '直播消费😀', 'x'.repeat(10000)]) {
    assert.equal(md5(input), createHash('md5').update(input).digest('hex'))
  }
})

test('JSON keeps exact 64-bit IDs and cursors without altering decimal amounts or quoted text', () => {
  const result = parseLosslessJson(
    '{"id":1973811870218154001,"next_id":1973811870218154002,"amount":1.25,"text":"1973811870218154001 \\\" hello","count":50}',
  )
  assert.equal(result.id, '1973811870218154001')
  assert.equal(result.next_id, '1973811870218154002')
  assert.equal(result.amount, 1.25)
  assert.equal(result.count, 50)
  assert.equal(result.text, '1973811870218154001 " hello')
  assert.throws(() => parseLosslessJson('{broken'))
})

test('first account selection initializes a missing cache rather than reading an absent document', async () => {
  const component = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  const script = component.slice(component.indexOf('>') + 1, component.indexOf('</script>'))
  const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'selectAccount')
  assert.ok(fn)
  const code = ts.transpileModule(fn.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const module = `
    const calls=[];
    const switching={value:false},error={value:''},notice={value:''},account={value:null},snapshot={value:null},page={value:1};
    const cancel=()=>{},dbKey=uid=>'live-consumption-'+uid;
    const window={toolkitApi:{user:{switchUser:async()=>({mid:123,name:'测试用户',face:''})},db:{
      read:async()=>{throw Error('文档不存在')},
      init:async key=>{calls.push(key);return null}
    }}};
    const fetch=async()=>({ok:true,json:async()=>({code:0,data:{mid:123,isLogin:true}})});
    ${code}
    export {selectAccount,calls,account,error,snapshot};`
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`)
  await loaded.selectAccount()
  assert.equal(loaded.error.value, '')
  assert.equal(loaded.account.value.uid, '123')
  assert.deepEqual(loaded.calls, ['live-consumption-123'])
  assert.equal(loaded.snapshot.value, null)
})

test('Android query signs sorted URI-encoded parameters and preserves string cursor', () => {
  const url = new URL(buildPayRecordUrl('987654321012345678', 1700000000000))
  assert.equal(url.pathname, '/xlive/revenue/v2/giftStream/payRecord')
  assert.equal(url.searchParams.get('next_id'), '987654321012345678')
  assert.equal(url.searchParams.get('ts'), '1700000000')
  const entries = [...url.searchParams].filter(([key]) => key !== 'sign').sort(([a], [b]) => a.localeCompare(b))
  const canonical = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
  assert.equal(
    url.searchParams.get('sign'),
    createHash('md5')
      .update(canonical + '560c52ccd288fed045859ed18bffd973')
      .digest('hex'),
  )
  assert.equal(url.searchParams.get('coin_type'), 'gold')
  assert.equal(url.searchParams.has('SESSDATA'), false)
})

test('zero payment, bag gifts and refunds are never counted as their face value', () => {
  assert.equal(normalizeRecord(row(1, { pay_coin: '0', coin: '100' })).netBattery, 0)
  assert.equal(normalizeRecord(row(2, { bag_desc: '包裹道具', coin: '100', pay_coin: '100' })).netBattery, 0)
  assert.equal(normalizeRecord(row(3, { pay_coin: '10.5', refund_price: '2.5' })).netBattery, 8)
  assert.equal(normalizeRecord(row(4, { status_msg: '已退回' })).netBattery, 0)
  assert.equal(normalizeRecord(row(5, { pay_coin: '1,234.5' })).paidBattery, 1234.5)
  assert.throws(() => normalizeRecord(row(6, { pay_coin: '未知' })), /格式/)
})

test('summary separates paid amount, refunds, bag gifts and net spending in Shanghai months', () => {
  const records = [
    row(1, { pay_coin: '10.1' }),
    row(2, { pay_coin: '20', refund_price: '3' }),
    row(3, { bag_desc: '包裹道具', pay_coin: '100' }),
    row(4, { status_msg: '已退回', pay_coin: '8' }),
  ].map(normalizeRecord)
  const summary = summarizeRecords(records)
  assert.equal(summary.netBattery, 27.1)
  assert.equal(summary.paidBattery, 38.1)
  assert.equal(summary.refundBattery, 11)
  assert.equal(summary.consumptionCount, 2)
  assert.equal(summary.anchorCount, 1)
  assert.equal(summary.giftTypeCount, 1)
  assert.equal(summary.months[0].key, '2026-01')
  assert.equal(summary.anchors[0].battery, 27.1)
})

test('fresh corrections replace old record by ID without duplicating transactions', () => {
  const merged = mergeRecords(
    [normalizeRecord(row(1))],
    [normalizeRecord(row(1, { refund_price: '5' })), normalizeRecord(row(2))],
  )
  assert.equal(merged.length, 2)
  assert.equal(merged.find((r) => r.id === '1').netBattery, 5)
})

test('CSV quotes fields and neutralizes spreadsheet formulas', () => {
  const csv = recordsToCsv([normalizeRecord(row(1, { gift_name: '=HYPERLINK("bad")', r_uname: '主播,名称' }))])
  assert.ok(csv.startsWith('\ufeff'))
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'))
  assert.ok(csv.includes('"主播,名称"'))
})

test('short pages still follow next_id; page overlaps are deduplicated', async () => {
  const urls = []
  const result = await collectConsumption({
    uid: '123',
    mode: 'full',
    delayMs: 0,
    request: async (url) => {
      urls.push(url)
      return urls.length === 1 ? page([row(3), row(2)], '2') : page([row(2), row(1)])
    },
  })
  assert.equal(result.coverage, 'complete')
  assert.equal(result.records.length, 3)
  assert.equal(result.pages, 2)
  assert.equal(new URL(urls[1]).searchParams.get('next_id'), '2')
})

test('cursor cycles and page limits remain explicitly partial', async () => {
  let count = 0
  const loop = await collectConsumption({
    uid: '123',
    mode: 'full',
    delayMs: 0,
    request: async () => page([row(++count)], count === 1 ? '1' : count === 2 ? '2' : '1'),
  })
  assert.equal(loop.coverage, 'partial')
  assert.match(loop.warning, /游标重复/)
  const limited = await collectConsumption({
    uid: '123',
    mode: 'full',
    maxPages: 1,
    delayMs: 0,
    request: async () => page([row(1)], '1'),
  })
  assert.equal(limited.coverage, 'partial')
  assert.match(limited.warning, /查询上限/)
})

test('inclusive end cursor with only already-seen rows is an exhausted interface, not a loop error', async () => {
  const result = await collectConsumption({
    uid: '123',
    mode: 'full',
    delayMs: 0,
    request: async () => page([row(1)], '1'),
  })
  assert.equal(result.coverage, 'complete')
  assert.equal(result.records.length, 1)
  assert.equal(result.pages, 2)
})

test('invalid credentials are reported instead of returning an empty successful bill', async () => {
  await assert.rejects(
    collectConsumption({ uid: '123', mode: 'full', request: async () => ({ code: -101 }) }),
    /重新登录/,
  )
  await assert.rejects(
    collectConsumption({ uid: '456', existing: snapshot([row(1)]), mode: 'incremental' }),
    /账号不一致/,
  )
})

test('interrupted collection keeps already read records and reports partial coverage', async () => {
  const controller = new AbortController()
  const result = await collectConsumption({
    uid: '123',
    mode: 'full',
    signal: controller.signal,
    delayMs: 0,
    request: async () => page([row(1)], '1'),
    onProgress: () => controller.abort(),
  })
  assert.equal(result.coverage, 'partial')
  assert.equal(result.records.length, 1)
  assert.match(result.warning, /已停止/)
})

test('incremental lookback refreshes refunds while retaining old history', async () => {
  const existing = snapshot([row(1, { timestamp: 1000000 }), row(2, { timestamp: 2000000 })])
  const result = await collectConsumption({
    uid: '123',
    existing,
    mode: 'incremental',
    delayMs: 0,
    request: async () =>
      page([row(2, { timestamp: 2000000, refund_price: '5' }), row(1, { timestamp: 1000000 })], 'older'),
  })
  assert.equal(result.coverage, 'complete')
  assert.equal(result.records.length, 2)
  assert.equal(result.records.find((r) => r.id === '2').netBattery, 5)
})
