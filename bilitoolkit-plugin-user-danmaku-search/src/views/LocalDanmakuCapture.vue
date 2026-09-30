<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { PluginPageContent } from 'bilitoolkit-ui'
import {
  activeSession,
  captureError,
  captureRootDir,
  captureState,
  loadCaptureSessions,
  popularity,
  recentRecords,
  startCapture,
  stopCapture,
} from '@/services/local-capture'
import type { LocalCaptureTargetType } from '@/types/danmaku'

const targetType = ref<LocalCaptureTargetType>('uid')
const targetValue = ref('')
const targetFilterUid = ref('')
const loading = ref(false)
const keyword = ref('')

const filteredRecords = computed(() => {
  const value = keyword.value.trim().toLocaleLowerCase()
  if (!value) return recentRecords.value
  return recentRecords.value.filter((record) =>
    `${record.uname} ${record.content}`.toLocaleLowerCase().includes(value),
  )
})

const stateLabel: Record<typeof captureState.value, string> = {
  idle: '未采集',
  resolving: '正在解析目标',
  connecting: '正在连接',
  connected: '已连接',
  reconnecting: '正在重连',
  stopping: '正在保存',
  error: '连接异常',
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function formatCount(value: number) {
  return value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : String(value)
}

function showError(message: string) {
  ElMessage({ message, type: 'error', duration: 0, showClose: true })
}

async function begin() {
  if (!targetValue.value.trim()) {
    showError(targetType.value === 'uid' ? '请输入主播 UID' : '请输入直播间号')
    return
  }
  if (targetType.value === 'user' && !targetFilterUid.value.trim()) {
    showError('请输入要过滤的用户 UID')
    return
  }
  loading.value = true
  try {
    await startCapture(targetType.value, targetValue.value, targetType.value === 'user' ? targetFilterUid.value : undefined)
    ElMessage.success('已开始采集，弹幕会持续保存到本地')
  } catch (error) {
    showError(error instanceof Error ? error.message : '启动采集失败')
  } finally {
    loading.value = false
  }
}

async function stop() {
  loading.value = true
  try {
    await stopCapture()
    ElMessage.success('采集已停止，记录已保存')
  } catch (error) {
    showError(error instanceof Error ? error.message : '保存采集记录失败')
  } finally {
    loading.value = false
  }
}

async function openFolder() {
  if (captureRootDir.value) await window.toolkitApi.system.showItemInFolder(captureRootDir.value)
}

onMounted(() => {
  void loadCaptureSessions()
})
</script>

<template>
  <PluginPageContent>
    <div class="page">
      <section class="hero">
        <div>
          <h2>本地弹幕采集</h2>
          <p>连接 Bilibili 直播间，实时接收弹幕并以本地 JSONL 文件保存。</p>
        </div>
        <el-button link @click="openFolder">打开保存目录</el-button>
      </section>

      <section class="control-card">
        <div class="control-title">
          <div>
            <h3>选择采集目标</h3>
            <p>可以按主播 UID 找到直播间，也可以采集指定房间或只保存某位用户的发言。</p>
          </div>
          <el-tag v-if="activeSession" :type="captureState === 'error' ? 'danger' : 'success'" effect="dark">
            {{ stateLabel[captureState] }}
          </el-tag>
        </div>
        <el-radio-group v-model="targetType" :disabled="!!activeSession || loading">
          <el-radio-button value="uid">主播 UID 对应直播间</el-radio-button>
          <el-radio-button value="room">直播间号采集</el-radio-button>
          <el-radio-button value="user">指定用户弹幕过滤</el-radio-button>
        </el-radio-group>
        <div class="input-row">
          <el-input
            v-model="targetValue"
            :disabled="!!activeSession || loading"
            inputmode="numeric"
            clearable
            :placeholder="targetType === 'uid' ? '输入主播 UID，例如 514536602' : '输入直播间号，例如 1931027476'"
            @keyup.enter="begin"
          >
            <template #prepend>{{ targetType === 'uid' ? '主播 UID' : '房间号' }}</template>
          </el-input>
          <el-input
            v-if="targetType === 'user'"
            v-model="targetFilterUid"
            :disabled="!!activeSession || loading"
            inputmode="numeric"
            clearable
            placeholder="输入要过滤的用户 UID"
            @keyup.enter="begin"
          >
            <template #prepend>用户 UID</template>
          </el-input>
          <el-button v-if="!activeSession" type="primary" :loading="loading" @click="begin">开始采集</el-button>
          <el-button v-else type="danger" :loading="loading" @click="stop">停止并保存</el-button>
        </div>
        <el-alert
          title="采集只接收公开直播弹幕，不需要额外配置 FFmpeg 或登录 Cookie。请遵守 Bilibili 服务条款，并合理控制采集时长。"
          type="info"
          :closable="false"
          show-icon
        />
      </section>

      <section v-if="activeSession" class="active-card">
        <div class="active-header">
          <div class="anchor">
            <img v-if="activeSession.anchorFace" :src="activeSession.anchorFace" alt="主播头像" />
            <div>
              <strong>{{ activeSession.anchorName }}</strong>
              <span>
                房间 {{ activeSession.roomId }} · {{ activeSession.title }}
                <template v-if="activeSession.filterUid">
                  · 仅保存 {{ activeSession.filterUserName || `UID ${activeSession.filterUid}` }} 的弹幕
                </template>
              </span>
            </div>
          </div>
          <div class="live-stats">
            <span><b>{{ activeSession.messageCount }}</b> 条弹幕</span>
            <span><b>{{ formatCount(popularity) }}</b> 人气</span>
            <span>开始于 {{ formatTime(activeSession.startedAt) }}</span>
          </div>
        </div>
        <el-alert v-if="captureError" :title="captureError" type="error" :closable="false" show-icon />
        <div class="stream-toolbar">
          <span>最近 {{ recentRecords.length }} 条</span>
          <el-input v-model="keyword" clearable placeholder="筛选主播或弹幕内容" />
        </div>
        <div class="record-list">
          <div v-for="record in filteredRecords" :key="`${record.ts}-${record.uid}-${record.content}`" class="record-row">
            <span class="record-time">{{ formatTime(record.ts) }}</span>
            <span class="record-user">{{ record.uname }}</span>
            <el-tag v-if="record.medalName" size="small" effect="plain">
              {{ record.medalName }} {{ record.medalLevel }}
            </el-tag>
            <span class="record-content">{{ record.content }}</span>
          </div>
          <el-empty v-if="filteredRecords.length === 0" description="等待弹幕进入" :image-size="70" />
        </div>
      </section>

      <section class="info-card">
        <h3>采集说明</h3>
        <div class="tips">
          <span>连接断开时会自动重连，手动停止后才会结束当前会话。</span>
          <span>记录文件位于插件目录的 captures 文件夹，可在“本地弹幕记录”中打开。</span>
          <span>关闭插件窗口不会删除已写入的数据；下次打开会将未结束会话标记为已中断。</span>
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
.hero,
.control-card,
.active-card,
.info-card {
  max-width: 980px;
  margin: 0 auto 16px;
}
.hero,
.control-title,
.active-header,
.stream-toolbar {
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
.tips,
.anchor span,
.live-stats {
  color: var(--el-text-color-secondary);
}
.control-card,
.active-card,
.info-card {
  padding: 18px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--el-bg-color);
}
.control-title {
  align-items: flex-start;
  margin-bottom: 16px;
}
.control-title h3,
.info-card h3 {
  margin-bottom: 6px;
}
.input-row {
  display: flex;
  gap: 10px;
  margin: 16px 0;
}
.input-row .el-input {
  flex: 1;
}
.active-card {
  background: linear-gradient(135deg, var(--el-bg-color), var(--el-fill-color-lighter));
}
.anchor {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.anchor img {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  object-fit: cover;
}
.anchor div {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.anchor span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.live-stats {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 12px;
  font-size: 12px;
  text-align: right;
}
.live-stats b {
  color: var(--el-color-primary);
  font-size: 16px;
}
.active-card > .el-alert {
  margin-top: 14px;
}
.stream-toolbar {
  margin: 14px 0 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.stream-toolbar .el-input {
  width: 260px;
}
.record-list {
  max-height: 390px;
  overflow-y: auto;
  border-top: 1px solid var(--el-border-color-lighter);
}
.record-row {
  display: grid;
  grid-template-columns: 78px 130px auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 13px;
}
.record-time {
  color: var(--el-text-color-secondary);
}
.record-user {
  overflow: hidden;
  color: var(--el-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.record-content {
  overflow-wrap: anywhere;
}
.tips {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
@media (max-width: 720px) {
  .input-row,
  .active-header {
    align-items: stretch;
    flex-direction: column;
  }
  .live-stats {
    justify-content: flex-start;
    text-align: left;
  }
  .stream-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .stream-toolbar .el-input {
    width: 100%;
  }
  .record-row {
    grid-template-columns: 70px 100px auto;
  }
  .record-content {
    grid-column: 1 / -1;
  }
}
</style>
