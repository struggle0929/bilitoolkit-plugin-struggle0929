<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ElOption, ElSelect } from 'element-plus'
import type { ConsumptionRecord } from '../types/consumption'
import AnchorQueries from './AnchorQueries.vue'
import { parseAmount, recordsToCsv } from '../services/consumption-core'
import { buildBlindOptions, reconcileBlindRecords } from '../services/blind-options'
import { buildSynthesisOptions, withinSynthesisWindow, type SynthesisOption } from '../services/synthesis-options'
import type { SelectionMetadata } from '../services/selection-metadata'
import { summarizeBlindDistribution } from '../services/blind-distribution'
import {
  collectBlindRecords,
  loadBagInventory,
  loadBlindConfig,
  loadRewardCatalog,
  type BagRecord,
  type BlindRecord,
  type BlindSnapshot,
} from '../services/extended-query'

const props = defineProps<{
  account: { uid: string; name: string; face: string } | null
  records: ConsumptionRecord[]
  selectionMetadata: SelectionMetadata
  optionsBusy: boolean
  optionsWarning: string
}>()
const emit = defineEmits<{ busy: [value: boolean]; 'select-account': []; 'refresh-options': [] }>()
const tab = ref<'blind' | 'synthesis' | 'rewards' | 'bag' | 'anchor'>('blind')
const tabs = [
  { id: 'blind', name: '盲盒记录' },
  { id: 'synthesis', name: '合成分析' },
  { id: 'rewards', name: '其他奖励' },
  { id: 'bag', name: '当前包裹' },
  { id: 'anchor', name: '主播查询' },
] as const
const catalog = computed(() => props.selectionMetadata.gifts)
const catalogLoading = computed(() => props.optionsBusy)
const catalogError = computed(() => props.optionsWarning)
const failedIcons = ref(new Set<string>())
const blind = shallowRef<BlindSnapshot | null>(null)
const bag = shallowRef<BagRecord[]>([])
const bagUpdatedAt = ref('')
const rewardCatalog = shallowRef<{ guardIds: string[]; redPacketIds: string[]; warnings: string[] } | null>(null)
const boxId = ref('32251')
const busy = ref('')
const anchorBusy = ref(false)
const message = ref('')
const error = ref('')
const progress = ref({ pages: 0, records: 0 })
const anchorId = ref('')
const startDate = ref('')
const endDate = ref('')
const keyword = ref('')
const page = ref(1)
const activityName = ref('玲珑宝斋')
const selectedActivityId = ref('玲珑宝斋')
const materialNames = ref('玲珑宝斋-锦囊\n玲珑宝斋-瓷瓶\n玲珑宝斋-银盒\n玲珑宝斋-云锦\n玲珑宝斋-玉函')
const productNames = ref('相识玉扣\n常伴珠钗\n缘起瓷瓶\n倾心宝冠\n万象天衣')
const rewardType = ref('all')
let controller: AbortController | null = null
let cacheSequence = 0
const fmt = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const dateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
const timeText = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const cacheKey = (uid: string, id: string) => `blind-records-${uid}-${id}`
const boxOptions = computed(() => buildBlindOptions(catalog.value, props.records, boxId.value))
const selectedBox = computed(() => boxOptions.value.find((item) => item.id === boxId.value))
const synthesisOptions = computed(() =>
  buildSynthesisOptions(props.selectionMetadata.activities, props.records, catalog.value),
)
const selectedActivity = computed(() => synthesisOptions.value.find((item) => item.id === selectedActivityId.value))
function activityDateText(activity: SynthesisOption) {
  if (activity.sortTimestamp === undefined) return '日期未知'
  const date = dateFormatter.format(new Date(activity.sortTimestamp * 1000))
  return (activity.dateSource === 'record' ? '最近记录 ' : '配置日期 ') + date
}
function chooseActivity(id: string) {
  selectedActivityId.value = id
  const activity = props.selectionMetadata.activities.find((item) => item.id === id)
  activityName.value = activity?.name || '自定义活动'
  materialNames.value = activity?.materials.join('\n') || ''
  productNames.value = activity?.products.join('\n') || ''
  page.value = 1
}
function loadBoxOptions(force = false) {
  if (catalogLoading.value || !props.account) return
  if (force || !props.selectionMetadata.catalogUpdatedAt || !props.selectionMetadata.activitiesUpdatedAt)
    emit('refresh-options')
}
function handleBoxVisibility(visible: boolean) {
  if (visible) void loadBoxOptions()
}
const selectedRecords = computed(() => (tab.value === 'blind' ? blind.value?.records || [] : props.records))
const anchors = computed(() => {
  const map = new Map<string, string>()
  for (const row of selectedRecords.value) if (row.anchorId) map.set(row.anchorId, row.anchorName)
  return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
})
function matches(row: { timestamp: number; anchorId: string; anchorName: string; giftName: string }) {
  const start = startDate.value ? Date.parse(`${startDate.value}T00:00:00+08:00`) / 1000 : -Infinity
  const end = endDate.value ? Date.parse(`${endDate.value}T23:59:59+08:00`) / 1000 : Infinity
  const query = keyword.value.trim().toLowerCase()
  return (
    row.timestamp >= start &&
    row.timestamp <= end &&
    (!anchorId.value || row.anchorId === anchorId.value) &&
    (!query || `${row.giftName} ${row.anchorName} ${row.anchorId}`.toLowerCase().includes(query))
  )
}
const blindRecords = computed(() => (blind.value?.records || []).filter(matches))
const blindComparison = computed(() => (blind.value ? reconcileBlindRecords(blind.value, props.records) : null))
function rangeText(range: { start: number; end: number } | null) {
  return range
    ? `${dateFormatter.format(new Date(range.start * 1000))} — ${dateFormatter.format(new Date(range.end * 1000))}`
    : '暂无记录'
}
const blindMeta = computed(() => new Map(blind.value?.config.gifts.map((gift) => [gift.id, gift]) || []))
const blindStats = computed(() => {
  const gifts = new Map<string, { id: string; name: string; count: number; value: number; known: boolean }>()
  let count = 0,
    value = 0,
    unknown = 0
  for (const row of blindRecords.value) {
    const meta = blindMeta.value.get(row.giftId)
    const current = gifts.get(row.giftId) || { id: row.giftId, name: row.giftName, count: 0, value: 0, known: !!meta }
    current.count += row.giftNum
    current.value += (meta?.price || 0) * row.giftNum
    gifts.set(row.giftId, current)
    count += row.giftNum
    value += (meta?.price || 0) * row.giftNum
    if (!meta) unknown += row.giftNum
  }
  const cost = count * (blind.value?.config.price || 0)
  return {
    count,
    value,
    cost,
    unknown,
    costKnown: blind.value?.config.priceKnown !== false && !!blind.value?.config.price,
    difference: value - cost,
    gifts: [...gifts.values()].sort((a, b) => b.value - a.value),
  }
})
const blindRows = computed(() => blindRecords.value.slice((page.value - 1) * 50, page.value * 50))
const blindDistribution = computed(() => summarizeBlindDistribution(blindRecords.value))
const blindPieStyle = computed(() => {
  let offset = 0
  const segments = blindDistribution.value.gifts.map((gift) => {
    const start = offset
    offset += gift.percentage
    return `${gift.color} ${start}% ${offset}%`
  })
  return { background: segments.length ? `conic-gradient(${segments.join(',')})` : 'var(--line)' }
})
const percentageText = (value: number) => (value > 0 && value < 0.1 ? '<0.1%' : `${Number(value.toFixed(1))}%`)
const blindPages = computed(() => Math.max(1, Math.ceil(blindRecords.value.length / 50)))
const filteredPayRecords = computed(() => props.records.filter(matches))
const rewardIds = computed(
  () => new Set([...(rewardCatalog.value?.guardIds || []), ...(rewardCatalog.value?.redPacketIds || [])]),
)
const rewardRows = computed(() =>
  filteredPayRecords.value.filter((row) => {
    if (row.isRefunded || !rewardIds.value.has(row.giftId)) return false
    return (
      rewardType.value === 'all' ||
      (rewardType.value === 'guard'
        ? rewardCatalog.value?.guardIds.includes(row.giftId)
        : rewardCatalog.value?.redPacketIds.includes(row.giftId))
    )
  }),
)
function faceValue(row: ConsumptionRecord) {
  const raw = row.raw.coin
  try {
    if (raw !== undefined && raw !== null && raw !== '') return parseAmount(raw)
  } catch {
    /* Unsupported legacy amounts remain unknown rather than guessed. */
  }
  const gift = catalog.value.find((item) => item.id === row.giftId)
  return gift ? gift.price * row.giftNum : null
}
function dayStats(rows: ConsumptionRecord[]) {
  const days = [...new Set(rows.map((row) => dateFormatter.format(new Date(row.timestamp * 1000))))].sort()
  let streak = 0,
    longest = 0,
    previous = 0,
    rolling365 = 0,
    left = 0
  const times = days.map((day) => Date.parse(`${day}T00:00:00+08:00`))
  for (const [index, current] of times.entries()) {
    streak = current - previous === 86400000 ? streak + 1 : 1
    longest = Math.max(longest, streak)
    previous = current
    while (current - times[left]! > 365 * 86400000) left++
    rolling365 = Math.max(rolling365, index - left + 1)
  }
  return { days: days.length, longest, rolling365 }
}
const rewardStats = computed(() => ({
  count: rewardRows.value.reduce((sum, row) => sum + row.giftNum, 0),
  value: rewardRows.value.reduce((sum, row) => sum + (faceValue(row) || 0), 0),
  unknown: rewardRows.value.filter((row) => faceValue(row) === null).length,
}))
const activityStats = computed(() => dayStats(filteredPayRecords.value.filter((row) => !row.isRefunded)))
const materials = computed(() =>
  materialNames.value
    .split(/[\n,，]/)
    .map((name) => name.trim())
    .filter(Boolean),
)
const products = computed(() =>
  productNames.value
    .split(/[\n,，]/)
    .map((name) => name.trim())
    .filter(Boolean),
)
const synthesisRows = computed(() =>
  filteredPayRecords.value.filter(
    (row) =>
      !row.isRefunded &&
      (!selectedActivity.value ||
        withinSynthesisWindow(row, { ...selectedActivity.value, products: products.value })) &&
      ((!row.isBag && row.netBattery > 0 && materials.value.some((name) => row.giftName.includes(name))) ||
        (row.isBag && !rewardIds.value.has(row.giftId) && products.value.some((name) => row.giftName.includes(name)))),
  ),
)
const synthesisStats = computed(() => ({
  cost: synthesisRows.value.reduce((sum, row) => sum + (!row.isBag ? row.netBattery : 0), 0),
  value: synthesisRows.value.reduce((sum, row) => sum + (row.isBag ? faceValue(row) || 0 : 0), 0),
  unknown: synthesisRows.value.filter((row) => row.isBag && faceValue(row) === null).length,
  count: synthesisRows.value.filter((row) => row.isBag).reduce((sum, row) => sum + row.giftNum, 0),
}))
const matchingBag = computed(() => bag.value.filter((row) => products.value.some((name) => row.name.includes(name))))
const matchingBagValue = computed(() => matchingBag.value.reduce((sum, row) => sum + row.price * row.count, 0))
const visibleBag = computed(() =>
  bag.value.filter((row) => !keyword.value || `${row.name} ${row.id} ${row.lockedText}`.includes(keyword.value.trim())),
)
const detailRows = computed(() =>
  (tab.value === 'synthesis' ? synthesisRows.value : rewardRows.value).slice((page.value - 1) * 50, page.value * 50),
)
const detailCount = computed(() => (tab.value === 'synthesis' ? synthesisRows.value.length : rewardRows.value.length))
const detailPages = computed(() => Math.max(1, Math.ceil(detailCount.value / 50)))
function stop() {
  controller?.abort()
}
function resetViewFilters() {
  anchorId.value = ''
  startDate.value = ''
  endDate.value = ''
  keyword.value = ''
}
async function restoreBlind() {
  const sequence = ++cacheSequence
  const uid = props.account?.uid,
    id = boxId.value
  blind.value = null
  if (!uid || !/^\d+$/.test(id) || typeof window.toolkitApi === 'undefined') return
  try {
    const saved = await window.toolkitApi.db.init<BlindSnapshot>(cacheKey(uid, id))
    if (
      sequence === cacheSequence &&
      props.account?.uid === uid &&
      boxId.value === id &&
      saved?.uid === uid &&
      saved.boxId === id &&
      Array.isArray(saved.records) &&
      saved.config?.id === id
    )
      blind.value = saved
  } catch {
    if (sequence === cacheSequence) message.value = '本地盲盒缓存不可用，可重新查询。'
  }
}
async function run(label: string, task: (signal: AbortSignal, uid: string) => Promise<void>) {
  if (busy.value || !props.account) return
  const uid = props.account.uid,
    current = new AbortController()
  controller = current
  busy.value = label
  error.value = ''
  message.value = ''
  try {
    await task(current.signal, uid)
  } catch (cause) {
    if (props.account?.uid === uid && controller === current)
      error.value = current.signal.aborted ? '查询已停止。' : cause instanceof Error ? cause.message : '查询失败'
  } finally {
    if (controller === current) {
      controller = null
      busy.value = ''
    }
  }
}
async function queryBlind() {
  const id = boxId.value
  await run('正在查询盲盒', async (signal, uid) => {
    cacheSequence++
    progress.value = { pages: 0, records: 0 }
    let config,
      configWarning = ''
    try {
      config = await loadBlindConfig(id, signal)
    } catch (cause) {
      if (signal.aborted || /登录|账号/.test(String(cause))) throw cause
      const gift = catalog.value.find((item) => item.id === id)
      config = { id, name: gift?.name || `盲盒 ${id}`, price: gift?.price || 0, priceKnown: !!gift?.price, gifts: [] }
      configWarning = '盲盒配置不可用，仍已尝试读取开奖记录；未识别的价格显示为未知。'
    }
    const result = await collectBlindRecords({
      uid,
      boxId: id,
      config,
      signal,
      onProgress: (value) => {
        progress.value = value
      },
    })
    if (props.account?.uid !== uid || boxId.value !== id) return
    if (configWarning) result.warning = [configWarning, result.warning].filter(Boolean).join('；')
    blind.value = result
    page.value = 1
    try {
      await window.toolkitApi.db.write(cacheKey(uid, id), result)
      message.value = '已保存本人账号的盲盒记录。'
    } catch {
      message.value = '记录已显示，但缓存保存失败，请先导出。'
    }
  })
}
async function queryCatalog() {
  await loadBoxOptions(true)
}
async function queryBag() {
  await run('正在读取当前包裹', async (signal, uid) => {
    const result = await loadBagInventory(signal)
    if (props.account?.uid !== uid) return
    bag.value = result
    bagUpdatedAt.value = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  })
}
async function queryRewards() {
  await run('正在读取奖励分类', async (signal, uid) => {
    const result = await loadRewardCatalog(signal)
    if (props.account?.uid === uid) rewardCatalog.value = result
  })
}
function csv(rows: unknown[][]) {
  const cell = (value: unknown) => {
    const text = String(value ?? ''),
      safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return `"${safe.replace(/"/g, '""')}"`
  }
  return '\ufeff' + rows.map((row) => row.map(cell).join(',')).join('\r\n')
}
async function exportData(format: 'csv' | 'json') {
  if (!props.account) return
  error.value = ''
  try {
    let content: string
    const filters = {
      startDate: startDate.value,
      endDate: endDate.value,
      anchorId: anchorId.value,
      keyword: keyword.value,
    }
    if (tab.value === 'blind') {
      if (!blind.value) return
      content =
        format === 'json'
          ? JSON.stringify({ ...blind.value, records: blindRecords.value, filters }, null, 2)
          : csv([
              [
                '时间（北京时间）',
                '主播UID',
                '主播',
                '盲盒ID',
                '盲盒',
                '礼物ID',
                '礼物',
                '数量',
                '当前配置单价（电池面值）',
              ],
              ...blindRecords.value.map((row: BlindRecord) => [
                timeText(row.timestamp),
                row.anchorId,
                row.anchorName,
                row.originalGiftId,
                row.originalGiftName,
                row.giftId,
                row.giftName,
                row.giftNum,
                blindMeta.value.get(row.giftId)?.price ?? '未知',
              ]),
            ])
    } else if (tab.value === 'bag') {
      content =
        format === 'json'
          ? JSON.stringify(
              { uid: props.account.uid, updatedAt: bagUpdatedAt.value, records: visibleBag.value },
              null,
              2,
            )
          : csv([
              ['礼物ID', '礼物', '数量', '单价（电池面值）', '使用限制', '到期时间'],
              ...visibleBag.value.map((row) => [
                row.id,
                row.name,
                row.count,
                row.price,
                row.lockedText,
                row.expireAt ? timeText(row.expireAt) : '接口未提供',
              ]),
            ])
    } else {
      const records = tab.value === 'synthesis' ? synthesisRows.value : rewardRows.value
      content =
        format === 'json'
          ? JSON.stringify(
              {
                uid: props.account.uid,
                records,
                filters,
                classification: tab.value,
                inferred: tab.value === 'synthesis',
                ...(tab.value === 'synthesis'
                  ? {
                      activity: {
                        id: selectedActivityId.value,
                        name: activityName.value,
                        materials: materials.value,
                        products: products.value,
                        startTime: selectedActivity.value?.startTime,
                        endTime: selectedActivity.value?.endTime,
                      },
                    }
                  : {}),
              },
              null,
              2,
            )
          : recordsToCsv(records)
    }
    const name = `直播账单-${tab.value}-${props.account.uid}-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`
    await window.toolkitApi.file.write(name, new TextEncoder().encode(content), false)
    message.value = `已导出当前筛选：${name}`
    await window.toolkitApi.system.showItemInPluginFolder(name)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '导出失败'
  }
}
watch(
  () => props.account?.uid,
  () => {
    stop()
    controller = null
    busy.value = ''
    bag.value = []
    bagUpdatedAt.value = ''
    rewardCatalog.value = null
    anchorId.value = ''
    error.value = ''
    message.value = ''
    restoreBlind()
  },
  { immediate: true },
)
watch(boxId, () => {
  page.value = 1
  restoreBlind()
})
watch([tab, anchorId, startDate, endDate, keyword, rewardType, materialNames, productNames], () => {
  page.value = 1
})
watch([busy, anchorBusy], ([value, childBusy]) => emit('busy', !!value || childBusy))
watch(
  () => props.selectionMetadata.activities,
  (activities, previous) => {
    const old = previous.find((item) => item.id === selectedActivityId.value)
    if (
      old &&
      activityName.value === old.name &&
      materialNames.value === old.materials.join('\n') &&
      productNames.value === old.products.join('\n') &&
      activities.some((item) => item.id === old.id)
    )
      chooseActivity(old.id)
  },
)
onBeforeUnmount(() => {
  stop()
  emit('busy', false)
})
</script>

<template>
  <section class="extended-queries">
    <div class="section-heading">
      <div>
        <h2>更多账单查询</h2>
        <p>盲盒开奖记录与消费流水分别读取；合成和奖励按已取得的数据分析。</p>
        <p class="muted">
          礼物目录：{{
            selectionMetadata.catalogUpdatedAt
              ? new Date(selectionMetadata.catalogUpdatedAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                  hour12: false,
                })
              : '尚未同步'
          }}； 活动规则：{{
            selectionMetadata.activitiesUpdatedAt
              ? new Date(selectionMetadata.activitiesUpdatedAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                  hour12: false,
                })
              : '使用内置规则'
          }}。 消费查询时自动刷新；活动规则来自 B瓜公开配置，更新可能滞后于 B 站。
        </p>
      </div>
    </div>
    <nav class="tabs" aria-label="更多查询页面">
      <button
        v-for="item in tabs"
        :key="item.id"
        :class="{ active: tab === item.id }"
        :disabled="!!busy || anchorBusy"
        @click="tab = item.id"
      >
        {{ item.name }}
      </button>
    </nav>
    <p v-if="!account" class="empty">
      请先选择并授权本人账号。<button class="secondary" @click="emit('select-account')">选择账号</button>
    </p>
    <AnchorQueries v-else-if="tab === 'anchor'" :account="account" @busy="anchorBusy = $event" />
    <template v-else>
      <div class="toolbar">
        <template v-if="tab === 'blind'">
          <label class="blind-box-field" for="blind-box-select"
            >盲盒礼物 ID
            <ElSelect
              id="blind-box-select"
              v-model="boxId"
              class="blind-box-select"
              filterable
              allow-create
              default-first-option
              :disabled="!!busy"
              :loading="catalogLoading"
              placeholder="搜索盲盒名称或输入 ID"
              popper-class="blind-box-menu"
              :popper-style="{ width: 'min(440px, calc(100vw - 32px))' }"
              @visible-change="handleBoxVisibility"
            >
              <template #label>
                <span class="selected-box">
                  <img
                    v-if="selectedBox?.image && !failedIcons.has(selectedBox.id)"
                    :src="selectedBox.image"
                    alt=""
                    @error="failedIcons.add(selectedBox!.id)"
                  />
                  <span>{{ selectedBox?.name || '盲盒' }} · {{ boxId }}</span>
                </span>
              </template>
              <ElOption v-for="item in boxOptions" :key="item.id" :value="item.id" :label="item.name + ' · ' + item.id">
                <div class="blind-box-option">
                  <img
                    v-if="item.image && !failedIcons.has(item.id)"
                    :src="item.image"
                    alt=""
                    loading="lazy"
                    @error="failedIcons.add(item.id)"
                  />
                  <span v-else class="box-icon-fallback" aria-hidden="true">🎁</span>
                  <span class="box-description"
                    ><strong>{{ item.name }}</strong
                    ><small>ID {{ item.id }}</small></span
                  >
                  <span class="box-invested">账单投入 {{ fmt(item.investedCount) }} 个</span>
                </div>
              </ElOption>
              <template #footer
                ><span class="box-menu-note">按已查账单中的付费投入数量降序；不计包裹和已退回记录。</span></template
              >
            </ElSelect>
          </label>
          <button :disabled="!!busy" @click="queryBlind">查询盲盒记录</button>
          <button class="secondary" :disabled="!!busy || catalogLoading" @click="queryCatalog">
            {{ catalogLoading ? '正在加载选项…' : '刷新礼物选项' }}
          </button>
          <span class="muted">可搜索名称或输入已下架盲盒 ID，按回车选择；是否可查以接口返回为准。</span>
        </template>
        <template v-else-if="tab === 'bag'">
          <button :disabled="!!busy" @click="queryBag">查询当前包裹</button
          ><span class="muted">{{ bagUpdatedAt ? '读取于 ' + bagUpdatedAt : '当前库存，不代表历史获得记录。' }}</span>
        </template>
        <template v-else>
          <button class="secondary" :disabled="!!busy" @click="queryRewards">读取天选 / 红包分类</button>
          <button v-if="tab === 'synthesis'" class="secondary" :disabled="!!busy" @click="queryBag">
            读取当前包裹
          </button>
          <button class="secondary" :disabled="!!busy || catalogLoading" @click="queryCatalog">
            刷新活动与礼物选项
          </button>
        </template>
        <button v-if="busy" class="secondary" @click="stop">停止查询</button>
      </div>
      <p v-if="busy" class="notice">
        {{ busy }}<span v-if="busy.includes('盲盒')"> · {{ progress.pages }} 页 / {{ progress.records }} 条</span>
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="catalogError" class="warning" role="alert">{{ catalogError }}</p>
      <p v-if="message" class="notice">{{ message }}</p>
      <p v-if="rewardCatalog?.warnings.length && (tab === 'synthesis' || tab === 'rewards')" class="warning">
        {{ rewardCatalog.warnings.join('；') }}。分类可能不完整。
      </p>
      <div class="filters">
        <template v-if="tab !== 'bag'">
          <label>开始日期<input v-model="startDate" type="date" /></label
          ><label>结束日期<input v-model="endDate" type="date" /></label>
          <label
            >主播<select v-model="anchorId">
              <option value="">全部主播</option>
              <option v-for="anchor in anchors" :key="anchor.id" :value="anchor.id">
                {{ anchor.name }} · {{ anchor.id }}
              </option>
            </select></label
          >
        </template>
        <label>搜索<input v-model="keyword" placeholder="礼物、主播、UID" /></label>
        <label v-if="tab === 'rewards'"
          >奖励类别<select v-model="rewardType">
            <option value="all">全部奖励</option>
            <option value="guard">天选礼物</option>
            <option value="red">红包礼物</option>
          </select></label
        >
        <button class="secondary" @click="resetViewFilters">重置筛选</button>
      </div>
      <template v-if="tab === 'blind'">
        <div v-if="blind" class="panel">
          <div class="section-heading">
            <h3>{{ blind.config.name }} · {{ blind.boxId }}</h3>
            <span :class="blind.coverage === 'complete' ? 'muted' : 'warning'"
              >{{ blind.coverage === 'complete' ? '已遍历当前可返回页' : '部分结果' }} · {{ blind.pages }} 页</span
            >
          </div>
          <p v-if="blind.warning" class="warning">{{ blind.warning }}</p>
          <div
            v-if="blindComparison"
            class="blind-comparison"
            :class="{ 'has-gap': blindComparison.unreturnedQuantity > 0 }"
          >
            <p><strong>两类记录的查询范围（不受下方筛选影响）</strong></p>
            <p>
              消费账单：投入 {{ fmt(blindComparison.ledgerQuantity) }} 个 · {{ rangeText(blindComparison.ledgerRange) }}
            </p>
            <p>
              开奖记录：已取得 {{ fmt(blindComparison.drawQuantity) }} 个 · {{ rangeText(blindComparison.drawRange) }}
            </p>
            <p v-if="blindComparison.unreturnedQuantity > 0" class="warning">
              尚未取得其余
              {{ fmt(blindComparison.unreturnedQuantity) }} 个对应的开奖结果，不能计算全部投入的礼物面值差额。
              “已遍历”仅指当前开奖记录接口返回的页数，不表示覆盖全部消费历史。
            </p>
            <p v-else class="muted">两类接口范围可能不同；数量一致也不能单独证明每笔记录已对应。</p>
          </div>
          <div class="stats">
            <div>
              当前筛选已取得开奖数量<strong>{{ fmt(blindStats.count) }}</strong>
            </div>
            <div>
              已取得开奖的估算成本<strong>{{ blindStats.costKnown ? fmt(blindStats.cost) : '未知' }}</strong>
            </div>
            <div>
              已取得开奖的礼物面值<strong>{{ fmt(blindStats.value) }}</strong>
            </div>
            <div>
              已取得开奖的面值差额<strong>{{
                blindStats.unknown || !blindStats.costKnown ? '未完整识别' : fmt(blindStats.difference)
              }}</strong>
            </div>
          </div>
          <p class="muted">
            单位：电池面值。按开出礼物数量 × 当前盲盒单价（{{
              blindStats.costKnown ? fmt(blind.config.price) : '未知'
            }}）估算成本；仅针对已取得且符合筛选的开奖结果，不包含未取得的历史开奖。
            历史价格、优惠和奖励可能不同，不等于人民币实付或可提现收益。{{
              blindStats.unknown ? '另有 ' + blindStats.unknown + ' 个礼物未找到价格，未计入面值。' : ''
            }}
          </p>
          <section class="blind-distribution" aria-label="已取得开奖的礼物数量统计">
            <div class="section-heading">
              <h3>开出礼物分布</h3>
              <span class="muted">按礼物数量统计 · 当前筛选范围</span>
            </div>
            <div v-if="blindDistribution.total" class="blind-distribution-content">
              <div
                class="blind-donut"
                :style="blindPieStyle"
                role="img"
                :aria-label="'开出礼物数量占比，共 ' + blindDistribution.total + ' 个'"
              >
                <div>
                  <strong>{{ fmt(blindDistribution.total) }}</strong
                  ><span>个礼物</span>
                </div>
              </div>
              <ul class="blind-gift-counts">
                <li v-for="gift in blindDistribution.gifts" :key="gift.id">
                  <i :style="{ background: gift.color }" aria-hidden="true" />
                  <img v-if="gift.image" :src="gift.image" alt="" loading="lazy" />
                  <span class="blind-gift-label">{{ gift.name }}</span>
                  <strong>{{ fmt(gift.count) }} 个</strong
                  ><span class="blind-gift-percentage">{{ percentageText(gift.percentage) }}</span>
                </li>
              </ul>
            </div>
            <p v-else class="empty">当前筛选没有已取得的开奖礼物。</p>
            <p class="muted">
              这是已查到结果的实际数量占比，随日期、主播和搜索筛选变化，不是配置概率；未取得的历史开奖不参与统计。
            </p>
          </section>
          <details>
            <summary>查看礼物配置、概率与当前筛选结果</summary>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>礼物</th>
                    <th>配置单价</th>
                    <th>配置概率（接口原值）</th>
                    <th>开出数量</th>
                    <th>面值合计</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="gift in blind.config.gifts" :key="gift.id">
                    <td>{{ gift.name }}<span v-if="gift.isWin" class="tag">奖励</span></td>
                    <td>{{ fmt(gift.price) }}</td>
                    <td>{{ gift.chance ?? '未提供' }}</td>
                    <td>{{ fmt(blindStats.gifts.find((item) => item.id === gift.id)?.count || 0) }}</td>
                    <td>{{ fmt(blindStats.gifts.find((item) => item.id === gift.id)?.value || 0) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
          <div class="section-heading">
            <h3>开奖记录 · {{ blindRecords.length }} 条</h3>
            <div>
              <button class="secondary" @click="exportData('csv')">导出 CSV</button
              ><button class="secondary" @click="exportData('json')">导出 JSON</button>
            </div>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>主播</th>
                  <th>开出礼物</th>
                  <th>数量</th>
                  <th>当前配置面值</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in blindRows" :key="row.id">
                  <td>{{ timeText(row.timestamp) }}</td>
                  <td>
                    <button class="text-button" @click="anchorId = row.anchorId">{{ row.anchorName }}</button
                    ><small>UID {{ row.anchorId }}</small>
                  </td>
                  <td>{{ row.giftName }}</td>
                  <td>{{ fmt(row.giftNum) }}</td>
                  <td>
                    {{ blindMeta.has(row.giftId) ? fmt(blindMeta.get(row.giftId)!.price * row.giftNum) : '未知' }}
                  </td>
                </tr>
                <tr v-if="!blindRows.length">
                  <td colspan="5" class="empty">当前筛选没有开奖记录。</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <button class="secondary" :disabled="page <= 1" @click="page--">上一页</button>{{ page }} / {{ blindPages
            }}<button class="secondary" :disabled="page >= blindPages" @click="page++">下一页</button>
          </div>
        </div>
        <p v-else class="empty">选择盲盒礼物 ID 后查询。消费流水中的“包裹道具”不是盲盒开奖记录。</p>
      </template>
      <template v-else-if="tab === 'synthesis'">
        <div class="panel">
          <h3>活动规则与合成结果推算</h3>
          <p class="warning">
            合成页面依据礼物名称、时间筛选和包裹数据推算，接口未提供“此礼物由哪次合成获得”的完整关联，不能当作官方合成流水。未读取奖励分类时，可能混入天选或红包所得。
          </p>
          <div class="rules">
            <label class="synthesis-activity-field" for="synthesis-activity-select"
              >选择合成活动
              <ElSelect
                id="synthesis-activity-select"
                v-model="selectedActivityId"
                filterable
                :disabled="!!busy"
                :loading="catalogLoading"
                popper-class="synthesis-activity-menu"
                :popper-style="{ width: 'min(480px, calc(100vw - 32px))' }"
                @change="chooseActivity"
                @visible-change="handleBoxVisibility"
              >
                <template #label>
                  <span class="selected-box">
                    <img
                      v-if="selectedActivity?.image && !failedIcons.has('activity:' + selectedActivityId)"
                      :src="selectedActivity.image"
                      alt=""
                      @error="failedIcons.add('activity:' + selectedActivityId)"
                    />
                    <span>{{ selectedActivity?.name || '自定义规则' }}</span>
                  </span>
                </template>
                <ElOption
                  v-for="activity in synthesisOptions"
                  :key="activity.id"
                  :value="activity.id"
                  :label="activity.name"
                >
                  <div class="blind-box-option">
                    <img
                      v-if="activity.image && !failedIcons.has('activity:' + activity.id)"
                      :src="activity.image"
                      alt=""
                      loading="lazy"
                      @error="failedIcons.add('activity:' + activity.id)"
                    />
                    <span v-else class="box-icon-fallback" aria-hidden="true">🎁</span>
                    <span class="box-description"
                      ><strong>{{ activity.name }}</strong
                      ><small
                        >{{ activity.materials.length }} 类材料 · {{ activity.products.length }} 类产物</small
                      ></span
                    >
                    <span class="activity-date">{{ activityDateText(activity) }}</span>
                  </div>
                </ElOption>
                <ElOption value="custom" label="自定义规则" />
                <template #footer
                  ><span class="box-menu-note"
                    >按最近匹配记录日期降序；无记录时使用配置日期，日期未知的活动置后。可选历史活动。</span
                  ></template
                >
              </ElSelect>
            </label>
            <span v-if="selectedActivity" class="muted">{{ activityDateText(selectedActivity) }}</span>
          </div>
          <p v-if="selectedActivity?.startTime || selectedActivity?.endTime" class="muted">
            配置活动时间：{{ selectedActivity.startTime ? timeText(selectedActivity.startTime) : '未提供' }} —
            {{ selectedActivity.endTime ? timeText(selectedActivity.endTime) : '未提供' }}。
            材料按活动时间匹配；产物允许结束后 49 小时送出，上方日期可进一步筛选。
          </p>
          <details :open="selectedActivityId === 'custom'">
            <summary>查看或调整活动匹配规则</summary>
            <div class="rules">
              <label>活动名称<input v-model="activityName" /></label>
              <label>材料名称（每行一个）<textarea v-model="materialNames" rows="5" /></label>
              <label>产物名称（每行一个）<textarea v-model="productNames" rows="5" /></label>
            </div>
          </details>
          <div class="stats">
            <div>
              匹配材料净支出<strong>{{ fmt(synthesisStats.cost) }}</strong>
            </div>
            <div>
              已送出产物面值<strong>{{ fmt(synthesisStats.value) }}</strong>
            </div>
            <div>
              匹配产物数量<strong>{{ fmt(synthesisStats.count) }}</strong>
            </div>
            <div>
              当前库存产物面值<strong>{{ bagUpdatedAt ? fmt(matchingBagValue) : '尚未查询' }}</strong>
            </div>
          </div>
          <p class="muted">
            {{
              activityName
            }}：历史数据遵循上方日期和主播筛选。当前库存无完整获得日期或主播归属，因此单独显示，不并入历史收益。{{
              synthesisStats.unknown ? synthesisStats.unknown + ' 条产物面值未知。' : ''
            }}
          </p>
          <details v-if="matchingBag.length">
            <summary>查看当前匹配的库存产物</summary>
            <p v-for="(item, index) in matchingBag" :key="index">
              {{ item.name }} × {{ fmt(item.count) }} · {{ fmt(item.price * item.count) }} 电池面值 ·
              {{ item.lockedText || '未标注主播限制' }}
            </p>
          </details>
        </div>
      </template>
      <template v-else-if="tab === 'rewards'">
        <p v-if="!rewardCatalog" class="warning">
          请先读取天选 / 红包分类，再从已有消费记录匹配奖励；没有分类时不推断礼物来源。
        </p>
        <div class="stats panel">
          <div>
            匹配礼物数量<strong>{{ fmt(rewardStats.count) }}</strong>
          </div>
          <div>
            已识别面值<strong>{{ fmt(rewardStats.value) }}</strong>
          </div>
          <div>
            非退款记录日期数<strong>{{ fmt(activityStats.days) }}</strong>
          </div>
          <div>
            最长连续天数<strong>{{ fmt(activityStats.longest) }}</strong>
          </div>
        </div>
        <p class="muted">
          按配置礼物 ID 匹配，消费记录中的时间通常是送出 /
          使用时间，不能证明实际抽中时间。面值不是付费支出或现金收益。{{
            rewardStats.unknown ? rewardStats.unknown + ' 条记录的面值未知。' : ''
          }}
        </p>
        <p class="muted">
          日期统计使用当前筛选下所有非退款消费记录，而非只计算奖励。相隔不超过 365 天的窗口内最多有
          {{ activityStats.rolling365 }} 个记录日期；不等同自然年。
        </p>
      </template>
      <template v-if="tab === 'synthesis' || tab === 'rewards'">
        <div class="panel">
          <div class="section-heading">
            <h3>{{ tab === 'synthesis' ? '匹配记录' : '奖励相关记录' }} · {{ detailCount }} 条</h3>
            <div>
              <button class="secondary" @click="exportData('csv')">导出 CSV</button
              ><button class="secondary" @click="exportData('json')">导出 JSON</button>
            </div>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>主播</th>
                  <th>礼物 / 数量</th>
                  <th>净支出</th>
                  <th>礼物面值</th>
                  <th>类型</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in detailRows" :key="row.id">
                  <td>{{ timeText(row.timestamp) }}</td>
                  <td>
                    <button class="text-button" @click="anchorId = row.anchorId">{{ row.anchorName }}</button
                    ><small>UID {{ row.anchorId }}</small>
                  </td>
                  <td>{{ row.giftName }} × {{ fmt(row.giftNum) }}</td>
                  <td>{{ fmt(row.netBattery) }}</td>
                  <td>{{ faceValue(row) === null ? '未知' : fmt(faceValue(row)!) }}</td>
                  <td>{{ row.isBag ? '包裹礼物' : '付费记录' }}</td>
                </tr>
                <tr v-if="!detailRows.length">
                  <td colspan="6" class="empty">当前筛选没有匹配记录；请先查询消费账单并读取相关分类。</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <button class="secondary" :disabled="page <= 1" @click="page--">上一页</button>{{ page }} / {{ detailPages
            }}<button class="secondary" :disabled="page >= detailPages" @click="page++">下一页</button>
          </div>
        </div>
      </template>
      <div v-if="tab === 'bag'" class="panel">
        <div class="section-heading">
          <h3>当前包裹 · {{ visibleBag.length }} 项</h3>
          <div>
            <button class="secondary" :disabled="!bagUpdatedAt" @click="exportData('csv')">导出 CSV</button
            ><button class="secondary" :disabled="!bagUpdatedAt" @click="exportData('json')">导出 JSON</button>
          </div>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>礼物</th>
                <th>数量</th>
                <th>单价（面值）</th>
                <th>使用限制</th>
                <th>到期时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, index) in visibleBag" :key="index">
                <td>
                  {{ item.name }}<small>ID {{ item.id }}</small>
                </td>
                <td>{{ fmt(item.count) }}</td>
                <td>{{ fmt(item.price) }}</td>
                <td>{{ item.lockedText || (item.locked ? '有限制' : '未标注') }}</td>
                <td>{{ item.expireAt ? timeText(item.expireAt) : '接口未提供' }}</td>
              </tr>
              <tr v-if="!visibleBag.length">
                <td colspan="5" class="empty">
                  {{ bagUpdatedAt ? '当前包裹没有匹配礼物。' : '点击“查询当前包裹”读取本人库存。' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.blind-distribution {
  margin: 24px 0;
  padding: 18px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.blind-distribution-content {
  display: flex;
  align-items: center;
  gap: 32px;
  margin: 22px 0;
  flex-wrap: wrap;
}
.blind-donut {
  width: 190px;
  height: 190px;
  border-radius: 50%;
  padding: 32px;
  flex-shrink: 0;
  box-sizing: border-box;
}
.blind-donut > div {
  height: 100%;
  border-radius: 50%;
  background: var(--surface);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
}
.blind-donut strong {
  font-size: 28px;
}
.blind-donut span {
  color: var(--muted);
  font-size: 12px;
}
.blind-gift-counts {
  flex: 1;
  min-width: min(280px, 100%);
  list-style: none;
  margin: 0;
  padding: 0;
}
.blind-gift-counts li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 0;
  font-size: 13px;
}
.blind-gift-counts i {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  flex-shrink: 0;
}
.blind-gift-counts img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}
.blind-gift-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.blind-gift-counts strong {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.blind-gift-percentage {
  width: 60px;
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.blind-comparison {
  padding: 14px 16px;
  margin-top: 14px;
  border: 1px solid var(--line, var(--el-border-color));
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.8;
}
.blind-comparison.has-gap {
  border-color: var(--el-color-warning);
}
.blind-box-field {
  width: min(340px, 100%);
}
.synthesis-activity-field {
  width: min(360px, 100%);
}
.activity-date {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.blind-box-select {
  width: 100%;
}
.selected-box {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.selected-box img {
  width: 24px;
  height: 24px;
  object-fit: contain;
  flex-shrink: 0;
}
.selected-box > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.blind-box-option {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 64px;
  color: var(--el-text-color-primary);
}
.blind-box-option > img,
.box-icon-fallback {
  width: 40px;
  height: 40px;
  object-fit: contain;
  flex-shrink: 0;
}
.box-icon-fallback {
  display: grid;
  place-items: center;
  font-size: 26px;
}
.box-description {
  flex: 1;
  min-width: 0;
  line-height: 1.4;
}
.box-description strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
}
.box-description small {
  color: var(--el-text-color-secondary);
}
.box-invested {
  color: var(--el-color-primary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.box-menu-note {
  display: block;
  white-space: normal;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
:global(.blind-box-menu .el-select-dropdown__item) {
  height: 64px;
  padding: 0 14px;
}
:global(.synthesis-activity-menu .el-select-dropdown__item) {
  height: 64px;
  padding: 0 14px;
}
.extended-queries {
  margin-top: 24px;
  color: var(--ink, var(--el-text-color-primary));
}
h2,
h3,
p {
  margin: 0;
}
h2 {
  font-size: 19px;
}
h3 {
  font-size: 16px;
}
p {
  margin: 12px 0;
  line-height: 1.7;
}
.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}
.tabs,
.toolbar,
.filters {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
  margin: 18px 0;
}
.tabs {
  border-bottom: 1px solid var(--line, var(--el-border-color));
  padding-bottom: 12px;
}
button,
input,
select,
textarea {
  font: inherit;
  border-radius: 7px;
}
button {
  border: 1px solid transparent;
  background: var(--accent, var(--el-color-primary));
  color: #fff;
  padding: 8px 13px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.secondary,
.tabs button {
  background: var(--surface, var(--el-bg-color));
  border-color: var(--line, var(--el-border-color));
  color: inherit;
}
.tabs button.active {
  border-color: var(--accent, var(--el-color-primary));
  color: var(--accent, var(--el-color-primary));
}
label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  color: var(--muted, var(--el-text-color-secondary));
  font-size: 12px;
}
input,
select,
textarea {
  border: 1px solid var(--line, var(--el-border-color));
  background: var(--surface, var(--el-bg-color));
  color: var(--ink, var(--el-text-color-primary));
  padding: 8px 10px;
  min-width: 145px;
  max-width: 100%;
}
select {
  max-width: 320px;
}
textarea {
  min-width: 220px;
  resize: vertical;
}
.panel {
  border: 1px solid var(--line, var(--el-border-color));
  border-radius: 12px;
  background: var(--surface, var(--el-bg-color));
  padding: 20px;
  margin: 18px 0;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
  margin: 18px 0;
}
.stats > div {
  color: var(--muted, var(--el-text-color-secondary));
  font-size: 12px;
}
.stats strong {
  display: block;
  font-size: 25px;
  color: var(--ink, var(--el-text-color-primary));
  margin-top: 8px;
}
.rules {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin: 18px 0;
}
.muted,
small {
  color: var(--muted, var(--el-text-color-secondary));
  font-size: 12px;
}
small {
  display: block;
  font-size: 10px;
  margin-top: 3px;
}
.warning {
  color: var(--el-color-warning, #d4a14a);
}
.error {
  color: var(--el-color-danger, #e37070);
}
.notice {
  color: var(--accent, var(--el-color-primary));
}
.table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th,
td {
  padding: 12px 9px;
  text-align: left;
  border-bottom: 1px solid var(--line, var(--el-border-color));
}
th {
  color: var(--muted, var(--el-text-color-secondary));
  font-weight: 500;
}
td {
  overflow-wrap: anywhere;
}
.text-button {
  background: none;
  padding: 0;
  border: 0;
  color: var(--accent, var(--el-color-primary));
  text-align: left;
}
.pagination {
  display: flex;
  align-items: center;
  justify-content: end;
  gap: 13px;
  margin-top: 16px;
}
.empty {
  text-align: center;
  padding: 30px 12px;
  color: var(--muted, var(--el-text-color-secondary));
}
.section-heading > div > button + button {
  margin-left: 8px;
}
.tag {
  margin-left: 6px;
  font-size: 10px;
  color: var(--accent, var(--el-color-primary));
}
details {
  margin: 16px 0;
}
summary {
  cursor: pointer;
  color: var(--accent, var(--el-color-primary));
}
@media (max-width: 800px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .panel {
    padding: 14px;
  }
}
</style>
