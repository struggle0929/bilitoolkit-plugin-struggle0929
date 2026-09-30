<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { PluginPageContent } from 'bilitoolkit-ui'
import {
  captureRootDir,
  captureSessions,
  deleteCaptureSession,
  loadCaptureRecords,
  loadCaptureSessions,
} from '@/services/local-capture'
import type { LocalCaptureSession, LocalDanmakuRecord } from '@/types/danmaku'

const selectedId = ref('')
const records = ref<LocalDanmakuRecord[]>([])
const loading = ref(false)
const keyword = ref('')
const sender = ref('')
const page = ref(1)
const pageSize = ref(100)

const selectedSession = computed(() => captureSessions.value.find((session) => session.id === selectedId.value) || null)
const filteredRecords = computed(() => {
  const content = keyword.value.trim().toLocaleLowerCase()
  const user = sender.value.trim().toLocaleLowerCase()
  return records.value.filter((record) => {
    const contentMatched = !content || record.content.toLocaleLowerCase().includes(content)
    const senderMatched = !user || record.uname.toLocaleLowerCase().includes(user) || String(record.uid) === user
    return contentMatched && senderMatched
  })
})
const visibleRecords = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredRecords.value.slice(start, start + pageSize.value)
})

function formatDate(timestamp?: number) {
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

function statusLabel(session: LocalCaptureSession) {
  if (session.status === 'completed') return '已完成'
  if (session.status === 'interrupted') return '上次中断'
  if (session.status === 'error') return '启动失败'
  return '采集中'
}

function statusType(session: LocalCaptureSession) {
  if (session.status === 'completed') return 'success'
  if (session.status === 'recording') return 'warning'
  return 'info'
}

function formatColor(color: number) {
  return color ? `#${color.toString(16).padStart(6, '0')}` : 'inherit'
}

async function openSession(session: LocalCaptureSession) {
  selectedId.value = session.id
  loading.value = true
  page.value = 1
  try {
    records.value = await loadCaptureRecords(session)
  } catch (error) {
    ElMessage({
      message: error instanceof Error ? error.message : '读取本地记录失败',
      type: 'error',
      duration: 0,
      showClose: true,
    })
  } finally {
    loading.value = false
  }
}

async function removeSession(session: LocalCaptureSession) {
  try {
    await ElMessageBox.confirm(
      `将删除“${session.anchorName} · ${formatDate(session.startedAt)}”及其本地弹幕文件，此操作不可恢复。`,
      '删除本地记录',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    await deleteCaptureSession(session)
    if (selectedId.value === session.id) {
      selectedId.value = ''
      records.value = []
    }
    ElMessage.success('本地记录已删除')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage({
        message: error instanceof Error ? error.message : '删除本地记录失败',
        type: 'error',
        duration: 0,
        showClose: true,
      })
    }
  }
}

function resetPage() {
  page.value = 1
}

async function openFolder() {
  if (captureRootDir.value) await window.toolkitApi.system.showItemInFolder(captureRootDir.value)
}

watch([keyword, sender], resetPage)
onMounted(() => {
  void loadCaptureSessions()
})
</script>

<template>
  <PluginPageContent>
    <div class="page">
      <section class="hero">
        <div>
          <h2>本地弹幕记录</h2>
          <p>打开已经保存的直播弹幕，按关键词或发送者筛选和分页浏览。</p>
        </div>
        <el-button link @click="openFolder">打开保存目录</el-button>
      </section>

      <el-empty v-if="captureSessions.length === 0" description="还没有本地采集记录，请先开始一次采集" />
      <div v-else class="layout">
        <section class="session-panel">
          <div class="panel-title">采集会话 <span>{{ captureSessions.length }}</span></div>
          <button
            v-for="session in captureSessions"
            :key="session.id"
            class="session-item"
            :class="{ active: selectedId === session.id }"
            @click="openSession(session)"
          >
            <div class="item-cover">
              <img v-if="session.cover" :src="session.cover" alt="直播封面" />
              <span v-else>DM</span>
            </div>
            <div class="item-main">
              <strong>{{ session.anchorName }}</strong>
              <span>{{ session.title }}</span>
              <small>{{ formatDate(session.startedAt) }} · {{ session.messageCount }} 条</small>
            </div>
            <el-tag size="small" :type="statusType(session)" effect="plain">{{ statusLabel(session) }}</el-tag>
          </button>
        </section>

        <section v-if="selectedSession" class="viewer-panel">
          <div class="viewer-header">
            <div class="viewer-anchor">
              <img v-if="selectedSession.anchorFace" :src="selectedSession.anchorFace" alt="主播头像" />
              <div>
                <h3>{{ selectedSession.title }}</h3>
                <span>
                  {{ selectedSession.anchorName }} · 房间 {{ selectedSession.roomId }} ·
                  {{ formatDate(selectedSession.startedAt) }}
                  <template v-if="selectedSession.endedAt"> 至 {{ formatDate(selectedSession.endedAt) }}</template>
                </span>
              </div>
            </div>
            <div class="viewer-actions">
              <el-tag :type="statusType(selectedSession)">{{ statusLabel(selectedSession) }}</el-tag>
              <el-button type="danger" link @click="removeSession(selectedSession)">删除</el-button>
            </div>
          </div>
          <div class="filters">
            <el-input v-model.trim="keyword" clearable placeholder="筛选弹幕内容" />
            <el-input v-model.trim="sender" clearable placeholder="筛选发送者名称或 UID" />
            <span>共 {{ filteredRecords.length }} 条</span>
          </div>
          <el-skeleton v-if="loading" :rows="8" animated />
          <div v-else class="history-records">
            <div v-for="record in visibleRecords" :key="`${record.ts}-${record.uid}-${record.content}`" class="history-row">
              <span class="record-time">{{ formatDate(record.ts).slice(11) }}</span>
              <span class="record-user">{{ record.uname }}<small>{{ record.uid }}</small></span>
              <el-tag v-if="record.medalName" size="small" effect="plain">
                {{ record.medalName }} {{ record.medalLevel }}
              </el-tag>
              <span class="record-content" :style="{ color: formatColor(record.color) }">{{ record.content }}</span>
            </div>
            <el-empty v-if="visibleRecords.length === 0" description="没有匹配的弹幕" :image-size="80" />
          </div>
          <div class="pagination">
            <el-pagination
              v-model:current-page="page"
              v-model:page-size="pageSize"
              background
              layout="total, sizes, prev, pager, next"
              :page-sizes="[50, 100, 200]"
              :total="filteredRecords.length"
            />
          </div>
        </section>
        <el-empty v-else class="select-empty" description="选择左侧会话查看弹幕" />
      </div>
    </div>
  </PluginPageContent>
</template>

<style scoped lang="scss">
.page {
  height: 100%;
  overflow-y: auto;
  padding: 0 20px 28px;
}
.hero,
.layout {
  max-width: 1100px;
  margin: 0 auto 16px;
}
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
h2,
h3,
p {
  margin: 0;
}
h2 {
  margin-bottom: 5px;
}
p,
.viewer-anchor span,
.filters > span {
  color: var(--el-text-color-secondary);
}
.layout {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.session-panel,
.viewer-panel {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--el-bg-color);
}
.panel-title {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
  font-weight: 600;
}
.panel-title span {
  color: var(--el-text-color-secondary);
  font-weight: 400;
}
.session-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
  padding: 9px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.session-item:hover,
.session-item.active {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}
.item-cover {
  width: 54px;
  height: 38px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 5px;
  background: var(--el-fill-color);
  color: var(--el-color-primary);
  line-height: 38px;
  text-align: center;
}
.item-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.item-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.item-main strong,
.item-main span,
.item-main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-main span,
.item-main small {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.item-main small {
  font-size: 11px;
}
.viewer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 16px;
}
.viewer-anchor {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.viewer-anchor img {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  object-fit: cover;
}
.viewer-anchor div {
  min-width: 0;
}
.viewer-anchor h3 {
  overflow: hidden;
  margin-bottom: 5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.viewer-anchor span {
  font-size: 12px;
}
.viewer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.filters {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.filters .el-input {
  flex: 1;
}
.filters > span {
  white-space: nowrap;
  font-size: 12px;
}
.history-records {
  min-height: 280px;
  max-height: 620px;
  overflow-y: auto;
  border-top: 1px solid var(--el-border-color-lighter);
}
.history-row {
  display: grid;
  grid-template-columns: 65px 130px auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 13px;
}
.record-time,
.record-user small {
  color: var(--el-text-color-secondary);
}
.record-user {
  display: flex;
  flex-direction: column;
  color: var(--el-color-primary);
}
.record-user small {
  font-size: 10px;
}
.record-content {
  overflow-wrap: anywhere;
}
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
.select-empty {
  min-height: 330px;
  padding: 18px;
  border: 1px dashed var(--el-border-color);
  border-radius: 10px;
}
@media (max-width: 850px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 620px) {
  .filters,
  .viewer-header {
    align-items: stretch;
    flex-direction: column;
  }
  .history-row {
    grid-template-columns: 65px 110px auto;
  }
  .record-content {
    grid-column: 1 / -1;
  }
}
</style>
