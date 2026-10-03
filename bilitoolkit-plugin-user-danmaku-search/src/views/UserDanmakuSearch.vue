<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { PluginPageContent, showToast } from 'bilitoolkit-ui'
import {
  fetchBootstrap,
  fetchHistory,
  resolveRoomOwner,
  fetchRoomChannel,
  fetchLiveSession,
} from '@/services/danmakus-api'
import type { DanmakuRecord, DanmakuSession, QueryHistoryItem, WatchedChannel, RoomChannelData } from '@/types/danmaku'

const HISTORY_DB_KEY = 'query-history'
const SETTINGS_DB_KEY = 'search-settings'
const HISTORY_LIMIT = 20

const uid = ref('')
const queryMode = ref<'user' | 'room'>('user')
const activeMode = ref<'user' | 'room'>('user')
const activeUid = ref('')
const roomData = ref<RoomChannelData>()
const busy = computed(() => loading.value || loadingMore.value || loadingFilter.value)
const maxPageSize = computed(() => (queryMode.value === 'room' ? 10 : 100))
const loadingSession = ref(0)
const visibleRecordLimits = ref<Record<string, number>>({})
const loading = ref(false)
const loadingMore = ref(false)
const loadingFilter = ref(false)
const searched = ref(false)
const page = ref(1)
const pageSize = ref(10)
const loadedPageSize = ref(10)
const total = ref(0)
const hasMore = ref(false)
const sessions = ref<DanmakuSession[]>([])
const watchedChannels = ref<WatchedChannel[]>([])
const queryHistory = ref<QueryHistoryItem[]>([])
const channelFilter = ref('')
const keywordFilter = ref('')
const activeChannelUserId = ref('')
const activeChannelLabel = ref('')
let abortController: AbortController | undefined

const recordCount = computed(() =>
  sessions.value.reduce((count, session) => count + session.danmakus.records.length, 0),
)

const filteredSessions = computed(() => {
  const keyword = keywordFilter.value.trim().toLocaleLowerCase()
  if (!keyword) return sessions.value

  return sessions.value
    .map((session) => ({
      ...session,
      danmakus: {
        ...session.danmakus,
        records: session.danmakus.records.filter((record) =>
          recordContent(session, record).toLocaleLowerCase().includes(keyword),
        ),
      },
    }))
    .filter((session) => session.danmakus.records.length > 0)
})

const filteredRecordCount = computed(() =>
  filteredSessions.value.reduce((count, session) => count + session.danmakus.records.length, 0),
)

function normalizeUid(value: string) {
  return value.replace(/\D/g, '').replace(/^0+/, '')
}

function formatDate(timestamp: number) {
  if (!timestamp) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function actorName(session: DanmakuSession, record: DanmakuRecord) {
  return session.danmakus.actors[record.actorId]?.name || (record.actorId < 0 ? '系统' : `UID ${activeUid.value}`)
}

function switchMode() {
  uid.value = ''
  searched.value = false
  sessions.value = []
  pageSize.value = queryMode.value === 'room' ? 1 : 10
}

function visibleRecords(session: DanmakuSession) {
  return session.danmakus.records.slice(0, visibleRecordLimits.value[session.live.liveId] || 200)
}

async function fetchRoomPage(targetPage: number, signal?: AbortSignal) {
  if (!roomData.value) throw new Error('请先查询直播间')
  const lives = roomData.value.lives.slice((targetPage - 1) * pageSize.value, targetPage * pageSize.value)
  const items: DanmakuSession[] = []
  for (const live of lives) {
    loadingSession.value = items.length + 1
    const session = await fetchLiveSession(live.liveId, signal)
    session.channel.faceUrl = roomData.value.channel.faceUrl
    items.push(session)
  }
  return {
    items,
    total: roomData.value.lives.length,
    hasMore: targetPage * pageSize.value < roomData.value.lives.length,
  }
}

function recordContent(session: DanmakuSession, record: DanmakuRecord) {
  if (record.payload?.rawText) return record.payload.rawText
  if (record.payloadKind === 2 && record.payload?.roomEmojiId !== undefined) {
    return `[表情] ${session.danmakus.roomEmojis[record.payload.roomEmojiId]?.name || ''}`.trim()
  }
  const actionNames: Record<number, string> = { 1: '赠送礼物', 2: '醒目留言', 3: '上舰', 4: '进入直播间' }
  return actionNames[record.type] || `互动记录（类型 ${record.type}）`
}

async function saveHistory(name: string) {
  const item: QueryHistoryItem = {
    uid: activeUid.value,
    mode: activeMode.value,
    name: name || `${activeMode.value === 'room' ? '房间' : 'UID'} ${activeUid.value}`,
    queriedAt: Date.now(),
  }
  queryHistory.value = [
    item,
    ...queryHistory.value.filter((entry) => entry.uid !== item.uid || (entry.mode || 'user') !== item.mode),
  ].slice(0, HISTORY_LIMIT)
  await window.toolkitApi.db.write(HISTORY_DB_KEY, { items: queryHistory.value })
}

async function search(targetUid = uid.value, mode = queryMode.value) {
  if (busy.value) return
  const normalized = normalizeUid(targetUid)
  if (!normalized) {
    showToast(`请输入有效的${mode === 'room' ? '房间号' : ' UID'}`)
    return
  }

  uid.value = normalized
  if (queryMode.value !== mode) pageSize.value = mode === 'room' ? 1 : 10
  queryMode.value = mode
  activeMode.value = mode
  activeUid.value = normalized
  abortController?.abort()
  abortController = new AbortController()
  loading.value = true
  searched.value = false
  sessions.value = []
  watchedChannels.value = []
  visibleRecordLimits.value = {}
  channelFilter.value = ''
  keywordFilter.value = ''
  activeChannelUserId.value = ''
  activeChannelLabel.value = ''
  try {
    if (mode === 'room') {
      const room = await resolveRoomOwner(normalized, abortController.signal)
      roomData.value = await fetchRoomChannel(String(room.uid), abortController.signal)
      roomData.value.lives = [...new Map(roomData.value.lives.map((live) => [live.liveId, live])).values()].sort(
        (a, b) => b.startDate - a.startDate,
      )
      const data = await fetchRoomPage(1, abortController.signal)
      sessions.value = data.items
      total.value = data.total
      hasMore.value = data.hasMore
      page.value = 1
      loadedPageSize.value = pageSize.value
      activeChannelLabel.value = `${roomData.value.channel.uName}（房间 ${room.room_id}）`
      searched.value = true
      await saveHistory(roomData.value.channel.uName)
      return
    }
    const data = await fetchBootstrap(normalized, pageSize.value, abortController.signal)
    sessions.value = data.history.items || []
    watchedChannels.value = data.watchedChannels || []
    total.value = data.history.total || 0
    page.value = 1
    loadedPageSize.value = pageSize.value
    hasMore.value = data.history.hasMore
    channelFilter.value = ''
    keywordFilter.value = ''
    activeChannelUserId.value = ''
    activeChannelLabel.value = ''
    searched.value = true
    const userName = sessions.value
      .flatMap((item) => item.danmakus.actors)
      .find((actor) => String(actor.uid) === normalized)?.name
    await saveHistory(userName || data.historyUserNames?.[0] || '')
  } catch (error) {
    if ((error as Error).name !== 'AbortError') showToast((error as Error).message || '查询失败，请稍后重试')
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!hasMore.value || busy.value) return
  abortController = new AbortController()
  loadingMore.value = true
  try {
    const nextPage = page.value + 1
    const data =
      activeMode.value === 'room'
        ? await fetchRoomPage(nextPage, abortController.signal)
        : await fetchHistory(
            activeUid.value,
            nextPage,
            pageSize.value,
            activeChannelUserId.value || undefined,
            abortController.signal,
          )
    sessions.value.push(...(data.items || []))
    page.value = nextPage
    hasMore.value = data.hasMore
  } catch (error) {
    if ((error as Error).name !== 'AbortError') showToast((error as Error).message || '加载失败，请稍后重试')
  } finally {
    loadingMore.value = false
  }
}

async function reloadFirstPage(
  channelUserId = activeChannelUserId.value,
  channelLabel = activeChannelLabel.value,
  signal?: AbortSignal,
) {
  if (!signal) {
    abortController = new AbortController()
    signal = abortController.signal
  }
  const data =
    activeMode.value === 'room'
      ? await fetchRoomPage(1, signal)
      : await fetchHistory(activeUid.value, 1, pageSize.value, channelUserId || undefined, signal)
  sessions.value = data.items || []
  total.value = data.total || 0
  page.value = 1
  loadedPageSize.value = pageSize.value
  hasMore.value = data.hasMore
  activeChannelUserId.value = channelUserId
  activeChannelLabel.value = channelLabel
  visibleRecordLimits.value = {}
}

async function changePageSize(value?: number) {
  pageSize.value = Math.min(maxPageSize.value, Math.max(1, Number(value) || 1))
  if (!searched.value) {
    await window.toolkitApi.db.write(SETTINGS_DB_KEY, { pageSize: pageSize.value })
    return
  }

  loadingFilter.value = true
  try {
    await reloadFirstPage()
    await window.toolkitApi.db.write(SETTINGS_DB_KEY, { pageSize: pageSize.value })
  } catch (error) {
    pageSize.value = loadedPageSize.value
    if ((error as Error).name !== 'AbortError') showToast((error as Error).message || '调整加载数量失败')
  } finally {
    loadingFilter.value = false
  }
}

async function applyChannelFilter() {
  if (busy.value) return
  abortController = new AbortController()
  const value = channelFilter.value.trim()
  loadingFilter.value = true
  try {
    let channelUserId = ''
    let channelLabel = ''

    if (/^\d+$/.test(value)) {
      const room = await resolveRoomOwner(value, abortController.signal)
      channelUserId = String(room.uid)
      const channel = watchedChannels.value.find((item) => String(item.uId) === channelUserId)
      channelLabel = channel ? `${channel.uName}（房间 ${room.room_id}）` : `房间 ${room.room_id}`
    } else if (value) {
      const normalized = value.toLocaleLowerCase()
      const exact = watchedChannels.value.find((item) => item.uName.toLocaleLowerCase() === normalized)
      const matches = watchedChannels.value.filter((item) => item.uName.toLocaleLowerCase().includes(normalized))
      if (!exact && matches.length === 0) throw new Error('该用户的记录中没有匹配的主播')
      if (!exact && matches.length > 1) throw new Error(`匹配到 ${matches.length} 位主播，请输入更完整的名称`)
      const channel = exact || matches[0]
      channelUserId = String(channel.uId)
      channelLabel = channel.uName
    }

    await reloadFirstPage(channelUserId, channelLabel, abortController.signal)
  } catch (error) {
    if ((error as Error).name !== 'AbortError') showToast((error as Error).message || '直播间筛选失败')
  } finally {
    loadingFilter.value = false
  }
}

function clearFilters() {
  channelFilter.value = ''
  keywordFilter.value = ''
  if (activeMode.value === 'user') void applyChannelFilter()
}

async function removeHistory(entry: QueryHistoryItem) {
  queryHistory.value = queryHistory.value.filter(
    (item) => item.uid !== entry.uid || (item.mode || 'user') !== (entry.mode || 'user'),
  )
  await window.toolkitApi.db.write(HISTORY_DB_KEY, { items: queryHistory.value })
}

async function clearHistory() {
  queryHistory.value = []
  await window.toolkitApi.db.write(HISTORY_DB_KEY, { items: [] })
}

onMounted(async () => {
  const [storedHistory, storedSettings] = await Promise.all([
    window.toolkitApi.db.init<{ items: QueryHistoryItem[] }>(HISTORY_DB_KEY, { items: [] }),
    window.toolkitApi.db.init<{ pageSize: number }>(SETTINGS_DB_KEY, { pageSize: 10 }),
  ])
  queryHistory.value = storedHistory.items || []
  pageSize.value = Math.min(100, Math.max(1, Number(storedSettings.pageSize) || 10))
})

onUnmounted(() => abortController?.abort())
</script>

<template>
  <PluginPageContent>
    <div class="page">
      <section class="search-card">
        <div>
          <h2>直播弹幕查询</h2>
          <p>选择房间号查询直播间已收录弹幕，或输入 UID 查询该用户的直播弹幕。</p>
        </div>
        <el-radio-group v-model="queryMode" :disabled="busy" @change="switchMode">
          <el-radio-button value="room">按房间号</el-radio-button>
          <el-radio-button value="user">按用户 UID</el-radio-button>
        </el-radio-group>
        <div class="search-row">
          <el-input
            v-model="uid"
            :disabled="busy"
            inputmode="numeric"
            clearable
            :placeholder="queryMode === 'room' ? '请输入直播间房间号（支持短号）' : '请输入目标 UID'"
            @input="uid = normalizeUid(uid)"
            @keyup.enter="search()"
          >
            <template #prepend>{{ queryMode === 'room' ? '房间号' : 'UID' }}</template>
          </el-input>
          <el-button type="primary" :loading="loading" :disabled="loadingMore || loadingFilter" @click="search()"
            >查询</el-button
          >
          <el-button v-if="busy" @click="abortController?.abort()">取消</el-button>
        </div>
        <p v-if="busy && activeMode === 'room'">正在读取本批第 {{ loadingSession }} 场弹幕…</p>
        <el-alert
          title="只查询 Danmakus 已收录的数据，不保证覆盖直播间全部历史弹幕；按场次分页加载，不进行本地实时采集。"
          type="info"
          :closable="false"
          show-icon
        />
      </section>

      <section v-if="queryHistory.length" class="history-section">
        <div class="section-title">
          <span>本地查询记录</span>
          <el-button link type="danger" @click="clearHistory">清空</el-button>
        </div>
        <div class="history-list">
          <el-tag
            v-for="item in queryHistory"
            :key="`${item.mode || 'user'}-${item.uid}`"
            closable
            size="large"
            class="history-tag"
            @click="search(item.uid, item.mode || 'user')"
            @close.stop="removeHistory(item)"
          >
            {{ item.name }} · {{ item.mode === 'room' ? '房间' : 'UID' }} {{ item.uid }}
          </el-tag>
        </div>
      </section>

      <section v-if="searched" class="results">
        <div class="result-summary">
          <span>
            {{ activeChannelLabel ? `${activeChannelLabel}：` : '' }}共 {{ total }} 场直播记录，当前已加载
            {{ sessions.length }} 场、{{ recordCount }} 条互动
          </span>
          <div class="summary-actions">
            <span class="page-size-label">每次加载</span>
            <el-input-number
              v-model="pageSize"
              :min="1"
              :max="maxPageSize"
              :step="queryMode === 'room' ? 1 : 10"
              :disabled="busy"
              controls-position="right"
              @change="changePageSize"
            />
            <el-button
              v-if="hasMore"
              type="primary"
              plain
              :loading="loadingMore"
              :disabled="loadingFilter"
              @click="loadMore"
            >
              加载更多
            </el-button>
            <el-button v-if="channelFilter || keywordFilter" link @click="clearFilters">清除筛选</el-button>
          </div>
        </div>

        <div class="filter-bar" :style="activeMode === 'room' ? { gridTemplateColumns: '1fr' } : {}">
          <el-input
            v-if="activeMode === 'user'"
            v-model.trim="channelFilter"
            clearable
            placeholder="直播间房间号或主播名称"
            @keyup.enter="applyChannelFilter"
            @clear="applyChannelFilter"
          >
            <template #prepend>直播间</template>
          </el-input>
          <el-button
            v-if="activeMode === 'user'"
            :loading="loadingFilter"
            :disabled="loadingMore"
            @click="applyChannelFilter"
            >筛选直播间</el-button
          >
          <el-input v-model.trim="keywordFilter" clearable placeholder="例如：如果">
            <template #prepend>弹幕内容</template>
          </el-input>
        </div>
        <div v-if="keywordFilter" class="filter-hint">
          关键词正在筛选当前已加载的 {{ sessions.length }} 场直播，命中 {{ filteredSessions.length }} 场、
          {{ filteredRecordCount }} 条互动；继续“加载更多”可扩大筛选范围。
        </div>

        <el-empty
          v-if="filteredSessions.length === 0"
          :description="sessions.length ? '当前已加载记录中没有符合条件的弹幕' : '没有查询到已收录的弹幕记录'"
        />

        <article v-for="session in filteredSessions" :key="session.live.liveId" class="session-card">
          <img :src="session.channel.frameUrl || session.channel.faceUrl" class="cover" alt="直播封面" />
          <div class="session-main">
            <div class="session-header">
              <div>
                <h3>{{ session.live.title || session.channel.title || '未命名直播' }}</h3>
                <div class="meta">
                  {{ session.channel.uName }} · 房间 {{ session.channel.roomId }} ·
                  {{ formatDate(session.live.startDate) }}
                </div>
                <div v-if="activeMode === 'room'" class="meta">
                  {{ session.live.isFull ? '该场标记为完整收录' : '该场仅部分收录' }} ·
                  {{ session.live.isFinish ? '场次已结束' : '未结束场次，结果为查询时的收录快照' }}
                </div>
              </div>
              <el-tag effect="plain">{{ session.live.parentArea }} / {{ session.live.area }}</el-tag>
            </div>
            <div class="records">
              <div v-for="(record, index) in visibleRecords(session)" :key="`${record.ts}-${index}`" class="record">
                <span class="time">{{ formatDate(record.ts).slice(11) }}</span>
                <span class="actor">{{ actorName(session, record) }}</span>
                <span class="content">{{ recordContent(session, record) }}</span>
              </div>
              <el-button
                v-if="visibleRecords(session).length < session.danmakus.records.length"
                link
                type="primary"
                @click="
                  visibleRecordLimits[session.live.liveId] = (visibleRecordLimits[session.live.liveId] || 200) + 200
                "
              >
                显示更多弹幕（已显示 {{ visibleRecords(session).length }} / {{ session.danmakus.records.length }} 条）
              </el-button>
            </div>
          </div>
        </article>

        <div v-if="sessions.length" class="load-more">
          <el-button v-if="hasMore" :loading="loadingMore" :disabled="loadingFilter" @click="loadMore">
            加载更多（{{ pageSize }} 场）
          </el-button>
          <span v-else>已加载全部记录</span>
        </div>
      </section>
    </div>
  </PluginPageContent>
</template>

<style scoped lang="scss">
.page {
  height: 100%;
  overflow-y: auto;
  padding: 0 20px 28px;
}
.search-card {
  max-width: 820px;
  margin: 0 auto 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
h2,
h3,
p {
  margin: 0;
}
.search-card p,
.meta,
.load-more {
  color: var(--el-text-color-secondary);
}
.search-row {
  display: flex;
  gap: 10px;
}
.history-section,
.results {
  max-width: 980px;
  margin: 0 auto 20px;
}
.section-title,
.result-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  font-weight: 600;
}
.summary-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}
.page-size-label {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  font-weight: 400;
  white-space: nowrap;
}
.summary-actions :deep(.el-input-number) {
  width: 112px;
}
.filter-bar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto minmax(260px, 1fr);
  gap: 10px;
  margin-bottom: 8px;
}
.filter-hint {
  margin-bottom: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.history-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.history-tag {
  cursor: pointer;
}
.session-card {
  display: flex;
  gap: 14px;
  margin-bottom: 12px;
  padding: 14px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
}
.cover {
  width: 144px;
  height: 81px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--el-fill-color);
}
.session-main {
  flex: 1;
  min-width: 0;
}
.session-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.session-header h3 {
  margin-bottom: 5px;
  font-size: 16px;
}
.meta {
  font-size: 12px;
}
.records {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.record {
  display: grid;
  grid-template-columns: 78px 120px minmax(0, 1fr);
  gap: 8px;
  font-size: 13px;
}
.time {
  color: var(--el-text-color-secondary);
}
.actor {
  color: var(--el-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.content {
  overflow-wrap: anywhere;
}
.load-more {
  display: flex;
  justify-content: center;
  padding: 12px;
}
@media (max-width: 720px) {
  .result-summary {
    align-items: flex-start;
    flex-direction: column;
  }
  .summary-actions {
    flex-wrap: wrap;
    justify-content: flex-start;
  }
  .filter-bar {
    grid-template-columns: 1fr;
  }
  .search-row,
  .session-card {
    flex-direction: column;
  }
  .cover {
    width: 100%;
    height: 160px;
  }
  .record {
    grid-template-columns: 72px 100px minmax(0, 1fr);
  }
}
</style>
