import type { DanmakuSession } from '../types/danmaku'

type CompactRecord = [number, number, number, number, number, Array<string | number | null>?]
type CompactSession = [
  [number, string, number],
  [
    string,
    string,
    string,
    number,
    number,
    boolean,
    boolean,
    boolean,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    string,
    string,
  ],
  [number, Array<[number, string]>, Array<[string]>, CompactRecord[]],
]

// Danmakus v3 full endpoint: channel/live tuples and delta-encoded timestamps.
export function decodeLiveSession(value: unknown): DanmakuSession {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Array.isArray)) {
    throw new Error('场次弹幕数据格式不兼容，请稍后重试')
  }
  const [channel, live, danmakus] = value as CompactSession
  if (!Array.isArray(danmakus[1]) || !Array.isArray(danmakus[2]) || !Array.isArray(danmakus[3])) {
    throw new Error('场次弹幕记录格式不兼容')
  }
  let timestamp = danmakus[0]
  return {
    channel: { uId: channel[0], uName: channel[1], roomId: channel[2], faceUrl: '', frameUrl: live[2], title: live[1] },
    live: {
      liveId: live[0],
      title: live[1],
      startDate: live[3],
      stopDate: live[4],
      isFinish: live[5],
      isFull: live[6],
      watchCount: live[11],
      likeCount: 0,
      interactionCount: live[10],
      area: live[15],
      parentArea: live[16],
    },
    danmakus: {
      actors: danmakus[1].map(([uid, name]) => ({ uid, name })),
      roomEmojis: danmakus[2].map(([resource]) => ({ name: resource, resource })),
      records: danmakus[3].map(([delta, type, actor, , kind, payload]) => {
        timestamp += delta
        const text = typeof payload?.[0] === 'string' ? payload[0] : ''
        return {
          ts: timestamp,
          type,
          actorId: actor - 1,
          payloadKind: kind,
          payload:
            kind === 2
              ? { roomEmojiId: Number(payload?.[0]) - 1 }
              : {
                  rawText:
                    kind === 6
                      ? `${text} → ${payload?.[1] || ''}`
                      : kind === 7
                        ? `${text} / ${payload?.[1] || ''} → ${payload?.[2] || ''} / ${payload?.[3] || ''}`
                        : kind === 3 || kind === 4
                          ? `${text} × ${payload?.[1] || 1}`
                          : text,
                },
        }
      }),
    },
  }
}
