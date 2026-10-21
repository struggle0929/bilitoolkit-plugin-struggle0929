<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { CollectionSnapshot } from './types/consumption'
import { collectConsumption } from './services/consumption-api'
import { recordsToCsv, summarizeRecords } from './services/consumption-core'
import ExtendedQueries from './components/ExtendedQueries.vue'

type Account = { uid: string; name: string; face: string }
const account = ref<Account | null>(null)
const snapshot = shallowRef<CollectionSnapshot | null>(null)
const busy = ref(false)
const switching = ref(false)
const error = ref('')
const notice = ref('')
const progress = ref({ pages: 0, records: 0 })
const keyword = ref('')
const startDate = ref('')
const endDate = ref('')
const viewMode = ref('all')
const anchorSearch = ref('')
const selectedAnchorId = ref('')
const selectedGiftKey = ref('')
const anchorSelect = ref<HTMLSelectElement | null>(null)
const chartMetric = ref<'battery' | 'quantity' | 'count'>('battery')
const mainPage = ref<'consumption' | 'extended'>('consumption')
const extendedBusy = ref(false)
const page = ref(1)
const hostAvailable = typeof window.toolkitApi !== 'undefined'
let activeController: AbortController | null = null
let unsubscribeLogout: (() => void) | undefined
const dbKey = (uid: string) => 'live-consumption-' + uid
const fmt = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const dateText = (value: number | null) =>
  value === null ? '暂无记录' : new Date(value * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
const timeText = (value: number) =>
  new Date(value * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
const allRecords = computed(() => snapshot.value?.records || [])
const giftKey = (id: string, name: string) => JSON.stringify([id, name])
const allAnchors = computed(() => {
  const anchors = new Map<string, string>()
  for (const record of allRecords.value) {
    if (record.anchorId && !anchors.has(record.anchorId)) anchors.set(record.anchorId, record.anchorName)
  }
  return [...anchors].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
})
const anchorOptions = computed(() => {
  const query = anchorSearch.value.trim().toLowerCase()
  return allAnchors.value.filter(
    (anchor) =>
      anchor.id === selectedAnchorId.value || !query || `${anchor.name} ${anchor.id}`.toLowerCase().includes(query),
  )
})
const selectedAnchor = computed(() => allAnchors.value.find((anchor) => anchor.id === selectedAnchorId.value))
const selectedGift = computed(() =>
  allRecords.value.find((record) => giftKey(record.giftId, record.giftName) === selectedGiftKey.value),
)
const filteredRecords = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  const start = startDate.value ? new Date(startDate.value + 'T00:00:00+08:00').getTime() / 1000 : -Infinity
  const end = endDate.value ? new Date(endDate.value + 'T23:59:59+08:00').getTime() / 1000 : Infinity
  return allRecords.value.filter((record) => {
    if (selectedAnchorId.value && record.anchorId !== selectedAnchorId.value) return false
    if (selectedGiftKey.value && giftKey(record.giftId, record.giftName) !== selectedGiftKey.value) return false
    if (record.timestamp < start || record.timestamp > end) return false
    if (viewMode.value === 'paid' && record.netBattery <= 0) return false
    if (viewMode.value === 'bag' && !record.isBag) return false
    if (viewMode.value === 'refunded' && !record.isRefunded && record.refundBattery <= 0) return false
    return (
      !query || [record.giftName, record.anchorName, record.anchorId, record.id].join(' ').toLowerCase().includes(query)
    )
  })
})
const summary = computed(() => summarizeRecords(filteredRecords.value))
const filteredGiftCount = computed(
  () => new Set(filteredRecords.value.map((record) => giftKey(record.giftId, record.giftName))).size,
)
const filteredAnchorCount = computed(
  () => new Set(filteredRecords.value.map((record) => record.anchorId).filter(Boolean)).size,
)
const newest = computed(() => filteredRecords.value[0])
const rows = computed(() => filteredRecords.value.slice((page.value - 1) * 50, page.value * 50))
const totalPages = computed(() => Math.max(1, Math.ceil(filteredRecords.value.length / 50)))
const metricLabel = computed(
  () => ({ battery: '净支出电池', quantity: '礼物数量', count: '记录条数' })[chartMetric.value],
)
const metricUnit = computed(() => ({ battery: '电池', quantity: '个', count: '条' })[chartMetric.value])
const chartData = computed(() => {
  const months = new Map<string, { key: string; value: number }>()
  const anchors = new Map<string, { id: string; name: string; value: number }>()
  const gifts = new Map<
    string,
    { key: string; id: string; name: string; image: string; value: number; quantity: number; count: number }
  >()
  const monthFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' })
  for (const record of filteredRecords.value) {
    const value =
      chartMetric.value === 'battery' ? record.netBattery : chartMetric.value === 'quantity' ? record.giftNum : 1
    if (value <= 0) continue
    const monthKey = monthFormat.format(new Date(record.timestamp * 1000))
    const month = months.get(monthKey) ?? { key: monthKey, value: 0 }
    month.value += value
    months.set(monthKey, month)
    const anchorKey = record.anchorId || 'unknown'
    const anchor = anchors.get(anchorKey) ?? { id: anchorKey, name: record.anchorName, value: 0 }
    anchor.value += value
    anchors.set(anchorKey, anchor)
    const key = giftKey(record.giftId, record.giftName)
    const gift = gifts.get(key) ?? {
      key,
      id: record.giftId,
      name: record.giftName,
      image: record.giftImg,
      value: 0,
      quantity: 0,
      count: 0,
    }
    gift.value += value
    gift.quantity += record.giftNum
    gift.count++
    gifts.set(key, gift)
  }
  return {
    months: [...months.values()].sort((a, b) => a.key.localeCompare(b.key)),
    anchors: [...anchors.values()].sort((a, b) => b.value - a.value),
    gifts: [...gifts.values()].sort((a, b) => b.value - a.value),
  }
})
const monthMax = computed(() => Math.max(1, ...chartData.value.months.map((item) => item.value)))
const colors = ['#6d64df', '#36a69c', '#efb260', '#5d9bd5', '#d67eb4', '#83b96f', '#d87972', '#99a1b3']
const anchorGroups = computed(() => {
  const anchors = chartData.value.anchors
  const top = anchors.slice(0, 7)
  const rest = anchors.slice(7)
  return rest.length
    ? [
        ...top,
        {
          id: 'others',
          name: '其他主播',
          value: rest.reduce((n, row) => n + row.value, 0),
        },
      ]
    : top
})
const pieStyle = computed(() => {
  const total = anchorGroups.value.reduce((n, row) => n + row.value, 0)
  let offset = 0
  const stops = anchorGroups.value.map((row, i) => {
    const from = offset
    offset += total ? (row.value / total) * 100 : 0
    return colors[i] + ' ' + from + '% ' + offset + '%'
  })
  return { background: stops.length ? 'conic-gradient(' + stops.join(',') + ')' : 'var(--line)' }
})
function changedFilter() {
  page.value = 1
}
watch([keyword, startDate, endDate, viewMode, selectedAnchorId, selectedGiftKey], changedFilter)
watch(viewMode, (mode) => {
  if (mode === 'bag' && chartMetric.value === 'battery') chartMetric.value = 'quantity'
})
function selectAnchor(id: string) {
  if (id === 'others' || id === 'unknown') {
    anchorSearch.value = ''
    anchorSelect.value?.focus()
    anchorSelect.value?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return
  }
  selectedAnchorId.value = id
}
function selectMonth(key: string) {
  const [year, month] = key.split('-').map(Number)
  if (!year || !month) return
  startDate.value = key + '-01'
  endDate.value = key + '-' + new Date(Date.UTC(year, month, 0)).getUTCDate()
}
function resetFilters() {
  keyword.value = ''
  startDate.value = ''
  endDate.value = ''
  viewMode.value = 'all'
  anchorSearch.value = ''
  selectedAnchorId.value = ''
  selectedGiftKey.value = ''
  chartMetric.value = 'battery'
  page.value = 1
}
function cancel() {
  activeController?.abort()
}
async function selectAccount() {
  if (switching.value) return
  cancel()
  switching.value = true
  error.value = ''
  notice.value = ''
  try {
    const selected = await window.toolkitApi.user.switchUser(true)
    // Verify the injected session, without sending Cookie values back through IPC.
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials: 'include',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('无法验证登录状态，请稍后重试')
    const identity = (await response.json()) as { code?: number; data?: { isLogin?: boolean; mid?: number } }
    if (identity.code !== 0 || !identity.data?.isLogin || String(identity.data.mid) !== String(selected.mid))
      throw new Error('登录状态失效或账号不一致，请重新选择并登录')
    const chosen = { uid: String(selected.mid), name: selected.name, face: selected.face }
    account.value = chosen
    snapshot.value = null
    resetFilters()
    const cached = await window.toolkitApi.db.init<CollectionSnapshot>(dbKey(chosen.uid))
    if (account.value?.uid !== chosen.uid) return
    if (cached && cached.formatVersion === 1 && cached.uid === chosen.uid && Array.isArray(cached.records)) {
      snapshot.value = cached
      notice.value = '已读取此账号的本地账单缓存，点击更新查询最新记录。'
    } else if (cached?.uid === chosen.uid) {
      notice.value = '旧缓存需按精确流水号重新获取，请点击“查询消费记录”。'
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '账号选择失败'
  } finally {
    switching.value = false
  }
}
async function query(mode: 'full' | 'incremental') {
  if (!account.value || busy.value) return
  const uid = account.value.uid
  const controller = new AbortController()
  activeController = controller
  busy.value = true
  error.value = ''
  notice.value = ''
  progress.value = { pages: 0, records: 0 }
  try {
    const result = await collectConsumption({
      uid,
      existing: snapshot.value || undefined,
      mode,
      signal: controller.signal,
      onProgress: (value) => {
        if (activeController === controller) progress.value = value
      },
    })
    if (account.value?.uid !== uid || activeController !== controller) return
    snapshot.value = result
    page.value = 1
    try {
      await window.toolkitApi.db.write(dbKey(uid), result)
      notice.value =
        result.coverage === 'complete'
          ? '已遍历接口当前返回的所有页，并保存到本地。'
          : '已保存目前取得的记录；查询尚不完整，可继续更新。'
    } catch {
      notice.value = '查询结果已显示，但本地缓存保存失败。请先导出账单，避免关闭后丢失。'
    }
  } catch (cause) {
    if (account.value?.uid === uid) error.value = cause instanceof Error ? cause.message : '查询失败'
  } finally {
    if (activeController === controller) {
      activeController = null
      busy.value = false
    }
  }
}
async function exportData(format: 'csv' | 'json') {
  if (!snapshot.value || !account.value) return
  error.value = ''
  try {
    const name = '直播消费-' + account.value.uid + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + format
    const content =
      format === 'csv'
        ? recordsToCsv(filteredRecords.value)
        : JSON.stringify(
            {
              ...snapshot.value,
              records: filteredRecords.value,
              filters: {
                startDate: startDate.value,
                endDate: endDate.value,
                keyword: keyword.value,
                viewMode: viewMode.value,
                anchorId: selectedAnchorId.value,
                giftKey: selectedGiftKey.value,
              },
            },
            null,
            2,
          )
    await window.toolkitApi.file.write(name, new TextEncoder().encode(content), false)
    notice.value = '已导出当前筛选的 ' + filteredRecords.value.length + ' 条记录：' + name
    await window.toolkitApi.system.showItemInPluginFolder(name)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '导出失败'
  }
}
onMounted(async () => {
  if (!hostAvailable) return
  unsubscribeLogout = await window.toolkitApi.event.onUserLogout((user) => {
    if (String(user.mid) === account.value?.uid) {
      cancel()
      account.value = null
      snapshot.value = null
      notice.value = '账号已退出，请重新选择并授权账号。'
      window.toolkitApi.user.delCurrUserCookie().catch(() => {})
    }
  })
  // Reuse only this plugin's previously authorized, isolated session.
  // No account is selected or granted access implicitly through the host.
  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials: 'include',
      cache: 'no-store',
    })
    if (!response.ok) return
    const identity = (await response.json()) as {
      code?: number
      data?: { isLogin?: boolean; mid?: number; uname?: string; face?: string }
    }
    if (account.value || switching.value || identity.code !== 0 || !identity.data?.isLogin || !identity.data.mid) return
    const chosen = {
      uid: String(identity.data.mid),
      name: identity.data.uname || '已授权账号',
      face: identity.data.face || '',
    }
    account.value = chosen
    const cached = await window.toolkitApi.db.init<CollectionSnapshot>(dbKey(chosen.uid))
    if (account.value?.uid !== chosen.uid) return
    if (cached?.formatVersion === 1 && cached.uid === chosen.uid && Array.isArray(cached.records)) {
      snapshot.value = cached
      notice.value = '已恢复此插件上次授权的账号和本地缓存。'
    } else {
      notice.value = '已恢复此插件上次授权的登录会话，请查询最新账单。'
    }
  } catch {
    // Expired or unavailable sessions remain at the explicit account selector.
  }
})
onBeforeUnmount(() => {
  cancel()
  unsubscribeLogout?.()
})
</script>

<template>
  <main class="consumption-app">
    <header class="page-head">
      <div>
        <span class="eyebrow">BILITOOLKIT · 本人账单</span>
        <h1>直播消费账单</h1>
        <p>把每一次支持，整理成看得清的记录。</p>
      </div>
      <button
        class="account-button"
        :disabled="!hostAvailable || switching || busy || extendedBusy"
        @click="selectAccount"
      >
        <img v-if="account?.face" :src="account.face" alt="" /><span>{{
          switching ? '正在验证账号…' : account ? account.name + ' · 切换账号' : '选择并授权账号'
        }}</span>
      </button>
    </header>
    <nav class="page-navigation" aria-label="账单查询页面">
      <button :aria-pressed="mainPage === 'consumption'" :disabled="extendedBusy" @click="mainPage = 'consumption'">
        消费账单
      </button>
      <button :aria-pressed="mainPage === 'extended'" :disabled="busy" @click="mainPage = 'extended'">
        盲盒与更多查询
      </button>
    </nav>
    <div v-if="!hostAvailable" class="message warning">
      请在哔哩工具姬中加载本插件，使用宿主的账号管理完成登录和授权。
    </div>
    <div v-if="error" class="message error" role="alert">{{ error }}</div>
    <div v-if="notice" class="message" role="status">{{ notice }}</div>
    <ExtendedQueries
      v-if="mainPage === 'extended'"
      :account="account"
      :records="allRecords"
      @select-account="selectAccount"
      @busy="extendedBusy = $event"
    />
    <div v-show="mainPage === 'consumption'">
      <section class="query-panel panel">
        <div>
          <strong>{{ account ? 'UID ' + account.uid : '从选择本人账号开始' }}</strong>
          <p>直接读取 B 站本人直播消费记录，查询过程中可随时停止。</p>
        </div>
        <div class="query-actions">
          <button :disabled="!account || busy || switching" @click="query('incremental')">
            {{ snapshot ? '更新最新记录' : '查询消费记录' }}</button
          ><button :disabled="!account || busy || switching" class="secondary" @click="query('full')">
            重新获取全部记录</button
          ><button v-if="busy" class="secondary" @click="cancel">停止查询</button>
        </div>
        <div v-if="busy" class="progress" role="status">
          <span class="pulse" />正在查询第 {{ progress.pages + 1 }} 页，已取得 {{ fmt(progress.records) }} 条记录…
        </div>
      </section>
      <template v-if="snapshot">
        <div class="coverage-line">
          <span>已查到的记录范围：{{ dateText(summary.earliest) }} — {{ dateText(summary.latest) }}</span
          ><span :class="['coverage', snapshot.coverage]">{{
            snapshot.coverage === 'complete' ? '已遍历接口返回的全部页' : '部分记录，尚未查询完整'
          }}</span>
        </div>
        <div v-if="snapshot.warning" class="message warning">{{ snapshot.warning }}</div>
        <section class="stats-grid">
          <article class="stat lavender">
            <span>净支出电池</span><strong>{{ fmt(summary.netBattery) }}</strong
            ><small>扣除已识别退款，不计包裹道具</small>
          </article>
          <article class="stat peach">
            <span>付费消费次数</span><strong>{{ fmt(summary.consumptionCount) }}</strong
            ><small>按消费记录计数</small>
          </article>
          <article class="stat mint">
            <span>礼物种类</span><strong>{{ fmt(filteredGiftCount) }}</strong
            ><small>当前筛选范围</small>
          </article>
          <article class="stat rose">
            <span>支持主播数</span><strong>{{ fmt(filteredAnchorCount) }}</strong
            ><small>按主播 UID 去重</small>
          </article>
        </section>
        <section class="last-record panel">
          <div>
            <span class="muted">当前筛选最新记录</span>
            <div v-if="newest" class="latest">
              <strong>{{ newest.giftName }} × {{ newest.giftNum }}</strong
              ><span>{{ newest.anchorName }}</span
              ><time>{{ timeText(newest.timestamp) }}</time>
            </div>
            <p v-else>当前筛选没有消费记录。</p>
          </div>
          <div class="refund-info">
            <span>支出 {{ fmt(summary.paidBattery) }} 电池</span
            ><span>已识别退款 {{ fmt(summary.refundBattery) }} 电池</span>
          </div>
        </section>
        <section class="filter-panel panel">
          <label>开始日期<input v-model="startDate" type="date" @change="changedFilter" /></label
          ><label>结束日期<input v-model="endDate" type="date" @change="changedFilter" /></label>
          <label class="keyword"
            >搜索<input v-model="keyword" placeholder="主播、UID、礼物或记录 ID" @input="changedFilter"
          /></label>
          <label
            >记录类型<select v-model="viewMode" @change="changedFilter">
              <option value="all">全部记录</option>
              <option value="paid">有净支出</option>
              <option value="bag">包裹道具</option>
              <option value="refunded">退款记录</option>
            </select></label
          >
          <label class="anchor-filter"
            >选择主播<input v-model="anchorSearch" placeholder="搜索主播名或 UID" />
            <select ref="anchorSelect" v-model="selectedAnchorId" aria-label="选择主播">
              <option value="">全部主播（{{ allAnchors.length }} 位）</option>
              <option v-for="anchor in anchorOptions" :key="anchor.id" :value="anchor.id">
                {{ anchor.name }} · {{ anchor.id }}
              </option>
            </select>
          </label>
          <button class="secondary" @click="resetFilters">清除筛选</button>
        </section>
        <div v-if="selectedAnchor || selectedGift" class="active-filters">
          <button v-if="selectedAnchor" class="filter-chip" @click="selectedAnchorId = ''">
            主播：{{ selectedAnchor.name }} · UID {{ selectedAnchor.id }} ×
          </button>
          <button v-if="selectedGift" class="filter-chip" @click="selectedGiftKey = ''">
            礼物：{{ selectedGift.giftName }} ×
          </button>
        </div>
        <div class="chart-controls">
          <label
            >图表统计口径
            <select v-model="chartMetric">
              <option value="battery">净支出电池</option>
              <option value="quantity">礼物数量</option>
              <option value="count">记录条数</option>
            </select>
          </label>
          <span class="muted">点击月份、主播或礼物可筛选明细；包裹道具可按数量查看，不计入支出。</span>
        </div>
        <section class="charts-grid">
          <article class="panel chart-panel">
            <div class="section-title">
              <h2>日期统计</h2>
              <span>月度{{ metricLabel }} · {{ metricUnit }}</span>
            </div>
            <div v-if="chartData.months.length" class="month-chart">
              <button
                v-for="month in chartData.months"
                :key="month.key"
                class="month-column"
                :title="month.key + '：' + fmt(month.value) + ' ' + metricUnit + '，点击筛选此月'"
                @click="selectMonth(month.key)"
              >
                <span>{{ fmt(month.value) }}</span>
                <div class="bar-track">
                  <div class="bar" :style="{ height: Math.max(1, (month.value / monthMax) * 100) + '%' }" />
                </div>
                <small>{{ month.key }}</small>
              </button>
            </div>
            <div v-else class="empty">当前范围暂无{{ metricLabel }}数据</div>
          </article>
          <article class="panel chart-panel">
            <div class="section-title">
              <h2>主播分布</h2>
              <span>按{{ metricLabel }}排序 · 可点击筛选</span>
            </div>
            <div v-if="anchorGroups.length" class="anchor-chart">
              <div class="donut" :style="pieStyle">
                <div>
                  <strong>{{ fmt(chartData.anchors.length) }}</strong
                  ><span>位主播</span>
                </div>
              </div>
              <ul class="legend">
                <li v-for="(anchor, index) in anchorGroups" :key="anchor.id">
                  <button
                    class="legend-button"
                    :aria-pressed="selectedAnchorId === anchor.id"
                    :title="anchor.id === 'others' ? '从完整主播列表选择' : '筛选 UID ' + anchor.id"
                    @click="selectAnchor(anchor.id)"
                  >
                    <i :style="{ background: colors[index] }" /><span>{{ anchor.name }}</span
                    ><strong>{{ fmt(anchor.value) }}</strong>
                  </button>
                </li>
              </ul>
            </div>
            <div v-else class="empty">当前范围暂无{{ metricLabel }}数据</div>
          </article>
        </section>
        <section class="panel gift-panel">
          <div class="section-title">
            <h2>礼物清单</h2>
            <span>按{{ metricLabel }}排序 · 点击礼物筛选</span>
          </div>
          <div v-if="chartData.gifts.length" class="gift-grid">
            <button
              v-for="gift in chartData.gifts"
              :key="gift.key"
              class="gift-summary"
              :aria-pressed="selectedGiftKey === gift.key"
              @click="selectedGiftKey = gift.key"
            >
              <img v-if="gift.image" :src="gift.image" alt="" loading="lazy" />
              <span
                ><strong>{{ gift.name }}</strong
                ><small>{{ fmt(gift.quantity) }} 个 · {{ fmt(gift.count) }} 条记录</small></span
              >
              <b>{{ fmt(gift.value) }} {{ metricUnit }}</b>
            </button>
          </div>
          <div v-else class="empty">当前范围暂无{{ metricLabel }}数据</div>
        </section>
        <section class="panel table-panel">
          <div class="section-title">
            <div>
              <h2>消费明细</h2>
              <p>共 {{ fmt(filteredRecords.length) }} 条 · 所有金额单位均为电池</p>
            </div>
            <div class="export-actions">
              <button class="secondary" :disabled="!filteredRecords.length" @click="exportData('csv')">导出 CSV</button
              ><button class="secondary" :disabled="!filteredRecords.length" @click="exportData('json')">
                导出 JSON
              </button>
            </div>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>消费时间</th>
                  <th>礼物 / 数量</th>
                  <th>主播</th>
                  <th class="numeric">净支出</th>
                  <th class="numeric">退款</th>
                  <th>类型 / 状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="record in rows" :key="record.id">
                  <td class="nowrap">{{ timeText(record.timestamp) }}</td>
                  <td>
                    <span class="gift-name"
                      ><img v-if="record.giftImg" :src="record.giftImg" alt="" loading="lazy" /><span
                        >{{ record.giftName }} × {{ record.giftNum }}</span
                      ></span
                    >
                  </td>
                  <td>
                    <button class="anchor-link" @click="selectAnchor(record.anchorId)">{{ record.anchorName }}</button
                    ><small class="uid">UID {{ record.anchorId }}</small>
                  </td>
                  <td class="numeric">{{ fmt(record.netBattery) }}</td>
                  <td class="numeric">{{ fmt(record.refundBattery) }}</td>
                  <td>
                    <span :class="['record-tag', { refund: record.isRefunded || record.refundBattery > 0 }]">{{
                      record.isBag
                        ? '包裹道具'
                        : record.isRefunded
                          ? '已退回'
                          : record.refundBattery > 0
                            ? '含退款'
                            : '付费道具'
                    }}</span>
                  </td>
                </tr>
                <tr v-if="!rows.length">
                  <td colspan="6" class="empty">当前条件下没有消费记录。</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <button class="secondary" :disabled="page <= 1" @click="page--">上一页</button
            ><span>{{ page }} / {{ totalPages }}</span
            ><button class="secondary" :disabled="page >= totalPages" @click="page++">下一页</button>
          </div>
        </section>
        <footer class="scope-note">
          数据更新时间：{{
            new Date(snapshot.updatedAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
          }}。<br />“全部页”指 B
          站接口本次可返回的范围，不代表账号注册至今的完整账单。充值、站外支付、大会员和其他业务不包含在此统计中；电池支出不直接等同人民币实付金额。
        </footer>
      </template>
      <section v-else class="panel welcome">
        <div class="welcome-mark">▥</div>
        <h2>你的直播消费，一目了然</h2>
        <p>
          选择并授权本人账号后，查询付费礼物、退款和包裹道具记录。<br />统计按电池展示，账单缓存与导出文件保存在本机。
        </p>
        <div class="welcome-steps"><span>01 选择账号</span><span>02 查询账单</span><span>03 筛选与导出</span></div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.consumption-app {
  --ink: var(--el-text-color-primary, #282b39);
  --muted: var(--el-text-color-secondary, #7f8390);
  --surface: var(--el-bg-color, #fff);
  --line: var(--el-border-color-lighter, #e9ebf2);
  --accent: var(--el-color-primary, #7366d8);
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  max-width: 1440px;
  margin: 0 auto;
  padding: 28px;
  color: var(--ink);
  font:
    14px/1.6 system-ui,
    sans-serif;
}
* {
  box-sizing: border-box;
}
h1,
h2,
p {
  margin: 0;
}
h1 {
  font-size: 27px;
  letter-spacing: 1px;
  margin: 3px 0;
}
h2 {
  font-size: 17px;
}
.eyebrow {
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--accent);
  font-weight: 700;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 24px;
}
.page-head p,
.query-panel p,
.section-title > span,
.scope-note,
.muted {
  color: var(--muted);
}
button,
input,
select {
  font: inherit;
}
button {
  background: var(--accent);
  color: #fff;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 8px 14px;
  cursor: pointer;
  transition: opacity 0.15s;
}
button:hover {
  opacity: 0.85;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.page-navigation {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 20px;
}
.page-navigation button {
  color: var(--muted);
  background: var(--surface);
  border-color: var(--line);
}
.page-navigation button[aria-pressed='true'] {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
button.secondary,
.account-button {
  color: var(--ink);
  background: var(--surface);
  border-color: var(--line);
}
.account-button {
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 320px;
}
.account-button img {
  width: 27px;
  height: 27px;
  border-radius: 50%;
}
.panel {
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--surface);
}
.query-panel {
  padding: 18px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.query-actions,
.export-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.query-panel p {
  font-size: 12px;
  margin-top: 3px;
}
.progress {
  width: 100%;
  color: var(--accent);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 9px;
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1s infinite alternate;
}
@keyframes pulse {
  to {
    opacity: 0.3;
  }
}
.message {
  margin: 12px 0;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  color: var(--muted);
  background: var(--surface);
  overflow-wrap: anywhere;
}
.message.error {
  color: #bf4b50;
  border-color: #db9395;
}
.message.warning {
  color: #ab7b30;
  border-color: #dfc18e;
}
.coverage-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 20px 0 11px;
  color: var(--muted);
  font-size: 12px;
}
.coverage {
  border-radius: 20px;
  padding: 3px 9px;
  background: color-mix(in srgb, var(--accent) 9%, transparent);
  color: var(--accent);
}
.coverage.partial {
  color: #b18a38;
  background: #d9b45615;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 13px;
  margin-bottom: 16px;
}
.stat {
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 12px;
  position: relative;
  overflow: hidden;
  background: var(--surface);
}
.stat:before {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0.09;
  pointer-events: none;
}
.lavender:before {
  background: #8c77e8;
}
.peach:before {
  background: #e6a96f;
}
.mint:before {
  background: #63b998;
}
.rose:before {
  background: #bd88b9;
}
.stat > span,
.stat small {
  display: block;
  color: var(--muted);
  position: relative;
}
.stat strong {
  display: block;
  position: relative;
  font-size: 32px;
  line-height: 1.5;
  letter-spacing: -1px;
  margin: 5px 0;
}
.stat small {
  font-size: 11px;
}
.last-record {
  padding: 17px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  margin-bottom: 16px;
}
.latest {
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
  margin-top: 7px;
}
.latest time {
  color: var(--muted);
}
.refund-info {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--muted);
  text-align: right;
}
.filter-panel {
  padding: 15px 18px;
  display: flex;
  gap: 13px;
  align-items: end;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
label {
  font-size: 11px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
input,
select {
  background: var(--surface);
  border: 1px solid var(--line);
  color: var(--ink);
  padding: 7px 9px;
  border-radius: 6px;
  min-width: 150px;
  outline: none;
}
input:focus,
select:focus {
  border-color: var(--accent);
}
label.keyword {
  flex: 1;
}
.keyword input {
  width: 100%;
}
.anchor-filter {
  flex: 1 1 240px;
  min-width: 0;
}
.anchor-filter input,
.anchor-filter select {
  width: 100%;
  min-width: 0;
}
.active-filters,
.chart-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0 0 16px;
}
.filter-chip {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  border-color: color-mix(in srgb, var(--accent) 35%, var(--line));
  text-align: left;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.chart-controls {
  align-items: end;
}
.chart-controls > span {
  font-size: 12px;
  flex: 1 1 250px;
}
.charts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 16px;
}
.chart-panel {
  padding: 20px;
  min-width: 0;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.section-title > span,
.section-title p {
  color: var(--muted);
  font-size: 11px;
}
.month-chart {
  display: flex;
  align-items: end;
  gap: 12px;
  overflow-x: auto;
  padding: 12px 0 4px;
  min-height: 220px;
}
.month-column {
  background: transparent;
  border: 0;
  border-radius: 4px;
  padding: 4px 0;
  color: inherit;
  text-align: center;
  flex: 1;
  min-width: 45px;
  max-width: 90px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.month-column > span {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}
.month-column small {
  font-size: 10px;
  display: block;
  margin-top: 9px;
  color: var(--muted);
}
.bar-track {
  height: 145px;
  display: flex;
  align-items: end;
  width: 70%;
  max-width: 32px;
}
.bar {
  width: 100%;
  background: var(--accent);
  border-radius: 5px 5px 1px 1px;
  min-height: 2px;
}
.anchor-chart {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  min-height: 220px;
}
.donut {
  border-radius: 50%;
  width: 155px;
  height: 155px;
  flex-shrink: 0;
  padding: 27px;
}
.donut > div {
  border-radius: 50%;
  height: 100%;
  background: var(--surface);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.donut strong {
  font-size: 24px;
  line-height: 1.3;
}
.donut span {
  font-size: 11px;
  color: var(--muted);
}
.legend {
  list-style: none;
  padding: 0;
  margin: 0;
  min-width: 0;
  flex: 1;
}
.legend li {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 11px;
  margin: 7px 0;
}
.legend i {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex-shrink: 0;
}
.legend-button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 5px;
  color: var(--ink);
  background: transparent;
  border-color: transparent;
  font-size: inherit;
  text-align: left;
}
.legend-button:hover,
.legend-button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.legend-button > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.legend strong {
  font-weight: 500;
  white-space: nowrap;
}
.gift-panel {
  padding: 20px;
  margin-bottom: 16px;
}
.gift-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 10px;
}
.gift-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  text-align: left;
  color: var(--ink);
  background: var(--surface);
  border-color: var(--line);
}
.gift-summary[aria-pressed='true'] {
  border-color: var(--accent);
}
.gift-summary img {
  width: 32px;
  height: 32px;
  object-fit: contain;
  flex-shrink: 0;
}
.gift-summary > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.gift-summary strong,
.gift-summary small {
  display: block;
}
.gift-summary strong {
  font-size: 12px;
}
.gift-summary small {
  margin-top: 3px;
  font-size: 10px;
  color: var(--muted);
}
.gift-summary b {
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.anchor-link {
  padding: 0;
  color: var(--accent);
  background: transparent;
  text-align: left;
}
.anchor-link:hover {
  text-decoration: underline;
}
.table-panel {
  padding: 20px;
}
.table-scroll {
  overflow: auto;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}
th {
  text-align: left;
  font-weight: 500;
  font-size: 11px;
  color: var(--muted);
  background: color-mix(in srgb, var(--muted) 5%, transparent);
}
th,
td {
  padding: 12px 10px;
  border-bottom: 1px solid var(--line);
}
.numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.nowrap {
  white-space: nowrap;
}
.gift-name {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 130px;
}
.gift-name img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}
.uid {
  display: block;
  font-size: 10px;
  color: var(--muted);
}
.record-tag {
  padding: 3px 7px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--accent);
  border-radius: 4px;
  white-space: nowrap;
  font-size: 10px;
}
.record-tag.refund {
  background: #dba64a15;
  color: #b18a38;
}
.pagination {
  display: flex;
  justify-content: end;
  align-items: center;
  gap: 13px;
  margin-top: 16px;
  font-size: 12px;
}
.pagination button {
  padding: 5px 11px;
}
.scope-note {
  font-size: 11px;
  margin: 17px 2px;
  line-height: 1.8;
}
.empty {
  min-height: 180px;
  text-align: center;
  color: var(--muted);
  padding: 60px 12px;
}
.welcome {
  text-align: center;
  margin-top: 24px;
  padding: 60px 20px;
}
.welcome-mark {
  font-size: 44px;
  color: var(--accent);
  line-height: 1.3;
}
.welcome h2 {
  font-size: 21px;
  margin: 16px 0 10px;
}
.welcome p {
  color: var(--muted);
  font-size: 13px;
}
.welcome-steps {
  display: flex;
  justify-content: center;
  gap: 30px;
  margin-top: 30px;
  color: var(--muted);
  font-size: 11px;
}
@media (max-width: 950px) {
  .consumption-app {
    padding: 20px;
  }
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .charts-grid {
    grid-template-columns: 1fr;
  }
  .last-record {
    align-items: start;
  }
  .anchor-chart {
    justify-content: start;
  }
  .legend {
    max-width: 350px;
  }
}
@media (max-width: 600px) {
  .consumption-app {
    padding: 14px;
  }
  .page-head {
    align-items: start;
    flex-direction: column;
  }
  .query-actions {
    width: 100%;
  }
  .query-actions button {
    flex: 1;
  }
  .stat {
    padding: 14px;
  }
  .stat strong {
    font-size: 27px;
  }
  .latest {
    flex-direction: column;
    gap: 3px;
  }
  .refund-info {
    font-size: 10px;
  }
  .filter-panel {
    padding: 12px;
  }
  label {
    flex: 1;
  }
  input,
  select {
    min-width: 125px;
    width: 100%;
  }
  .anchor-chart {
    gap: 16px;
    flex-wrap: wrap;
  }
  .legend {
    min-width: 180px;
  }
  .gift-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .section-title {
    flex-wrap: wrap;
  }
  .donut {
    width: 130px;
    height: 130px;
    padding: 23px;
  }
  .welcome-steps {
    gap: 15px;
  }
}
</style>
