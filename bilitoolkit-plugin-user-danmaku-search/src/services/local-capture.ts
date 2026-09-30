import { ref } from 'vue'
import { publicClient } from 'bilitoolkit-runtime/biliapi'
import { BiliLiveMessageClient, UniversalCompression } from 'bili-live-message-core'
import type { DanmakuMessage, MessageMap, MessageType } from 'bili-live-message-core'
import type {
  BiliLiveRoomInfo,
  LocalCaptureSession,
  LocalCaptureStatus,
  LocalCaptureTargetType,
  LocalDanmakuRecord,
} from '@/types/danmaku'
import { resolveRoomOwner } from '@/services/danmakus-api'

const INDEX_KEY = 'local-danmaku-capture-index'
const CAPTURE_DIR = 'captures'
const MAX_RECENT_RECORDS = 300
const FLUSH_BATCH_SIZE = 50

export type CaptureConnectionState =
  | 'idle'
  | 'resolving'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stopping'
  | 'error'

export const captureState = ref<CaptureConnectionState>('idle')
export const activeSession = ref<LocalCaptureSession | null>(null)
export const recentRecords = ref<LocalDanmakuRecord[]>([])
export const popularity = ref(0)
export const captureError = ref('')
export const captureSessions = ref<LocalCaptureSession[]>([])
export const captureRootDir = ref('')

let initialized = false
let liveMessageClient: BiliLiveMessageClient | null = null
let fileHandle: Awaited<ReturnType<typeof window.toolkitApi.file.open>> | null = null
let activeFilterUid: number | undefined
const pendingLines: string[] = []
let writeChain = Promise.resolve()
let persistTimer: ReturnType<typeof setTimeout> | null = null

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function normalizeId(value: string) {
  return value.replace(/\D/g, '').replace(/^0+/, '')
}

function sessionStatus(status: LocalCaptureStatus): LocalCaptureStatus {
  return status
}

async function persistIndex() {
  await window.toolkitApi.db.write(INDEX_KEY, { sessions: captureSessions.value })
}

function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistIndex()
  }, 1000)
}

async function initializeCaptureStore() {
  if (initialized) return
  initialized = true
  captureRootDir.value = await window.toolkitApi.file.getRootDir()
  const stored = await window.toolkitApi.db.init<{ sessions: LocalCaptureSession[] }>(INDEX_KEY, { sessions: [] })
  captureSessions.value = (stored.sessions || []).map((session) =>
    session.status === 'recording'
      ? { ...session, status: sessionStatus('interrupted'), endedAt: Date.now() }
      : session,
  )
  if (captureSessions.value.some((session) => session.status === 'interrupted')) await persistIndex()
}

async function resolveTarget(targetType: LocalCaptureTargetType, targetValue: string, filterUid?: number) {
  const numericValue = Number(normalizeId(targetValue))
  if (!Number.isSafeInteger(numericValue) || numericValue <= 0) {
    throw new Error(targetType === 'uid' ? '请输入有效的主播 UID' : '请输入有效的直播间号')
  }
  if (targetType === 'user' && (!filterUid || !Number.isSafeInteger(filterUid) || filterUid <= 0)) {
    throw new Error('请输入有效的指定用户 UID')
  }

  let room: BiliLiveRoomInfo
  let anchorUid = numericValue
  let roomTitle = ''
  let cover = ''
  let area = ''
  let parentArea = ''

  if (targetType === 'uid') {
    const roomInfo = await publicClient.live.getRoomInfo(numericValue)
    if (!roomInfo.roomid) throw new Error('该 UID 没有可用的直播间')
    room = {
      uid: numericValue,
      room_id: roomInfo.roomid,
      short_id: roomInfo.roomid,
      title: roomInfo.title,
      user_cover: roomInfo.cover,
    }
    roomTitle = roomInfo.title || ''
    cover = roomInfo.cover || ''
  } else {
    room = await resolveRoomOwner(String(numericValue))
    anchorUid = room.uid
    roomTitle = room.title || ''
    cover = room.user_cover || room.keyframe || ''
    area = room.area_name || ''
    parentArea = room.parent_area_name || ''
  }

  const [userCard, liveInfo, filterCard] = await Promise.all([
    publicClient.user.getUserCard({ mid: anchorUid }),
    publicClient.live.getRoomInfo(anchorUid).catch(() => undefined),
    filterUid ? publicClient.user.getUserCard({ mid: filterUid }).catch(() => undefined) : undefined,
  ])
  const card = userCard.card
  roomTitle = roomTitle || liveInfo?.title || ''
  cover = cover || liveInfo?.cover || ''
  return {
    roomId: room.room_id,
    anchorUid,
    anchorName: card.name || `UID ${anchorUid}`,
    anchorFace: card.face || '',
    title: roomTitle || '未命名直播',
    cover,
    area,
    parentArea,
    filterUid,
    filterUserName: filterCard?.card.name,
  }
}

async function flushPending() {
  if (!fileHandle || pendingLines.length === 0) return writeChain
  const lines = pendingLines.splice(0, pendingLines.length)
  const bytes = new TextEncoder().encode(lines.join(''))
  writeChain = writeChain.then(async () => {
    if (!fileHandle) return
    await fileHandle.write(bytes)
    await fileHandle.flush()
  })
  return writeChain
}

function queueRecord(record: LocalDanmakuRecord) {
  pendingLines.push(`${JSON.stringify(record)}\n`)
  if (pendingLines.length >= FLUSH_BATCH_SIZE) void flushPending()
}

function handleDanmakuMessage(message: DanmakuMessage) {
  const info = message.info
  const content = String(info[1] || '').trim()
  const sender = info[2]
  if (!content || !sender?.[0]) return
  if (activeFilterUid !== undefined && Number(sender[0]) !== activeFilterUid) return

  const medal = info[3]
  const record: LocalDanmakuRecord = {
    ts: Number(info[9]?.ts || Math.floor(Date.now() / 1000)) * 1000,
    uid: Number(sender[0]),
    uname: String(sender[1] || `UID ${sender[0]}`),
    content,
    color: Number(info[0]?.[3] || 0),
    medalName: Array.isArray(medal) && medal[1] ? String(medal[1]) : undefined,
    medalLevel: Array.isArray(medal) && medal[0] ? Number(medal[0]) : undefined,
  }
  recentRecords.value = [...recentRecords.value, record].slice(-MAX_RECENT_RECORDS)
  if (activeSession.value) {
    activeSession.value.messageCount += 1
    const index = captureSessions.value.findIndex((session) => session.id === activeSession.value?.id)
    if (index >= 0) captureSessions.value[index] = { ...activeSession.value }
  }
  queueRecord(record)
  schedulePersist()
}

function closeClient() {
  if (!liveMessageClient) return
  liveMessageClient.disconnect()
  liveMessageClient.destroy()
  liveMessageClient = null
}

function createClient(roomId: number) {
  return publicClient.live.getLiveMsgServerConfig(roomId).then((serverConfig) => {
    liveMessageClient = new BiliLiveMessageClient(
      {
        uid: 0,
        roomId,
        compression: new UniversalCompression(),
      },
      serverConfig,
      {
        onConnecting: () => {
          captureState.value = 'connecting'
        },
        onConnect: () => {
          captureState.value = 'connected'
        },
        onDisconnect: () => {
          if (captureState.value !== 'stopping') captureState.value = 'reconnecting'
        },
        onReconnecting: () => {
          captureState.value = 'reconnecting'
        },
        onReconnectSuccess: () => {
          captureState.value = 'connected'
        },
        onReconnectFailed: () => {
          captureState.value = 'error'
          captureError.value = '直播间连接多次失败，请检查网络或稍后重试。'
        },
        onHeartbeatReply: (value) => {
          popularity.value = value
        },
        onMessage: <Type extends MessageType = MessageType>(type: MessageType, message: MessageMap<Type>) => {
          if (type === 'DANMU_MSG') handleDanmakuMessage(message as DanmakuMessage)
        },
        onError: () => {
          captureError.value = '直播间连接发生网络错误。'
        },
      },
    )
    liveMessageClient.connect()
  })
}

export async function startCapture(
  targetType: LocalCaptureTargetType,
  targetValue: string,
  filterUid?: string,
) {
  await initializeCaptureStore()
  if (activeSession.value) throw new Error('已经有一个采集任务正在运行，请先停止它')
  captureError.value = ''
  recentRecords.value = []
  popularity.value = 0
  captureState.value = 'resolving'

  try {
    const normalizedFilterUid = filterUid ? Number(normalizeId(filterUid)) : undefined
    const target = await resolveTarget(targetType, targetValue, normalizedFilterUid)
    const id = `${Date.now()}-${target.roomId}`
    const session: LocalCaptureSession = {
      id,
      targetType,
      targetValue: normalizeId(targetValue),
      filterUid: target.filterUid,
      filterUserName: target.filterUserName,
      roomId: target.roomId,
      anchorUid: target.anchorUid,
      anchorName: target.anchorName,
      anchorFace: target.anchorFace,
      title: target.title,
      cover: target.cover,
      area: target.area,
      parentArea: target.parentArea,
      startedAt: Date.now(),
      messageCount: 0,
      filePath: `${CAPTURE_DIR}/${id}.jsonl`,
      status: 'recording',
    }
    fileHandle = await window.toolkitApi.file.open(session.filePath, 'a+')
    activeFilterUid = target.filterUid
    activeSession.value = session
    captureSessions.value = [session, ...captureSessions.value]
    await persistIndex()
    captureState.value = 'connecting'
    await createClient(target.roomId)
  } catch (error) {
    closeClient()
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined)
      fileHandle = null
    }
    captureState.value = 'error'
    activeFilterUid = undefined
    captureError.value = asError(error).message || '启动采集失败'
    if (activeSession.value) {
      activeSession.value = { ...activeSession.value, status: 'error', error: captureError.value, endedAt: Date.now() }
      const index = captureSessions.value.findIndex((session) => session.id === activeSession.value?.id)
      if (index >= 0) captureSessions.value[index] = activeSession.value
      await persistIndex()
      activeSession.value = null
    }
    throw asError(error)
  }
}

export async function stopCapture(status: LocalCaptureStatus = 'completed') {
  if (!activeSession.value) return
  captureState.value = 'stopping'
  closeClient()
  await flushPending()
  await writeChain
  if (fileHandle) {
    await fileHandle.close().catch(() => undefined)
    fileHandle = null
  }
  activeFilterUid = undefined
  const session = activeSession.value
  session.status = status
  session.endedAt = Date.now()
  const index = captureSessions.value.findIndex((item) => item.id === session.id)
  if (index >= 0) captureSessions.value[index] = { ...session }
  activeSession.value = null
  captureState.value = 'idle'
  await persistIndex()
}

export async function loadCaptureSessions() {
  await initializeCaptureStore()
  return captureSessions.value
}

export async function loadCaptureRecords(session: LocalCaptureSession) {
  if (!(await window.toolkitApi.file.exists(session.filePath))) return []
  const handle = await window.toolkitApi.file.open(session.filePath, 'r')
  const decoder = new TextDecoder()
  const records: LocalDanmakuRecord[] = []
  let carry = ''
  try {
    while (true) {
      const chunk = await handle.read(256 * 1024)
      carry += decoder.decode(chunk.data, { stream: !chunk.eof })
      const lines = carry.split('\n')
      carry = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line) as LocalDanmakuRecord)
        } catch {
          // Ignore a partially written/corrupt line so other records remain readable.
        }
      }
      if (chunk.eof) break
    }
    if (carry.trim()) {
      try {
        records.push(JSON.parse(carry) as LocalDanmakuRecord)
      } catch {
        // Ignore incomplete final line.
      }
    }
  } finally {
    await handle.close()
  }
  return records
}

export async function deleteCaptureSession(session: LocalCaptureSession) {
  if (activeSession.value?.id === session.id) throw new Error('正在采集的会话不能删除，请先停止采集')
  if (await window.toolkitApi.file.exists(session.filePath)) await window.toolkitApi.file.delete(session.filePath)
  captureSessions.value = captureSessions.value.filter((item) => item.id !== session.id)
  await persistIndex()
}

window.addEventListener('pagehide', () => {
  if (activeSession.value) void stopCapture('interrupted')
})

