<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import {
  collectLiveGifts,
  collectLiveSessions,
  collectReceived,
  loadLiveBase,
  type QuerySnapshot,
} from '../services/anchor-query'

const props = defineProps<{ account: { uid: string; name: string; face: string } | null }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
type DataKind = 'received' | 'sessions' | 'live-gifts' | 'live-base'
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' })
const endDate = ref(today.format(new Date()))
const startDate = ref(today.format(new Date(Date.now() - 29 * 86400000)))
const mode = ref<'received' | 'sessions'>('received')
const activeData = ref<DataKind>('received')
const results = shallowRef<Partial<Record<DataKind, QuerySnapshot>>>({})
const busy = ref(false)
const error = ref('')
const notice = ref('')
const progress = ref({ pages: 0, records: 0 })
const keyword = ref('')
const amountField = ref('')
const minimum = ref('')
const page = ref(1)
const liveId = ref('')
const liveStart = ref('')
const liveEnd = ref('')
let controller: AbortController | null = null
const hiddenField = /cookie|sessdata|csrf|bili_jct|authorization|token|password/i
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !hiddenField.test(key))
        .map(([key, item]) => [key, clean(item)]),
    )
  }
  return value
}
const current = computed(() => results.value[activeData.value])
const records = computed(() => (current.value?.records || []).map((row) => clean(row) as Record<string, unknown>))
const columns = computed(() => [...new Set(records.value.flatMap((row) => Object.keys(row)))])
const numericColumns = computed(() =>
  columns.value.filter((key) =>
    records.value.some((row) => {
      const value = row[key]
      return (
        (typeof value === 'number' || typeof value === 'string') &&
        String(value).trim() !== '' &&
        Number.isFinite(Number(value))
      )
    }),
  ),
)
const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return records.value.filter((row) => {
    if (query && !JSON.stringify(row).toLowerCase().includes(query)) return false
    if (amountField.value && minimum.value !== '') {
      const amount = Number(row[amountField.value])
      if (!Number.isFinite(amount) || amount < Number(minimum.value)) return false
    }
    return true
  })
})
const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 50)))
const visible = computed(() => filtered.value.slice((page.value - 1) * 50, page.value * 50))
const label: Record<DataKind, string> = {
  received: '收到礼物',
  sessions: '直播场次',
  'live-gifts': '本场礼物',
  'live-base': '本场分段数据',
}
const fieldLabels: Record<string, string> = {
  gift_name: '礼物名称',
  gift_num: '礼物数量',
  uname: '用户昵称',
  uid: '用户 UID',
  timestamp: '时间戳',
  time: '时间',
  date: '日期',
  live_id: '直播场次 ID',
  start_time: '开始时间',
  end_time: '结束时间',
  title: '标题',
  coin: '原始币值',
}
const text = (value: unknown) =>
  value === undefined || value === null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const readableTime = (value: string) => {
  const timestamp = Number(value)
  return timestamp > 0
    ? new Date(timestamp > 1e12 ? timestamp : timestamp * 1000).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : value || '尚未选择'
}
watch([keyword, amountField, minimum, activeData], () => {
  page.value = 1
})
watch(activeData, () => {
  amountField.value = ''
  minimum.value = ''
})
watch(mode, (value) => {
  activeData.value = value
  keyword.value = ''
  amountField.value = ''
  minimum.value = ''
})
watch(
  () => props.account?.uid,
  () => {
    controller?.abort()
    results.value = {}
    error.value = ''
    notice.value = ''
    liveId.value = ''
    liveStart.value = ''
    liveEnd.value = ''
    keyword.value = ''
    page.value = 1
  },
)
function cancel() {
  controller?.abort()
}
async function run(kind: DataKind, work: (uid: string, signal: AbortSignal) => Promise<QuerySnapshot>) {
  if (!props.account || busy.value) return
  const uid = props.account.uid
  const active = new AbortController()
  controller = active
  busy.value = true
  emit('busy', true)
  error.value = ''
  notice.value = ''
  progress.value = { pages: 0, records: 0 }
  try {
    const result = await work(uid, active.signal)
    if (controller !== active || props.account?.uid !== uid) return
    results.value = {
      ...results.value,
      [kind]: { ...result, records: result.records.map((row) => clean(row) as Record<string, unknown>) },
    }
    activeData.value = kind
    page.value = 1
    notice.value =
      result.coverage === 'complete' ? '已读取本次查询范围内接口返回的全部页。' : '当前为部分结果，请查看原因后重试。'
  } catch (cause) {
    if (controller === active && props.account?.uid === uid)
      error.value = active.signal.aborted ? '查询已停止。' : cause instanceof Error ? cause.message : '查询失败'
  } finally {
    if (controller === active) {
      controller = null
      busy.value = false
      emit('busy', false)
    }
  }
}
const onProgress = (value: { pages: number; records: number }) => {
  progress.value = value
}
async function queryReceived() {
  await run('received', async (uid, signal) => {
    const cookies = await window.toolkitApi.user.getCookie('bili_jct')
    const csrf = cookies.find((cookie) => cookie.name === 'bili_jct')?.value
    if (!csrf) throw new Error('未取得本人会话的 CSRF 校验值，请重新选择并授权账号。')
    return collectReceived({ uid, startDate: startDate.value, endDate: endDate.value, csrf, signal, onProgress })
  })
}
async function querySessions() {
  await run('sessions', (uid, signal) => collectLiveSessions({ uid, signal, onProgress }))
}
function chooseLive(row: Record<string, unknown>) {
  liveId.value = String(row.live_id ?? row.liveId ?? row.id ?? '')
  liveStart.value = String(row.start_time ?? row.startTime ?? row.start_at ?? '')
  liveEnd.value = String(row.end_time ?? row.endTime ?? row.end_at ?? '')
}
function timeNumber(value: string) {
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const result = Number(value)
    return result > 1e12 ? Math.floor(result / 1000) : result
  }
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value
  return Math.floor(new Date(iso).getTime() / 1000)
}
async function queryLive(kind: 'live-gifts' | 'live-base') {
  const startTime = timeNumber(liveStart.value),
    endTime = timeNumber(liveEnd.value)
  if (!liveId.value || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
    error.value = '请先选择包含有效开始、结束时间的直播场次。'
    return
  }
  await run(kind, async (uid, signal) => {
    if (kind === 'live-gifts')
      return collectLiveGifts({ uid, liveId: liveId.value, startTime, endTime, signal, onProgress })
    const result = await loadLiveBase({ liveId: liveId.value, startTime, endTime, signal })
    return { uid, kind, records: [result], updatedAt: new Date().toISOString(), coverage: 'complete', pages: 1 }
  })
}
async function exportData(format: 'csv' | 'json') {
  if (!current.value || !props.account || current.value.uid !== props.account.uid) return
  error.value = ''
  try {
    const cell = (value: unknown) => {
      let valueText = text(value)
      if (/^[=+\-@\t\r]/.test(valueText)) valueText = "'" + valueText
      return '"' + valueText.replace(/"/g, '""') + '"'
    }
    const content =
      format === 'json'
        ? JSON.stringify(
            {
              ...current.value,
              records: filtered.value,
              filters: { keyword: keyword.value, amountField: amountField.value, minimum: minimum.value },
            },
            null,
            2,
          )
        : '\ufeff' +
          [
            columns.value.map(cell).join(','),
            ...filtered.value.map((row) => columns.value.map((key) => cell(row[key])).join(',')),
          ].join('\r\n')
    const filename = `${label[activeData.value]}-${props.account.uid}-${Date.now()}.${format}`
    await window.toolkitApi.file.write(filename, new TextEncoder().encode(content), false)
    notice.value = `已导出当前筛选的 ${filtered.value.length} 条记录。`
    await window.toolkitApi.system.showItemInPluginFolder(filename)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '导出失败'
  }
}
onBeforeUnmount(() => {
  cancel()
  emit('busy', false)
})
</script>

<template>
  <section class="anchor-queries">
    <div class="intro">
      <h2>本人主播数据</h2>
      <p>
        使用本人账号的主播权限查询收到礼物、近期直播场次和本场数据。未开播或无权限时，接口可能返回空列表或权限提示。
      </p>
    </div>
    <div v-if="!account" class="message">请先在页面顶部选择并授权本人账号。</div>
    <nav aria-label="主播数据类型" class="tabs">
      <button :aria-pressed="mode === 'received'" :disabled="busy" @click="mode = 'received'">收到礼物</button>
      <button :aria-pressed="mode === 'sessions'" :disabled="busy" @click="mode = 'sessions'">直播场次与明细</button>
    </nav>
    <div v-if="mode === 'received'" class="query-form panel">
      <label>开始日期<input v-model="startDate" type="date" :disabled="busy" /></label>
      <label>结束日期<input v-model="endDate" type="date" :disabled="busy" /></label>
      <button :disabled="!account || busy" @click="queryReceived">查询收到礼物</button>
      <p>每次最多查询 31 天，可选择更早的日期区间。显示的是接口原始字段与单位，不合并为人民币收入。</p>
    </div>
    <div v-else class="panel query-form">
      <button :disabled="!account || busy" @click="querySessions">查询近期直播场次</button>
      <p>按原程序查询近期 7 天直播场次；选择场次后可查看礼物明细与本场分段数据。</p>
      <div v-if="liveId" class="selected-live">
        <strong>已选场次 {{ liveId }}</strong>
        <span>{{ readableTime(liveStart) }} — {{ readableTime(liveEnd) }}</span>
        <button :disabled="!account || busy" @click="queryLive('live-gifts')">查询本场礼物</button>
        <button :disabled="!account || busy" @click="queryLive('live-base')">查看本场分段数据</button>
      </div>
    </div>
    <div v-if="busy" class="message" role="status">
      正在查询，已读取 {{ progress.pages }} 页、{{ progress.records }} 条记录。<button @click="cancel">停止</button>
    </div>
    <div v-if="error" class="message error" role="alert">{{ error }}</div>
    <div v-if="notice" class="message" role="status">{{ notice }}</div>
    <div v-if="mode === 'sessions' && Object.keys(results).some((key) => key !== 'received')" class="tabs">
      <button
        v-for="kind in ['sessions', 'live-gifts', 'live-base'] as const"
        :key="kind"
        :disabled="!results[kind] || busy"
        :aria-pressed="activeData === kind"
        @click="activeData = kind"
      >
        {{ label[kind] }}
      </button>
    </div>
    <section v-if="current" class="panel results">
      <div class="result-head">
        <h3>{{ label[activeData] }} · {{ filtered.length }} 条</h3>
        <span>{{ current.coverage === 'complete' ? '已遍历本次返回范围' : '部分结果' }} · {{ current.pages }} 页</span>
      </div>
      <div v-if="current.warning" class="message warning">{{ current.warning }}</div>
      <div class="filters">
        <label>搜索<input v-model="keyword" placeholder="按当前返回字段筛选" /></label>
        <label
          >数值筛选字段<select v-model="amountField">
            <option value="">不筛选</option>
            <option v-for="field in numericColumns" :key="field" :value="field">
              {{ fieldLabels[field] || field }}
            </option>
          </select></label
        >
        <label>最小值（接口原始单位）<input v-model="minimum" type="number" :disabled="!amountField" /></label>
        <button class="secondary" :disabled="!filtered.length" @click="exportData('csv')">导出 CSV</button>
        <button class="secondary" :disabled="!filtered.length" @click="exportData('json')">导出 JSON</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th v-if="activeData === 'sessions'">选择</th>
              <th v-for="column in columns" :key="column">{{ fieldLabels[column] || column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in visible" :key="index">
              <td v-if="activeData === 'sessions'">
                <button class="secondary" :disabled="busy" @click="chooseLive(row)">选择场次</button>
              </td>
              <td v-for="column in columns" :key="column">
                <span :title="text(row[column])">{{ text(row[column]) }}</span>
              </td>
            </tr>
            <tr v-if="!visible.length">
              <td :colspan="Math.max(1, columns.length + (activeData === 'sessions' ? 1 : 0))">本次范围内暂无记录。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <button class="secondary" :disabled="page <= 1" @click="page--">上一页</button
        ><span>{{ page }} / {{ totalPages }}</span
        ><button class="secondary" :disabled="page >= totalPages" @click="page++">下一页</button>
      </div>
      <p class="note">“遍历完成”仅针对接口当次返回的范围。直播分段数据只用于查看统计，不下载回放视频。</p>
    </section>
  </section>
</template>

<style scoped>
.anchor-queries {
  color: var(--ink);
}
h2,
h3,
p {
  margin: 0;
}
.intro {
  margin: 18px 0;
}
.intro p,
.note,
.query-form > p {
  color: var(--muted);
  font-size: 12px;
}
.intro p {
  margin-top: 6px;
}
.panel {
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
  margin: 14px 0;
}
.tabs,
.query-form,
.filters,
.selected-live,
.result-head,
.pagination {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: end;
}
.query-form > p,
.selected-live {
  width: 100%;
}
.selected-live {
  align-items: center;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.selected-live span {
  color: var(--muted);
  font-size: 12px;
}
.result-head {
  align-items: center;
  justify-content: space-between;
}
.result-head span {
  font-size: 12px;
  color: var(--muted);
}
.filters {
  margin: 18px 0;
}
label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 11px;
  color: var(--muted);
}
button,
input,
select {
  font: inherit;
}
button {
  background: var(--accent);
  color: white;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 7px 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
button.secondary,
.tabs button {
  background: var(--surface);
  color: var(--ink);
  border-color: var(--line);
}
.tabs button[aria-pressed='true'] {
  color: var(--accent);
  border-color: var(--accent);
}
input,
select {
  box-sizing: border-box;
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 9px;
  min-width: 145px;
}
.message {
  border: 1px solid var(--line);
  color: var(--muted);
  padding: 10px 14px;
  border-radius: 8px;
  margin: 12px 0;
  overflow-wrap: anywhere;
}
.message button {
  margin-left: 12px;
}
.error {
  color: #bf4b50;
  border-color: #db9395;
}
.warning {
  color: #ab7b30;
  border-color: #dfc18e;
}
.table-scroll {
  overflow: auto;
}
table {
  border-collapse: collapse;
  font-size: 12px;
  width: 100%;
}
th,
td {
  padding: 10px;
  text-align: left;
  border-bottom: 1px solid var(--line);
}
th {
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
td > span {
  display: block;
  max-width: 320px;
  max-height: 100px;
  overflow: auto;
  overflow-wrap: anywhere;
}
.pagination {
  align-items: center;
  justify-content: end;
  margin-top: 14px;
}
.note {
  margin-top: 15px;
}
@media (max-width: 600px) {
  .panel {
    padding: 12px;
  }
  label {
    flex: 1 1 145px;
  }
  input,
  select {
    width: 100%;
    min-width: 0;
  }
}
</style>
