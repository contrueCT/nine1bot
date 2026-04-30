<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Activity,
  AlertTriangle,
  Bot,
  Coins,
  Hammer,
  Radar,
  RefreshCw,
  ServerCrash,
  SlidersHorizontal,
  TimerReset,
  Waves,
  X,
} from 'lucide-vue-next'
import {
  api,
  type MetricsDashboardPayload,
  type MetricsDetailEvent,
  type MetricsOverview,
  type MetricsTimelineBucket,
  type ModelMetricsRow,
  type ResourceMetricsRow,
  type SessionDebugResponse,
  type ToolMetricsRow,
} from '../api/client'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (event: 'open-session', sessionId: string): void
}>()

type WindowOption = '1h' | '24h' | '7d'
type Severity = 'healthy' | 'watch' | 'critical'
type ModelSortKey = 'turns' | 'latency' | 'cost' | 'failures'
type ToolSortKey = 'calls' | 'successRate' | 'latency' | 'failures'
type ResourceSortKey = 'failures' | 'recoverable' | 'statusBreadth'
type TimelineMetricKey = 'requests' | 'latency' | 'tokens' | 'cost' | 'tools'
type DetailSelection =
  | { kind: 'model'; title: string; subtitle: string; params: { kind: 'turn'; providerID: string; modelID: string } }
  | { kind: 'tool'; title: string; subtitle: string; params: { kind: 'tool'; tool: string } }
  | {
      kind: 'resource'
      title: string
      subtitle: string
      params: { kind: 'resource'; resourceType: 'mcp' | 'skill'; resourceID: string }
    }

const selectedWindow = ref<WindowOption>('24h')
const isLoading = ref(false)
const error = ref('')
const overview = ref<MetricsOverview | null>(null)
const models = ref<ModelMetricsRow[]>([])
const tools = ref<ToolMetricsRow[]>([])
const resources = ref<ResourceMetricsRow[]>([])
const timeline = ref<MetricsTimelineBucket[]>([])
const autoRefresh = ref(true)
const timelineMetric = ref<TimelineMetricKey>('requests')

const modelSearch = ref('')
const modelProviderFilter = ref('all')
const modelSort = ref<ModelSortKey>('turns')

const toolSearch = ref('')
const toolHealthFilter = ref<'all' | Severity>('all')
const toolSort = ref<ToolSortKey>('calls')

const resourceSearch = ref('')
const resourceTypeFilter = ref<'all' | ResourceMetricsRow['resourceType']>('all')
const resourceSeverityFilter = ref<'all' | Severity>('all')
const resourceSort = ref<ResourceSortKey>('failures')
const detailSelection = ref<DetailSelection | null>(null)
const detailEvents = ref<MetricsDetailEvent[]>([])
const detailLoading = ref(false)
const detailError = ref('')
const detailDebug = ref<SessionDebugResponse | null>(null)
const detailDebugLoading = ref(false)
const detailDebugError = ref('')

let refreshTimer: ReturnType<typeof setInterval> | null = null
let metricsRequestId = 0
let detailRequestId = 0
let detailDebugRequestId = 0

const providerOptions = computed(() =>
  [...new Set(models.value.map((row) => row.providerID).filter(Boolean))].sort(),
)

const attentionSummary = computed(() => {
  const modelHotspots = models.value.filter((row) => modelSeverity(row) !== 'healthy').length
  const toolHotspots = tools.value.filter((row) => toolSeverity(row) !== 'healthy').length
  const resourceHotspots = resources.value.filter((row) => resourceSeverity(row) !== 'healthy').length

  const items: string[] = []
  if (overview.value?.p95ApiDurationMs && overview.value.p95ApiDurationMs >= 10_000) {
    items.push(`P95 API latency is elevated at ${formatDuration(overview.value.p95ApiDurationMs)}`)
  }
  if (overview.value?.busyRejectRate && overview.value.busyRejectRate >= 0.1) {
    items.push(`Busy rejects are high at ${formatPercent(overview.value.busyRejectRate)}`)
  }
  if (modelHotspots) items.push(`${formatNumber(modelHotspots)} model lanes need attention`)
  if (toolHotspots) items.push(`${formatNumber(toolHotspots)} tools are degraded or failing`)
  if (resourceHotspots) items.push(`${formatNumber(resourceHotspots)} resource dependencies are unstable`)
  return items.slice(0, 4)
})

const overviewCards = computed<Array<{
  label: string
  value: string
  note: string
  icon: unknown
  tone: Severity
}>>(() => {
  const value = overview.value
  if (!value) return []
  return [
    {
      label: 'Requests',
      value: formatNumber(value.requestsTotal),
      note: `${formatPercent(value.successRate)} success`,
      icon: Activity,
      tone: severityFromRate(value.successRate, { watchBelow: 0.95, criticalBelow: 0.85 }),
    },
    {
      label: 'P95 API',
      value: formatDuration(value.p95ApiDurationMs),
      note: `P99 ${formatDuration(value.p99ApiDurationMs)}`,
      icon: TimerReset,
      tone: severityFromDuration(value.p95ApiDurationMs, { watchAbove: 4000, criticalAbove: 10000 }),
    },
    {
      label: 'Tokens',
      value: formatCompactNumber(value.totalTokens),
      note: `${formatCurrency(value.totalCostUsd)} spend`,
      icon: Coins,
      tone: value.totalCostUsd >= 25 ? 'watch' : 'healthy',
    },
    {
      label: 'Tools',
      value: formatNumber(value.toolCallsTotal),
      note: `${formatPercent(value.toolSuccessRate)} success`,
      icon: Hammer,
      tone: severityFromRate(value.toolSuccessRate, { watchBelow: 0.92, criticalBelow: 0.8 }),
    },
    {
      label: 'Busy Rejects',
      value: formatNumber(value.busyRejects),
      note: `${formatPercent(value.busyRejectRate)} of requests`,
      icon: Waves,
      tone: severityFromRate(value.busyRejectRate, { watchAbove: 0.03, criticalAbove: 0.1 }),
    },
    {
      label: 'Resource Failures',
      value: formatNumber(value.resourceFailuresTotal),
      note: 'MCP / skill issues',
      icon: ServerCrash,
      tone: value.resourceFailuresTotal >= 5 ? 'critical' : value.resourceFailuresTotal > 0 ? 'watch' : 'healthy',
    },
  ]
})

const topModel = computed(() => models.value[0] ?? null)
const topTool = computed(() => tools.value[0] ?? null)
const topResource = computed(() => resources.value[0] ?? null)
const requestTrendPath = computed(() => sparklinePath(timeline.value.map((bucket) => bucket.requests)))
const latencyTrendPath = computed(() => sparklinePath(timeline.value.map((bucket) => bucket.avgApiDurationMs)))
const tokenTrendPath = computed(() => sparklinePath(timeline.value.map((bucket) => bucket.totalTokens)))
const costTrendPath = computed(() => sparklinePath(timeline.value.map((bucket) => bucket.totalCostUsd)))
const latestTrend = computed(() => timeline.value[timeline.value.length - 1] ?? null)
const timelineMetricOptions: Array<{ key: TimelineMetricKey; label: string }> = [
  { key: 'requests', label: 'Requests' },
  { key: 'latency', label: 'Latency' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'cost', label: 'Cost' },
  { key: 'tools', label: 'Tools' },
]

const timelineMetricConfig = computed(() => {
  if (timelineMetric.value === 'latency') {
    return {
      label: 'Avg API latency',
      values: timeline.value.map((bucket) => bucket.avgApiDurationMs),
      colorClass: 'warm',
      formatter: formatDuration,
    }
  }
  if (timelineMetric.value === 'tokens') {
    return {
      label: 'Token throughput',
      values: timeline.value.map((bucket) => bucket.totalTokens),
      colorClass: 'cool',
      formatter: formatCompactNumber,
    }
  }
  if (timelineMetric.value === 'cost') {
    return {
      label: 'Cost trend',
      values: timeline.value.map((bucket) => bucket.totalCostUsd),
      colorClass: 'danger',
      formatter: formatCurrency,
    }
  }
  if (timelineMetric.value === 'tools') {
    return {
      label: 'Tool calls',
      values: timeline.value.map((bucket) => bucket.toolCalls),
      colorClass: 'accent',
      formatter: formatNumber,
    }
  }
  return {
    label: 'Request volume',
    values: timeline.value.map((bucket) => bucket.requests),
    colorClass: 'accent',
    formatter: formatNumber,
  }
})

const timelineChart = computed(() => buildChartGeometry(timelineMetricConfig.value.values, 720, 220))
const timelineStats = computed(() => {
  const values = timelineMetricConfig.value.values
  const latest = values[values.length - 1]
  return {
    latest,
    min: values.length ? Math.min(...values) : undefined,
    max: values.length ? Math.max(...values) : undefined,
  }
})

const modelBars = computed(() => {
  const top = [...models.value]
    .sort((a, b) => b.turns - a.turns)
    .slice(0, 5)
  const max = Math.max(...top.map((row) => row.turns), 1)
  return top.map((row) => ({
    label: `${row.providerID}/${row.modelID}`,
    value: row.turns,
    width: `${Math.max(12, (row.turns / max) * 100)}%`,
    note: `${formatCurrency(row.totalCostUsd)} · ${formatDuration(row.p95DurationMs)}`,
    tone: modelSeverity(row),
  }))
})

const toolBars = computed(() => {
  const top = [...tools.value]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5)
  const max = Math.max(...top.map((row) => row.calls), 1)
  return top.map((row) => ({
    label: row.tool,
    value: row.calls,
    width: `${Math.max(12, (row.calls / max) * 100)}%`,
    note: `${formatPercent(row.successRate)} success · ${formatDuration(row.p95DurationMs)}`,
    tone: toolSeverity(row),
  }))
})

const filteredModels = computed(() => {
  const keyword = modelSearch.value.trim().toLowerCase()
  return [...models.value]
    .filter((row) => modelProviderFilter.value === 'all' || row.providerID === modelProviderFilter.value)
    .filter((row) => {
      if (!keyword) return true
      const label = `${row.providerID}/${row.modelID}`.toLowerCase()
      return label.includes(keyword)
    })
    .sort((a, b) => {
      if (modelSort.value === 'latency') return numberOrZero(b.p95DurationMs) - numberOrZero(a.p95DurationMs)
      if (modelSort.value === 'cost') return numberOrZero(b.totalCostUsd) - numberOrZero(a.totalCostUsd)
      if (modelSort.value === 'failures') return modelFailureRate(b) - modelFailureRate(a)
      return b.turns - a.turns
    })
})

const filteredTools = computed(() => {
  const keyword = toolSearch.value.trim().toLowerCase()
  return [...tools.value]
    .filter((row) => {
      if (toolHealthFilter.value === 'all') return true
      return toolSeverity(row) === toolHealthFilter.value
    })
    .filter((row) => !keyword || row.tool.toLowerCase().includes(keyword))
    .sort((a, b) => {
      if (toolSort.value === 'successRate') return b.successRate - a.successRate
      if (toolSort.value === 'latency') return numberOrZero(b.p95DurationMs) - numberOrZero(a.p95DurationMs)
      if (toolSort.value === 'failures') return toolFailureRate(b) - toolFailureRate(a)
      return b.calls - a.calls
    })
})

const filteredResources = computed(() => {
  const keyword = resourceSearch.value.trim().toLowerCase()
  return [...resources.value]
    .filter((row) => resourceTypeFilter.value === 'all' || row.resourceType === resourceTypeFilter.value)
    .filter((row) => {
      if (resourceSeverityFilter.value === 'all') return true
      return resourceSeverity(row) === resourceSeverityFilter.value
    })
    .filter((row) => {
      if (!keyword) return true
      const label = `${row.resourceType} ${row.resourceID}`.toLowerCase()
      return label.includes(keyword)
    })
    .sort((a, b) => {
      if (resourceSort.value === 'recoverable') return b.recoverableFailures - a.recoverableFailures
      if (resourceSort.value === 'statusBreadth') return Object.keys(b.statuses).length - Object.keys(a.statuses).length
      return b.failures - a.failures
    })
})

const detailSessionId = computed(() => {
  for (const event of detailEvents.value) {
    if ('sessionID' in event && event.sessionID) return event.sessionID
  }
  return null
})

async function loadMetrics() {
  const requestId = ++metricsRequestId
  isLoading.value = true
  error.value = ''
  try {
    const payload: MetricsDashboardPayload = await api.getMetricsDashboard(selectedWindow.value)
    if (requestId !== metricsRequestId) return
    overview.value = payload.overview
    models.value = payload.models
    tools.value = payload.tools
    resources.value = payload.resources
    timeline.value = payload.timeline
  } catch (err) {
    if (requestId !== metricsRequestId) return
    error.value = err instanceof Error ? err.message : 'Failed to load metrics'
  } finally {
    if (requestId !== metricsRequestId) return
    isLoading.value = false
  }
}

async function openModelDetail(row: ModelMetricsRow) {
  detailSelection.value = {
    kind: 'model',
    title: `${row.providerID}/${row.modelID}`,
    subtitle: 'Recent turn events, finish reasons, and token/cost samples.',
    params: {
      kind: 'turn',
      providerID: row.providerID,
      modelID: row.modelID,
    },
  }
  await loadDetail()
}

async function openToolDetail(row: ToolMetricsRow) {
  detailSelection.value = {
    kind: 'tool',
    title: row.tool,
    subtitle: 'Recent tool lifecycle events with duration and failure context.',
    params: {
      kind: 'tool',
      tool: row.tool,
    },
  }
  await loadDetail()
}

async function openResourceDetail(row: ResourceMetricsRow) {
  detailSelection.value = {
    kind: 'resource',
    title: `${row.resourceType} / ${row.resourceID}`,
    subtitle: 'Recent resource failures and recovery-related runtime events.',
    params: {
      kind: 'resource',
      resourceType: row.resourceType,
      resourceID: row.resourceID,
    },
  }
  await loadDetail()
}

async function loadDetail() {
  if (!detailSelection.value) return
  const requestId = ++detailRequestId
  detailLoading.value = true
  detailError.value = ''
  detailDebug.value = null
  detailDebugLoading.value = false
  detailDebugError.value = ''
  try {
    const events = await api.getMetricsEvents({
      ...detailSelection.value.params,
      window: selectedWindow.value,
      limit: 40,
    })
    if (requestId !== detailRequestId) return
    detailEvents.value = events
  } catch (err) {
    if (requestId !== detailRequestId) return
    detailError.value = err instanceof Error ? err.message : 'Failed to load detail events'
    detailEvents.value = []
  } finally {
    if (requestId !== detailRequestId) return
    detailLoading.value = false
  }
}

function closeDetail() {
  detailRequestId += 1
  detailDebugRequestId += 1
  detailSelection.value = null
  detailEvents.value = []
  detailError.value = ''
  detailDebug.value = null
  detailDebugLoading.value = false
  detailDebugError.value = ''
}

function openDetailSession() {
  if (!detailSessionId.value) return
  emit('open-session', detailSessionId.value)
}

async function loadDetailDebug() {
  if (!detailSessionId.value) return
  const requestId = ++detailDebugRequestId
  detailDebugLoading.value = true
  detailDebugError.value = ''
  try {
    const debug = await api.getSessionDebug(detailSessionId.value)
    if (requestId !== detailDebugRequestId || !detailSelection.value) return
    detailDebug.value = debug
  } catch (err) {
    if (requestId !== detailDebugRequestId) return
    detailDebugError.value = err instanceof Error ? err.message : 'Failed to load session debug'
    detailDebug.value = null
  } finally {
    if (requestId !== detailDebugRequestId) return
    detailDebugLoading.value = false
  }
}

function syncAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  if (!autoRefresh.value || !props.visible) return
  refreshTimer = setInterval(() => {
    if (isLoading.value) return
    void loadMetrics()
  }, 15000)
}

function modelFailureRate(row: ModelMetricsRow) {
  const total = row.turns + row.failures
  if (!total) return 0
  return row.failures / total
}

function toolFailureRate(row: ToolMetricsRow) {
  if (!row.calls) return 0
  return row.failures / row.calls
}

function modelSeverity(row: ModelMetricsRow): Severity {
  if (
    modelFailureRate(row) >= 0.2 ||
    numberOrZero(row.p95DurationMs) >= 15_000 ||
    numberOrZero(row.avgFirstTokenLatencyMs) >= 5_000
  ) {
    return 'critical'
  }
  if (
    row.failures > 0 ||
    numberOrZero(row.p95DurationMs) >= 8_000 ||
    numberOrZero(row.avgFirstTokenLatencyMs) >= 3_000
  ) {
    return 'watch'
  }
  return 'healthy'
}

function toolSeverity(row: ToolMetricsRow): Severity {
  if (row.successRate < 0.8 || numberOrZero(row.p95DurationMs) >= 15_000) return 'critical'
  if (row.successRate < 0.92 || numberOrZero(row.p95DurationMs) >= 8_000 || row.failures > 0) return 'watch'
  return 'healthy'
}

function resourceSeverity(row: ResourceMetricsRow): Severity {
  const unrecoverable = row.failures - row.recoverableFailures
  if (unrecoverable >= 3 || row.failures >= 5) return 'critical'
  if (row.failures > 0) return 'watch'
  return 'healthy'
}

function severityFromDuration(
  value: number | undefined,
  thresholds: { watchAbove: number; criticalAbove: number },
): Severity {
  if (value === undefined) return 'healthy'
  if (value >= thresholds.criticalAbove) return 'critical'
  if (value >= thresholds.watchAbove) return 'watch'
  return 'healthy'
}

function severityFromRate(
  value: number | undefined,
  thresholds: { watchBelow?: number; criticalBelow?: number; watchAbove?: number; criticalAbove?: number },
): Severity {
  if (value === undefined) return 'healthy'
  if (thresholds.criticalBelow !== undefined && value <= thresholds.criticalBelow) return 'critical'
  if (thresholds.watchBelow !== undefined && value <= thresholds.watchBelow) return 'watch'
  if (thresholds.criticalAbove !== undefined && value >= thresholds.criticalAbove) return 'critical'
  if (thresholds.watchAbove !== undefined && value >= thresholds.watchAbove) return 'watch'
  return 'healthy'
}

function severityLabel(value: Severity) {
  if (value === 'critical') return 'Critical'
  if (value === 'watch') return 'Watch'
  return 'Healthy'
}

function detailStatusTone(event: MetricsDetailEvent): Severity {
  if (event.kind === 'controller_api') {
    if (event.status >= 500 || event.busy) return 'critical'
    if (event.status >= 400 || event.durationMs >= 5000) return 'watch'
    return 'healthy'
  }
  if (event.kind === 'turn') {
    if (event.status === 'failed') return 'critical'
    if (numberOrZero(event.durationMs) >= 10000 || numberOrZero(event.firstTokenLatencyMs) >= 4000) return 'watch'
    return 'healthy'
  }
  if (event.kind === 'tool') {
    if (event.status === 'failed') return 'critical'
    if (event.status === 'started' || numberOrZero(event.durationMs) >= 8000) return 'watch'
    return 'healthy'
  }
  if (event.status === 'failed') return event.recoverable ? 'watch' : 'critical'
  return 'healthy'
}

function detailEventTitle(event: MetricsDetailEvent) {
  if (event.kind === 'controller_api') return `${event.method} ${event.route}`
  if (event.kind === 'turn') return event.status === 'failed' ? 'Turn failed' : 'Turn completed'
  if (event.kind === 'tool') return `${event.tool} · ${event.status}`
  return event.status === 'failed' ? `${event.resourceType} / ${event.resourceID}` : 'Resource resolution'
}

function detailEventSummary(event: MetricsDetailEvent) {
  if (event.kind === 'controller_api') {
    return `HTTP ${event.status} · ${formatDuration(event.durationMs)}${event.errorType ? ` · ${event.errorType}` : ''}`
  }
  if (event.kind === 'turn') {
    if (event.status === 'failed') {
      return `${event.providerID ?? 'unknown'}/${event.modelID ?? 'unknown'} · ${event.errorType ?? 'TurnError'}`
    }
    const tokenTotal =
      (event.tokens?.input ?? 0) +
      (event.tokens?.output ?? 0) +
      (event.tokens?.reasoning ?? 0) +
      (event.tokens?.cache.read ?? 0) +
      (event.tokens?.cache.write ?? 0)
    return `${event.providerID ?? 'unknown'}/${event.modelID ?? 'unknown'} · ${formatCompactNumber(tokenTotal)} tokens · ${formatCurrency(event.costUsd)}`
  }
  if (event.kind === 'tool') {
    return `${formatDuration(event.durationMs)}${event.status === 'failed' ? ` · ${event.errorType ?? 'ToolError'}` : ''}`
  }
  if (event.status === 'failed') {
    return `${event.failureStatus} · ${event.stage}${event.reason ? ` · ${event.reason}` : ''}`
  }
  return `${event.resolvedMcp ?? 0} MCP · ${event.resolvedSkills ?? 0} skills`
}

function detailMeta(event: MetricsDetailEvent) {
  const parts: string[] = []
  if ('sessionID' in event && event.sessionID) parts.push(`session ${event.sessionID}`)
  if ('turnSnapshotId' in event && event.turnSnapshotId) parts.push(`turn ${event.turnSnapshotId}`)
  if (event.kind === 'tool') parts.push(`call ${event.toolCallId}`)
  if (event.kind === 'controller_api' && event.traceId) parts.push(`trace ${event.traceId}`)
  return parts.join(' · ')
}

function formatDebugFailures(debug?: SessionDebugResponse | null) {
  const failures = debug?.resourceAudit?.failures ?? []
  if (!failures.length) return 'No resource failures recorded.'
  return failures
    .slice(0, 3)
    .map((item) => `${item.resourceType}/${item.resourceID} · ${item.status} · ${item.stage}`)
    .join(' · ')
}

function numberOrZero(value?: number) {
  return value ?? 0
}

function formatNumber(value?: number) {
  if (value === undefined) return '--'
  return new Intl.NumberFormat().format(value)
}

function formatCompactNumber(value?: number) {
  if (value === undefined) return '--'
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatCurrency(value?: number) {
  if (value === undefined) return '--'
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value)
}

function formatPercent(value?: number) {
  if (value === undefined) return '--'
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value)
}

function formatDuration(value?: number) {
  if (value === undefined) return '--'
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`
  return `${Math.round(value)}ms`
}

function formatRecord(record: Record<string, number>) {
  const entries = Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  if (!entries.length) return '--'
  return entries.map(([key, count]) => `${key} ${count}`).join(' · ')
}

function formatTimeLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: selectedWindow.value === '7d' ? 'short' : undefined,
    day: selectedWindow.value === '7d' ? 'numeric' : undefined,
  }).format(timestamp)
}

function sparklinePath(values: number[]) {
  if (!values.length) return ''
  const width = 240
  const height = 72
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  return values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width
      const y = height - ((value - min) / range) * (height - 8) - 4
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

function buildChartGeometry(values: number[], width: number, height: number) {
  if (!values.length) {
    return {
      linePath: '',
      areaPath: '',
      points: [] as Array<{ x: number; y: number; value: number; index: number }>,
    }
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width
    const y = height - ((value - min) / range) * (height - 24) - 12
    return { x, y, value, index }
  })
  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${(height - 4).toFixed(2)} L ${points[0].x.toFixed(2)} ${(height - 4).toFixed(2)} Z`
  return { linePath, areaPath, points }
}

watch(selectedWindow, () => {
  if (props.visible) void loadMetrics()
  if (detailSelection.value) void loadDetail()
  syncAutoRefresh()
})

watch(
  () => props.visible,
  (visible) => {
    if (visible) void loadMetrics()
    syncAutoRefresh()
  },
)

watch(autoRefresh, () => {
  syncAutoRefresh()
})

onMounted(() => {
  if (props.visible) void loadMetrics()
  syncAutoRefresh()
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <section class="metrics-page">
    <div class="metrics-shell" :class="{ 'has-detail': !!detailSelection }">
      <div class="metrics-hero">
        <div>
          <p class="metrics-kicker">Runtime Observability</p>
          <h1 class="metrics-title">Metrics dashboard for latency, token spend, tools, and runtime health.</h1>
          <p class="metrics-subtitle">
            Aggregated from Controller API metrics and runtime turn/tool/resource events.
          </p>
        </div>

        <div class="metrics-toolbar">
          <div class="window-switcher">
            <button
              v-for="option in ['1h', '24h', '7d']"
              :key="option"
              class="window-chip"
              :class="{ active: selectedWindow === option }"
              @click="selectedWindow = option as WindowOption"
            >
              {{ option }}
            </button>
          </div>
          <label class="auto-refresh-toggle">
            <input v-model="autoRefresh" type="checkbox" />
            <span>Auto refresh</span>
          </label>
          <button class="refresh-button" :disabled="isLoading" @click="loadMetrics">
            <RefreshCw :size="16" :class="{ spinning: isLoading }" />
            <span>{{ isLoading ? 'Refreshing' : 'Refresh' }}</span>
          </button>
        </div>
      </div>

        <div v-if="error" class="metrics-error">
          <ServerCrash :size="18" />
          <span>{{ error }}</span>
        </div>

      <div v-if="attentionSummary.length" class="attention-strip">
        <div class="attention-strip-head">
          <AlertTriangle :size="16" />
          <span>Needs attention</span>
        </div>
        <div class="attention-pills">
          <span v-for="item in attentionSummary" :key="item" class="attention-pill">
            {{ item }}
          </span>
        </div>
      </div>

      <div class="overview-grid">
        <article
          v-for="card in overviewCards"
          :key="card.label"
          class="overview-card"
          :class="`severity-${card.tone}`"
        >
          <div class="overview-card-head">
            <span>{{ card.label }}</span>
            <component :is="card.icon" :size="16" />
          </div>
          <div class="overview-card-value">{{ card.value }}</div>
          <div class="overview-card-note">{{ card.note }}</div>
          <div class="severity-pill" :class="`severity-${card.tone}`">
            {{ severityLabel(card.tone) }}
          </div>
        </article>
      </div>

      <div class="trend-grid">
        <article class="trend-card">
          <div class="trend-head">
            <div>
              <span>Request volume</span>
              <strong>{{ latestTrend ? formatNumber(latestTrend.requests) : '--' }}</strong>
            </div>
            <Activity :size="18" />
          </div>
          <svg class="trend-chart" viewBox="0 0 240 72" preserveAspectRatio="none">
            <path v-if="requestTrendPath" :d="requestTrendPath" class="trend-line accent" />
          </svg>
          <div class="trend-foot">
            {{ timeline.length ? formatTimeLabel(timeline[0].timestamp) : '--' }} ·
            {{ latestTrend ? formatTimeLabel(latestTrend.timestamp) : '--' }}
          </div>
        </article>

        <article class="trend-card">
          <div class="trend-head">
            <div>
              <span>Avg API latency</span>
              <strong>{{ latestTrend ? formatDuration(latestTrend.avgApiDurationMs) : '--' }}</strong>
            </div>
            <TimerReset :size="18" />
          </div>
          <svg class="trend-chart" viewBox="0 0 240 72" preserveAspectRatio="none">
            <path v-if="latencyTrendPath" :d="latencyTrendPath" class="trend-line warm" />
          </svg>
          <div class="trend-foot">Bucketed by current window</div>
        </article>

        <article class="trend-card">
          <div class="trend-head">
            <div>
              <span>Token throughput</span>
              <strong>{{ latestTrend ? formatCompactNumber(latestTrend.totalTokens) : '--' }}</strong>
            </div>
            <Radar :size="18" />
          </div>
          <svg class="trend-chart" viewBox="0 0 240 72" preserveAspectRatio="none">
            <path v-if="tokenTrendPath" :d="tokenTrendPath" class="trend-line cool" />
          </svg>
          <div class="trend-foot">Input + output + reasoning + cache</div>
        </article>

        <article class="trend-card">
          <div class="trend-head">
            <div>
              <span>Cost trend</span>
              <strong>{{ latestTrend ? formatCurrency(latestTrend.totalCostUsd) : '--' }}</strong>
            </div>
            <Coins :size="18" />
          </div>
          <svg class="trend-chart" viewBox="0 0 240 72" preserveAspectRatio="none">
            <path v-if="costTrendPath" :d="costTrendPath" class="trend-line danger" />
          </svg>
          <div class="trend-foot">{{ formatNumber(timeline.length) }} buckets in window</div>
        </article>
      </div>

      <div class="visual-grid">
        <section class="visual-panel visual-panel-wide">
          <div class="panel-head">
            <div>
              <h2>Deep Trends</h2>
              <span>Interactive time-series view for the current window</span>
            </div>
            <div class="chart-switcher">
              <button
                v-for="option in timelineMetricOptions"
                :key="option.key"
                class="chart-chip"
                :class="{ active: timelineMetric === option.key }"
                @click="timelineMetric = option.key"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <div class="chart-stage">
            <svg class="timeline-chart-large" viewBox="0 0 720 220" preserveAspectRatio="none">
              <defs>
                <linearGradient id="metrics-area-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stop-color="currentColor" stop-opacity="0.25" />
                  <stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
                </linearGradient>
              </defs>
              <path
                v-if="timelineChart.areaPath"
                :d="timelineChart.areaPath"
                class="timeline-area"
                :class="timelineMetricConfig.colorClass"
              />
              <path
                v-if="timelineChart.linePath"
                :d="timelineChart.linePath"
                class="timeline-line-large"
                :class="timelineMetricConfig.colorClass"
              />
              <circle
                v-for="point in timelineChart.points"
                :key="`${timelineMetric}-${point.index}`"
                :cx="point.x"
                :cy="point.y"
                r="3.5"
                class="timeline-dot"
                :class="timelineMetricConfig.colorClass"
              />
            </svg>
          </div>

          <div class="chart-legend">
            <div class="chart-legend-item">
              <span class="chart-label">Metric</span>
              <strong>{{ timelineMetricConfig.label }}</strong>
            </div>
            <div class="chart-legend-item">
              <span class="chart-label">Latest</span>
              <strong>{{ timelineMetricConfig.formatter(timelineStats.latest) }}</strong>
            </div>
            <div class="chart-legend-item">
              <span class="chart-label">Range</span>
              <strong>
                {{ timelineMetricConfig.formatter(timelineStats.min) }} - {{ timelineMetricConfig.formatter(timelineStats.max) }}
              </strong>
            </div>
          </div>
        </section>

        <section class="visual-panel">
          <div class="panel-head">
            <div>
              <h2>Model Mix</h2>
              <span>Top lanes by conversation traffic</span>
            </div>
          </div>
          <div class="bar-list">
            <article v-for="row in modelBars" :key="row.label" class="bar-item">
              <div class="bar-item-head">
                <strong>{{ row.label }}</strong>
                <span>{{ formatNumber(row.value) }}</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" :class="`severity-${row.tone}`" :style="{ width: row.width }"></div>
              </div>
              <small>{{ row.note }}</small>
            </article>
            <div v-if="!modelBars.length" class="table-empty">No model traffic yet.</div>
          </div>
        </section>

        <section class="visual-panel">
          <div class="panel-head">
            <div>
              <h2>Tool Mix</h2>
              <span>Top lanes by tool usage</span>
            </div>
          </div>
          <div class="bar-list">
            <article v-for="row in toolBars" :key="row.label" class="bar-item">
              <div class="bar-item-head">
                <strong>{{ row.label }}</strong>
                <span>{{ formatNumber(row.value) }}</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" :class="`severity-${row.tone}`" :style="{ width: row.width }"></div>
              </div>
              <small>{{ row.note }}</small>
            </article>
            <div v-if="!toolBars.length" class="table-empty">No tool traffic yet.</div>
          </div>
        </section>
      </div>

      <div class="highlight-grid">
        <article class="highlight-card">
          <div class="highlight-head">
            <Bot :size="18" />
            <span>Top model</span>
          </div>
          <div v-if="topModel" class="highlight-body">
            <div class="highlight-title-row">
              <strong>{{ topModel.providerID }}/{{ topModel.modelID }}</strong>
              <span class="severity-pill" :class="`severity-${modelSeverity(topModel)}`">
                {{ severityLabel(modelSeverity(topModel)) }}
              </span>
            </div>
            <span>{{ formatNumber(topModel.turns) }} turns · {{ formatCurrency(topModel.totalCostUsd) }}</span>
            <small>{{ formatRecord(topModel.finishReasons) }}</small>
          </div>
          <div v-else class="highlight-empty">No model traffic yet.</div>
        </article>

        <article class="highlight-card">
          <div class="highlight-head">
            <Hammer :size="18" />
            <span>Most-used tool</span>
          </div>
          <div v-if="topTool" class="highlight-body">
            <div class="highlight-title-row">
              <strong>{{ topTool.tool }}</strong>
              <span class="severity-pill" :class="`severity-${toolSeverity(topTool)}`">
                {{ severityLabel(toolSeverity(topTool)) }}
              </span>
            </div>
            <span>{{ formatNumber(topTool.calls) }} calls · {{ formatPercent(topTool.successRate) }}</span>
            <small>{{ formatRecord(topTool.failureReasons) }}</small>
          </div>
          <div v-else class="highlight-empty">No tool activity yet.</div>
        </article>

        <article class="highlight-card">
          <div class="highlight-head">
            <ServerCrash :size="18" />
            <span>Top resource issue</span>
          </div>
          <div v-if="topResource" class="highlight-body">
            <div class="highlight-title-row">
              <strong>{{ topResource.resourceType }} / {{ topResource.resourceID }}</strong>
              <span class="severity-pill" :class="`severity-${resourceSeverity(topResource)}`">
                {{ severityLabel(resourceSeverity(topResource)) }}
              </span>
            </div>
            <span>{{ formatNumber(topResource.failures) }} failures</span>
            <small>{{ formatRecord(topResource.statuses) }}</small>
          </div>
          <div v-else class="highlight-empty">No resource failures in this window.</div>
        </article>
      </div>

      <div class="metrics-panels">
        <section class="metrics-panel">
          <div class="panel-head">
            <div>
              <h2>Models</h2>
              <span>Latency, token, cost, finish reason</span>
            </div>
            <div class="panel-controls">
              <div class="filter-group">
                <SlidersHorizontal :size="14" />
                <input v-model="modelSearch" class="filter-input" placeholder="Search model" />
                <select v-model="modelProviderFilter" class="filter-select">
                  <option value="all">All providers</option>
                  <option v-for="provider in providerOptions" :key="provider" :value="provider">
                    {{ provider }}
                  </option>
                </select>
                <select v-model="modelSort" class="filter-select">
                  <option value="turns">Sort: traffic</option>
                  <option value="latency">Sort: latency</option>
                  <option value="cost">Sort: cost</option>
                  <option value="failures">Sort: failure rate</option>
                </select>
              </div>
            </div>
          </div>
          <div class="table-wrap">
            <table class="metrics-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Turns</th>
                  <th>First token</th>
                  <th>P95 duration</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                  <th>Finish reasons</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in filteredModels"
                  :key="`${row.providerID}/${row.modelID}`"
                  :class="`row-${modelSeverity(row)}`"
                  class="detail-row"
                  @click="openModelDetail(row)"
                >
                  <td>
                    <div class="primary-cell">
                      <strong>{{ row.providerID }}/{{ row.modelID }}</strong>
                      <small>{{ formatNumber(row.failures) }} failed</small>
                    </div>
                  </td>
                  <td>
                    <span class="severity-pill" :class="`severity-${modelSeverity(row)}`">
                      {{ severityLabel(modelSeverity(row)) }}
                    </span>
                  </td>
                  <td>{{ formatNumber(row.turns) }}</td>
                  <td>{{ formatDuration(row.avgFirstTokenLatencyMs) }}</td>
                  <td>{{ formatDuration(row.p95DurationMs) }}</td>
                  <td>{{ formatCompactNumber(row.totalInputTokens + row.totalOutputTokens + row.totalReasoningTokens) }}</td>
                  <td>{{ formatCurrency(row.totalCostUsd) }}</td>
                  <td class="cell-muted">{{ formatRecord(row.finishReasons) }}</td>
                </tr>
                <tr v-if="!filteredModels.length">
                  <td colspan="8" class="table-empty">
                    {{ models.length ? 'No model rows match the current filters.' : 'No model metrics in this window.' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="metrics-panel">
          <div class="panel-head">
            <div>
              <h2>Tools</h2>
              <span>Success rate, duration, failure patterns</span>
            </div>
            <div class="panel-controls">
              <div class="filter-group">
                <SlidersHorizontal :size="14" />
                <input v-model="toolSearch" class="filter-input" placeholder="Search tool" />
                <select v-model="toolHealthFilter" class="filter-select">
                  <option value="all">All health</option>
                  <option value="critical">Critical</option>
                  <option value="watch">Watch</option>
                  <option value="healthy">Healthy</option>
                </select>
                <select v-model="toolSort" class="filter-select">
                  <option value="calls">Sort: traffic</option>
                  <option value="successRate">Sort: success rate</option>
                  <option value="latency">Sort: latency</option>
                  <option value="failures">Sort: failure rate</option>
                </select>
              </div>
            </div>
          </div>
          <div class="table-wrap">
            <table class="metrics-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Status</th>
                  <th>Calls</th>
                  <th>Success rate</th>
                  <th>Avg duration</th>
                  <th>P95</th>
                  <th>Failures</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in filteredTools"
                  :key="row.tool"
                  :class="`row-${toolSeverity(row)}`"
                  class="detail-row"
                  @click="openToolDetail(row)"
                >
                  <td>{{ row.tool }}</td>
                  <td>
                    <span class="severity-pill" :class="`severity-${toolSeverity(row)}`">
                      {{ severityLabel(toolSeverity(row)) }}
                    </span>
                  </td>
                  <td>{{ formatNumber(row.calls) }}</td>
                  <td>{{ formatPercent(row.successRate) }}</td>
                  <td>{{ formatDuration(row.avgDurationMs) }}</td>
                  <td>{{ formatDuration(row.p95DurationMs) }}</td>
                  <td class="cell-muted">{{ formatRecord(row.failureReasons) }}</td>
                </tr>
                <tr v-if="!filteredTools.length">
                  <td colspan="7" class="table-empty">
                    {{ tools.length ? 'No tool rows match the current filters.' : 'No tool metrics in this window.' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="metrics-panel">
          <div class="panel-head">
            <div>
              <h2>Resources</h2>
              <span>MCP and skill degradation / auth issues</span>
            </div>
            <div class="panel-controls">
              <div class="filter-group">
                <SlidersHorizontal :size="14" />
                <input v-model="resourceSearch" class="filter-input" placeholder="Search resource" />
                <select v-model="resourceTypeFilter" class="filter-select">
                  <option value="all">All types</option>
                  <option value="mcp">MCP</option>
                  <option value="skill">Skill</option>
                </select>
                <select v-model="resourceSeverityFilter" class="filter-select">
                  <option value="all">All health</option>
                  <option value="critical">Critical</option>
                  <option value="watch">Watch</option>
                  <option value="healthy">Healthy</option>
                </select>
                <select v-model="resourceSort" class="filter-select">
                  <option value="failures">Sort: failures</option>
                  <option value="recoverable">Sort: recoverable</option>
                  <option value="statusBreadth">Sort: status breadth</option>
                </select>
              </div>
            </div>
          </div>
          <div class="table-wrap">
            <table class="metrics-table">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Status</th>
                  <th>Failures</th>
                  <th>Recoverable</th>
                  <th>Status mix</th>
                  <th>Stages</th>
                  <th>Reasons</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in filteredResources"
                  :key="`${row.resourceType}:${row.resourceID}`"
                  :class="`row-${resourceSeverity(row)}`"
                  class="detail-row"
                  @click="openResourceDetail(row)"
                >
                  <td>
                    <div class="primary-cell">
                      <strong>{{ row.resourceType }}</strong>
                      <small>{{ row.resourceID }}</small>
                    </div>
                  </td>
                  <td>
                    <span class="severity-pill" :class="`severity-${resourceSeverity(row)}`">
                      {{ severityLabel(resourceSeverity(row)) }}
                    </span>
                  </td>
                  <td>{{ formatNumber(row.failures) }}</td>
                  <td>{{ formatNumber(row.recoverableFailures) }}</td>
                  <td class="cell-muted">{{ formatRecord(row.statuses) }}</td>
                  <td class="cell-muted">{{ formatRecord(row.stages) }}</td>
                  <td class="cell-muted">{{ formatRecord(row.reasons) }}</td>
                </tr>
                <tr v-if="!filteredResources.length">
                  <td colspan="7" class="table-empty">
                    {{
                      resources.length
                        ? 'No resource rows match the current filters.'
                        : 'No resource failures in this window.'
                    }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div v-if="detailSelection" class="detail-drawer-overlay" @click.self="closeDetail">
        <aside class="detail-drawer">
          <div class="detail-drawer-head">
            <div>
              <p class="detail-kicker">Drill-down</p>
              <h3>{{ detailSelection.title }}</h3>
              <p class="detail-subtitle">{{ detailSelection.subtitle }}</p>
            </div>
            <div class="detail-drawer-actions">
              <button v-if="detailSessionId" class="detail-action" @click="openDetailSession">
                Open session
              </button>
              <button v-if="detailSessionId" class="detail-action" @click="loadDetailDebug">
                {{ detailDebugLoading ? 'Loading debug...' : 'Load debug' }}
              </button>
              <button class="detail-close" @click="closeDetail">
                <X :size="18" />
              </button>
            </div>
          </div>

          <div class="detail-drawer-body">

        <div v-if="detailError" class="metrics-error">
          <ServerCrash :size="18" />
          <span>{{ detailError }}</span>
        </div>

        <div v-else-if="detailLoading" class="detail-empty">
          Loading recent events...
        </div>

        <div v-else-if="!detailEvents.length" class="detail-empty">
          No matching events in this time window.
        </div>

        <div v-else class="detail-event-list">
          <article
            v-for="(event, index) in detailEvents"
            :key="`${event.kind}-${event.recordedAt}-${index}`"
            class="detail-event-card"
            :class="`severity-${detailStatusTone(event)}`"
          >
            <div class="detail-event-head">
              <span class="severity-pill" :class="`severity-${detailStatusTone(event)}`">
                {{ severityLabel(detailStatusTone(event)) }}
              </span>
              <time>{{ formatTimeLabel(event.recordedAt) }}</time>
            </div>
            <strong class="detail-event-title">{{ detailEventTitle(event) }}</strong>
            <p class="detail-event-summary">{{ detailEventSummary(event) }}</p>
            <small v-if="detailMeta(event)" class="detail-event-meta">{{ detailMeta(event) }}</small>
          </article>
        </div>

        <section v-if="detailDebug || detailDebugLoading || detailDebugError" class="debug-card">
          <div class="debug-card-head">
            <h4>Session debug</h4>
            <span v-if="detailDebug?.session?.runtime?.currentModel">
              {{ detailDebug.session.runtime.currentModel.providerID }}/{{ detailDebug.session.runtime.currentModel.modelID }}
            </span>
          </div>

          <div v-if="detailDebugError" class="metrics-error">
            <ServerCrash :size="18" />
            <span>{{ detailDebugError }}</span>
          </div>

          <div v-else-if="detailDebugLoading" class="detail-empty">
            Loading debug snapshot...
          </div>

          <div v-else-if="detailDebug" class="debug-grid">
            <article class="debug-item">
              <span>Status</span>
              <strong>{{ detailDebug.status?.type ?? 'unknown' }}</strong>
            </article>
            <article class="debug-item">
              <span>Agent</span>
              <strong>{{ detailDebug.session.runtime?.agent ?? 'default' }}</strong>
            </article>
            <article class="debug-item">
              <span>Profile snapshot</span>
              <strong>{{ detailDebug.profileSnapshot?.id ?? detailDebug.session.runtime?.profileSnapshotId ?? '--' }}</strong>
            </article>
            <article class="debug-item">
              <span>Recent messages</span>
              <strong>{{ formatNumber(detailDebug.recentMessages?.length ?? 0) }}</strong>
            </article>
            <article class="debug-item debug-item-wide">
              <span>Directory</span>
              <strong>{{ detailDebug.session.directory }}</strong>
            </article>
            <article class="debug-item debug-item-wide">
              <span>Resources</span>
              <strong>
                MCP {{ formatNumber(detailDebug.profileSnapshot?.resources?.mcp?.length ?? 0) }} ·
                Skills {{ formatNumber(detailDebug.profileSnapshot?.resources?.skills?.length ?? 0) }}
              </strong>
            </article>
            <article class="debug-item debug-item-wide">
              <span>Resource failures</span>
              <strong>{{ formatDebugFailures(detailDebug) }}</strong>
            </article>
          </div>
          </section>
          </div>
        </aside>
      </div>
    </div>
  </section>
</template>

<style scoped>
.metrics-page {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-lg);
}

.metrics-shell {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  max-width: 1280px;
  margin: 0 auto;
}

.metrics-shell.has-detail {
  align-items: stretch;
}

.metrics-hero {
  display: flex;
  justify-content: space-between;
  gap: var(--space-lg);
  align-items: flex-start;
  padding: var(--space-xl);
  border-radius: var(--radius-2xl);
  background:
    radial-gradient(circle at top right, var(--accent-subtle), transparent 30%),
    linear-gradient(135deg, var(--bg-elevated), color-mix(in srgb, var(--bg-elevated) 72%, var(--accent-subtle)));
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-md);
}

.metrics-kicker {
  margin-bottom: var(--space-sm);
  font-family: var(--font-sans);
  font-size: 0.78rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent);
}

.metrics-title {
  max-width: 780px;
  font-family: var(--font-display);
  font-size: clamp(2rem, 3vw, 3.4rem);
  line-height: 1.05;
  color: var(--text-primary);
}

.metrics-subtitle {
  max-width: 680px;
  margin-top: var(--space-md);
  color: var(--text-secondary);
  font-size: 1rem;
}

.metrics-toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  align-items: flex-end;
}

.auto-refresh-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-sans);
  color: var(--text-secondary);
  font-size: 0.88rem;
}

.auto-refresh-toggle input {
  accent-color: var(--accent);
}

.window-switcher {
  display: inline-flex;
  gap: 6px;
  padding: 6px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg-primary) 70%, transparent);
  border: 1px solid var(--border-default);
}

.window-chip,
.refresh-button {
  border: none;
  cursor: pointer;
  transition: transform var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
}

.window-chip {
  padding: 8px 12px;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-weight: 600;
}

.window-chip.active {
  background: var(--accent);
  color: var(--accent-fg);
}

.refresh-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-full);
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  font-family: var(--font-sans);
}

.refresh-button:hover,
.window-chip:hover {
  transform: translateY(-1px);
}

.refresh-button:disabled {
  opacity: 0.7;
  cursor: default;
}

.spinning {
  animation: spin 1s linear infinite;
}

.metrics-error,
.attention-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid;
}

.metrics-error {
  background: var(--error-subtle);
  color: var(--error);
  border-color: color-mix(in srgb, var(--error) 18%, transparent);
}

.attention-strip {
  justify-content: space-between;
  background: color-mix(in srgb, #f59e0b 10%, var(--bg-elevated));
  color: var(--text-primary);
  border-color: color-mix(in srgb, #f59e0b 28%, transparent);
}

.attention-strip-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-sans);
  font-weight: 700;
  white-space: nowrap;
}

.attention-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.attention-pill {
  padding: 6px 10px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg-primary) 84%, transparent);
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 0.82rem;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--space-md);
}

.overview-card,
.highlight-card,
.metrics-panel {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm);
}

.overview-card {
  padding: var(--space-md);
}

.overview-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 0.82rem;
}

.overview-card-value {
  margin-top: var(--space-md);
  font-size: 1.85rem;
  font-family: var(--font-display);
  line-height: 1;
}

.overview-card-note {
  margin-top: var(--space-sm);
  margin-bottom: var(--space-sm);
  color: var(--text-muted);
  font-size: 0.82rem;
}

.highlight-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-md);
}

.trend-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-md);
}

.trend-card {
  padding: var(--space-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm);
}

.trend-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-sm);
  font-family: var(--font-sans);
}

.trend-head span {
  display: block;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.trend-head strong {
  display: block;
  margin-top: 8px;
  font-family: var(--font-display);
  font-size: 1.6rem;
  line-height: 1;
}

.trend-chart {
  width: 100%;
  height: 72px;
  margin-top: var(--space-md);
}

.trend-line {
  fill: none;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.trend-line.accent { stroke: var(--accent); }
.trend-line.warm { stroke: #d97706; }
.trend-line.cool { stroke: #2563eb; }
.trend-line.danger { stroke: var(--error); }

.trend-foot {
  margin-top: var(--space-sm);
  color: var(--text-muted);
  font-family: var(--font-sans);
  font-size: 0.8rem;
}

.visual-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-md);
}

.visual-panel {
  padding: var(--space-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm);
}

.visual-panel-wide {
  grid-column: span 2;
}

.chart-switcher {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chart-chip {
  min-height: 34px;
  padding: 0 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-default);
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: 0.82rem;
  font-weight: 600;
}

.chart-chip.active {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}

.chart-stage {
  margin-top: var(--space-md);
  padding: var(--space-md);
  border-radius: var(--radius-xl);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-primary) 96%, white), var(--bg-primary));
  border: 1px solid var(--border-subtle);
}

.timeline-chart-large {
  width: 100%;
  height: 220px;
}

.timeline-line-large,
.timeline-area,
.timeline-dot {
  color: var(--accent);
}

.timeline-line-large {
  fill: none;
  stroke: currentColor;
  stroke-width: 3.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.timeline-area {
  fill: url(#metrics-area-fill);
}

.timeline-dot {
  fill: currentColor;
}

.chart-legend {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-sm);
  margin-top: var(--space-md);
}

.chart-legend-item {
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-primary) 92%, white);
}

.chart-label {
  display: block;
  color: var(--text-muted);
  font-size: 0.76rem;
  margin-bottom: 6px;
}

.bar-list {
  display: grid;
  gap: var(--space-sm);
}

.bar-item {
  padding: var(--space-sm) 0;
}

.bar-item-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: center;
  margin-bottom: 8px;
}

.bar-item small {
  display: block;
  margin-top: 8px;
  color: var(--text-muted);
}

.bar-track {
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--border-subtle) 55%, transparent);
}

.bar-fill {
  height: 100%;
  border-radius: 999px;
}

.highlight-card {
  padding: var(--space-lg);
}

.highlight-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--accent);
  font-family: var(--font-sans);
  font-weight: 600;
}

.highlight-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: var(--space-md);
}

.highlight-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.highlight-body strong {
  font-size: 1.05rem;
}

.highlight-body span,
.highlight-body small,
.highlight-empty {
  color: var(--text-secondary);
}

.metrics-panels {
  display: grid;
  gap: var(--space-md);
}

.metrics-panel {
  padding: var(--space-lg);
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}

.panel-head h2 {
  font-family: var(--font-display);
  font-size: 1.45rem;
}

.panel-head span {
  color: var(--text-muted);
  font-family: var(--font-sans);
  font-size: 0.82rem;
}

.panel-controls {
  display: flex;
  justify-content: flex-end;
}

.filter-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--bg-primary) 60%, transparent);
}

.filter-input,
.filter-select {
  min-height: 36px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  color: var(--text-primary);
  padding: 0 12px;
  font-family: var(--font-sans);
  font-size: 0.88rem;
}

.filter-input {
  min-width: 180px;
}

.table-wrap {
  overflow-x: auto;
}

.metrics-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-sans);
}

.metrics-table th,
.metrics-table td {
  padding: 14px 12px;
  border-top: 1px solid var(--border-subtle);
  text-align: left;
  vertical-align: top;
}

.metrics-table th {
  color: var(--text-muted);
  font-size: 0.76rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.primary-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.primary-cell small,
.cell-muted,
.table-empty {
  color: var(--text-muted);
}

.table-empty {
  text-align: center;
  padding: 24px 12px;
}

.detail-row {
  cursor: pointer;
  transition: background var(--transition-fast);
}

.detail-row:hover td {
  background: color-mix(in srgb, var(--accent-subtle) 30%, transparent);
}

.detail-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  align-items: stretch;
  padding: var(--space-lg);
  background: color-mix(in srgb, var(--bg-primary) 32%, transparent);
}

.detail-drawer {
  width: min(100%, 36rem);
  height: 100%;
  max-height: calc(100vh - (var(--space-lg) * 2));
  padding: var(--space-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  overflow: hidden;
  border-radius: var(--radius-2xl);
  border: 1px solid var(--border-default);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 92%, white), var(--bg-elevated));
  box-shadow: var(--shadow-md);
}

.detail-drawer-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-md);
  align-items: flex-start;
}

.detail-drawer-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

.detail-drawer-body {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  overflow-y: auto;
  padding-right: 6px;
  scrollbar-gutter: stable;
}

.detail-drawer-body::-webkit-scrollbar {
  width: 10px;
}

.detail-drawer-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--border-default) 78%, transparent);
  border-radius: 999px;
}

.detail-drawer-body::-webkit-scrollbar-track {
  background: transparent;
}

.detail-kicker {
  margin-bottom: 6px;
  color: var(--accent);
  font-size: 0.76rem;
  font-family: var(--font-sans);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.detail-drawer-head h3 {
  font-family: var(--font-display);
  font-size: 1.45rem;
}

.detail-subtitle {
  margin-top: 6px;
  color: var(--text-secondary);
}

.detail-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
}

.detail-action {
  min-height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-default);
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: 0.85rem;
  font-weight: 600;
}

.detail-event-list {
  display: grid;
  gap: var(--space-sm);
  margin-top: var(--space-md);
}

.detail-event-card {
  padding: var(--space-md);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-default);
  background: var(--bg-primary);
}

.detail-event-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: center;
}

.detail-event-head time {
  color: var(--text-muted);
  font-size: 0.82rem;
  font-family: var(--font-sans);
}

.detail-event-title {
  display: block;
  margin-top: var(--space-sm);
  font-family: var(--font-sans);
  font-size: 0.98rem;
}

.detail-event-summary {
  margin-top: 6px;
  color: var(--text-secondary);
}

.detail-event-meta,
.detail-empty {
  display: block;
  margin-top: 6px;
  color: var(--text-muted);
}

.debug-card {
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-subtle);
}

.debug-card-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: baseline;
  margin-bottom: var(--space-sm);
}

.debug-card-head h4 {
  font-family: var(--font-display);
  font-size: 1.1rem;
}

.debug-card-head span {
  color: var(--text-muted);
  font-size: 0.82rem;
}

.debug-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}

.debug-item {
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-primary) 92%, white);
}

.debug-item span {
  display: block;
  color: var(--text-muted);
  font-size: 0.78rem;
  margin-bottom: 6px;
}

.debug-item strong {
  color: var(--text-primary);
  word-break: break-word;
}

.debug-item-wide {
  grid-column: 1 / -1;
}

.severity-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  padding: 5px 10px;
  border-radius: var(--radius-full);
  font-family: var(--font-sans);
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  border: 1px solid transparent;
}

.severity-healthy {
  border-color: color-mix(in srgb, #22c55e 18%, transparent);
  background: color-mix(in srgb, #22c55e 10%, var(--bg-elevated));
  color: #15803d;
}

.severity-watch {
  border-color: color-mix(in srgb, #f59e0b 20%, transparent);
  background: color-mix(in srgb, #f59e0b 12%, var(--bg-elevated));
  color: #b45309;
}

.severity-critical {
  border-color: color-mix(in srgb, var(--error) 20%, transparent);
  background: color-mix(in srgb, var(--error) 10%, var(--bg-elevated));
  color: var(--error);
}

.overview-card.severity-watch,
.row-watch {
  background: linear-gradient(180deg, color-mix(in srgb, #f59e0b 6%, var(--bg-elevated)), var(--bg-elevated));
}

.overview-card.severity-critical,
.row-critical {
  background: linear-gradient(180deg, color-mix(in srgb, var(--error) 7%, var(--bg-elevated)), var(--bg-elevated));
}

.row-watch td:first-child,
.row-critical td:first-child {
  position: relative;
}

.row-watch td:first-child::before,
.row-critical td:first-child::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 999px;
}

.row-watch td:first-child::before {
  background: #f59e0b;
}

.row-critical td:first-child::before {
  background: var(--error);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 1200px) {
  .overview-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .trend-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

   .visual-grid {
    grid-template-columns: 1fr;
  }

  .visual-panel-wide {
    grid-column: auto;
  }

  .highlight-grid {
    grid-template-columns: 1fr;
  }

  .panel-head {
    flex-direction: column;
  }

  .panel-controls {
    width: 100%;
    justify-content: stretch;
  }

  .filter-group {
    width: 100%;
  }
}

@media (max-width: 820px) {
  .metrics-page {
    padding: var(--space-md);
  }

  .metrics-hero,
  .attention-strip {
    flex-direction: column;
    padding: var(--space-lg);
  }

  .metrics-toolbar {
    width: 100%;
    align-items: stretch;
  }

  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .trend-grid {
    grid-template-columns: 1fr;
  }

  .chart-legend,
  .debug-grid {
    grid-template-columns: 1fr;
  }

  .attention-pills {
    justify-content: flex-start;
  }

  .detail-drawer {
    width: 100%;
    max-height: none;
    height: 100%;
  }

  .detail-drawer-overlay {
    padding: var(--space-md);
  }

  .detail-drawer-body {
    max-height: 60vh;
  }
}

@media (max-width: 560px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }

  .metrics-title {
    font-size: 1.9rem;
  }

  .filter-group {
    align-items: stretch;
  }

  .filter-input,
  .filter-select {
    width: 100%;
  }

  .highlight-title-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
