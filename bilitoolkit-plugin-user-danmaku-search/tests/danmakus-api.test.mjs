import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { encode } from '@msgpack/msgpack'

function compileSource(file, imports = {}) {
  let code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const [from, to] of Object.entries(imports)) code = code.replace(from, to)
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

const decoderUrl = compileSource('../src/services/live-decoder.ts')
const { decodeLiveSession } = await import(decoderUrl)
const api = await import(
  compileSource('../src/services/danmakus-api.ts', {
    './live-decoder': decoderUrl,
    '@msgpack/msgpack': import.meta.resolve('@msgpack/msgpack'),
  })
)
const full = [
  [123, '主播', 456],
  ['live-id', '直播标题', 'cover.png', 1000, 5000, true, false, false, 4, 4, 2, 50, 0, 0, 0, '日常', '虚拟主播'],
  [
    1000,
    [[7, '用户']],
    [['/emoji.png']],
    [
      [0, 0, 1, 0, 1, ['第一条']],
      [200, 0, 1, 0, 2, [1]],
      [500, 1, 1, 0, 3, ['礼物', 2, 1000]],
      [100, 5, 0, 0, 6, ['原标题', '新标题']],
    ],
  ],
]

test('decodes full room records: timestamp deltas, actor/emoji indices and system events', () => {
  const session = decodeLiveSession(full)
  assert.equal(session.channel.roomId, 456)
  assert.equal(session.live.isFull, false)
  assert.deepEqual(
    session.danmakus.records.map((record) => record.ts),
    [1000, 1200, 1700, 1800],
  )
  assert.equal(session.danmakus.records[0].actorId, 0)
  assert.equal(session.danmakus.records[1].payload.roomEmojiId, 0)
  assert.equal(session.danmakus.roomEmojis[0].resource, '/emoji.png')
  assert.equal(session.danmakus.records[2].payload.rawText, '礼物 × 2')
  assert.equal(session.danmakus.records[3].actorId, -1)
  assert.equal(session.danmakus.records[3].payload.rawText, '原标题 → 新标题')
})

test('rejects incompatible room response instead of presenting empty success', () => {
  assert.throws(() => decodeLiveSession({ code: 200 }), /格式不兼容/)
  assert.throws(() => decodeLiveSession([[], [], []]), /格式不兼容/)
})

test('room flow resolves room owner and retrieves all actors; user flow retains UID/filter pagination', async (context) => {
  const requests = []
  const controller = new AbortController()
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    if (url.includes('/full?'))
      return new Response(encode(full), { headers: { 'Content-Type': 'application/x-msgpack' } })
    const response = url.includes('get_info')
      ? { code: 0, data: { uid: 123, room_id: 456, short_id: 6 } }
      : {
          code: 200,
          data: url.includes('/channel?')
            ? { channel: { uId: 123 }, lives: [{ liveId: 'live-id' }] }
            : { total: 0, items: [] },
        }
    return Response.json(response)
  })
  const room = await api.resolveRoomOwner('6', controller.signal)
  const channel = await api.fetchRoomChannel(String(room.uid), controller.signal)
  const session = await api.fetchLiveSession(channel.lives[0].liveId, controller.signal)
  assert.equal(session.danmakus.actors[0].uid, 7)
  assert.equal(session.danmakus.records.length, 4)
  await api.fetchBootstrap('7', 10, controller.signal)
  await api.fetchHistory('7', 2, 10, '123', controller.signal)
  assert.match(requests[0].url, /room_id=6$/)
  assert.match(requests[1].url, /api\/v2\/channel\?uId=123$/)
  assert.match(requests[2].url, /api\/v3\/lives\/live-id\/full\?includeEnter=false$/)
  assert.match(requests[3].url, /users\/7\/bootstrap/)
  assert.match(requests[4].url, /users\/7\/history\?page=2&pageSize=10&channelUserId=123$/)
  assert.ok(requests.every((request) => request.options.signal === controller.signal))
})

test('propagates API errors and cancellation', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }))
  await assert.rejects(api.fetchLiveSession('live-id'), /503/)
  context.mock.method(globalThis, 'fetch', async () => Response.json({ code: 404, message: '未收录' }))
  await assert.rejects(api.fetchRoomChannel('123'), /未收录/)
  context.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('Aborted', 'AbortError')
  })
  await assert.rejects(api.fetchLiveSession('live-id'), { name: 'AbortError' })
})
