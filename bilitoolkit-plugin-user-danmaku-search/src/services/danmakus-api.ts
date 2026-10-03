import { decode } from '@msgpack/msgpack'
import type {
  ApiResponse,
  BiliLiveRoomInfo,
  BootstrapData,
  HistoryPage,
  RoomChannelData,
  DanmakuSession,
} from '@/types/danmaku'
import { decodeLiveSession } from './live-decoder'

const API_BASE = 'https://api.ukamnads.icu/api/v3'

async function request<T>(path: string, signal?: AbortSignal, base = API_BASE): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    signal,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`查询服务返回 HTTP ${response.status}`)

  const body = (await response.json()) as ApiResponse<T>
  if (body.code !== 200) throw new Error(body.message || `查询失败（代码 ${body.code}）`)
  return body.data
}

export function fetchRoomChannel(ownerUid: string, signal?: AbortSignal) {
  return request<RoomChannelData>(
    `/channel?uId=${encodeURIComponent(ownerUid)}`,
    signal,
    'https://api.ukamnads.icu/api/v2',
  )
}

export async function fetchLiveSession(liveId: string, signal?: AbortSignal): Promise<DanmakuSession> {
  const response = await fetch(`${API_BASE}/lives/${encodeURIComponent(liveId)}/full?includeEnter=false`, {
    signal,
    headers: { Accept: 'application/x-msgpack' },
  })
  if (!response.ok) throw new Error(`场次弹幕接口返回 HTTP ${response.status}`)
  return decodeLiveSession(decode(new Uint8Array(await response.arrayBuffer())))
}

export function fetchBootstrap(uid: string, pageSize: number, signal?: AbortSignal) {
  return request<BootstrapData>(`/users/${encodeURIComponent(uid)}/bootstrap?page=1&pageSize=${pageSize}`, signal)
}

export function fetchHistory(
  uid: string,
  page: number,
  pageSize: number,
  channelUserId?: string,
  signal?: AbortSignal,
) {
  const channelQuery = channelUserId ? `&channelUserId=${encodeURIComponent(channelUserId)}` : ''
  return request<HistoryPage>(
    `/users/${encodeURIComponent(uid)}/history?page=${page}&pageSize=${pageSize}${channelQuery}`,
    signal,
  )
}

export async function resolveRoomOwner(roomId: string, signal?: AbortSignal) {
  const response = await fetch(
    `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`,
    { signal, headers: { Accept: 'application/json' } },
  )
  if (!response.ok) throw new Error(`直播间信息接口返回 HTTP ${response.status}`)

  const body = (await response.json()) as { code: number; message: string; data?: BiliLiveRoomInfo }
  if (body.code !== 0 || !body.data?.uid) throw new Error(body.message || '没有找到该直播间')
  return body.data
}
