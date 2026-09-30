export interface QueryHistoryItem {
  uid: string
  name: string
  queriedAt: number
}

export interface WatchedChannel {
  uName: string
  uId: number
  faceUrl: string
  count: number
}

export interface DanmakuActor {
  uid: number
  name: string
}

export interface RoomEmoji {
  name: string
  resource: string
}

export interface DanmakuRecord {
  ts: number
  type: number
  actorId: number
  payloadKind: number
  payload?: {
    rawText?: string
    roomEmojiId?: number
    [key: string]: unknown
  }
}

export interface DanmakuSession {
  channel: {
    uId: number
    uName: string
    roomId: number
    faceUrl: string
    frameUrl: string
    title: string
  }
  live: {
    liveId: string
    parentArea: string
    area: string
    title: string
    startDate: number
    stopDate: number
    watchCount: number
    likeCount: number
    interactionCount: number
  }
  danmakus: {
    actors: DanmakuActor[]
    roomEmojis: RoomEmoji[]
    records: DanmakuRecord[]
  }
}

export interface HistoryPage {
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  items: DanmakuSession[]
}

export interface BootstrapData {
  history: HistoryPage
  historyUserNames?: string[]
  watchedChannels?: WatchedChannel[]
}

export interface BiliLiveRoomInfo {
  uid: number
  room_id: number
  short_id: number
  title?: string
  user_cover?: string
  keyframe?: string
  live_status?: number
  area_name?: string
  parent_area_name?: string
}

export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

export type LocalCaptureTargetType = 'uid' | 'room' | 'user'
export type LocalCaptureStatus = 'recording' | 'completed' | 'interrupted' | 'error'

export interface LocalDanmakuRecord {
  ts: number
  uid: number
  uname: string
  content: string
  color: number
  medalName?: string
  medalLevel?: number
}

export interface LocalCaptureSession {
  id: string
  targetType: LocalCaptureTargetType
  targetValue: string
  filterUid?: number
  filterUserName?: string
  roomId: number
  anchorUid: number
  anchorName: string
  anchorFace: string
  title: string
  cover: string
  area?: string
  parentArea?: string
  startedAt: number
  endedAt?: number
  messageCount: number
  filePath: string
  status: LocalCaptureStatus
  error?: string
}
