/**
 * 自定义日期区间聚合处理器
 *
 * 负责：
 * - 校验自定义日期区间参数（开始/结束/北京时间边界）
 * - 按模型聚合记录并生成展示数据
 * - 生成与实时页一致的项目分布 / 缓存字段 / 图表字段
 * - 调度日汇总读取/补算/合并流程
 *
 * @module electron/aggregateUsageRangeHandler
 */

const {
  isValidDateKey,
  getBeijingDayStartByKey,
  readDailySummary,
  writeDailySummary,
  recomputeDailySummary,
  mergeDailySummaries,
} = require('./services/dailySummaryService')
// 模型颜色映射表（沿用前端聚合口径，确保图例颜色稳定）
const MODEL_COLORS = {
  opus: '#f59e0b',
  'claude-opus': '#f59e0b',
  sonnet: '#6366f1',
  'claude-sonnet': '#6366f1',
  haiku: '#8b5cf6',
  'claude-haiku': '#8b5cf6',
  claude: '#ec4899',
  'gpt-5': '#e67e22',
  'gpt-4o': '#f97316',
  'gpt-4': '#fbbf24',
  'gpt-3.5': '#f59e0b',
  kimi: '#16a34a',
  'kimi-pro': '#22c55e',
  deepseek: '#a855f7',
  gemini: '#dc2626',
  qwen: '#10b981',
  yi: '#ec4899',
  llama: '#06b6d4',
  mistral: '#fbbf24',
  codex: '#3b82f6',
  default: '#8b919a'
}

const PROJECT_COLORS = ['#16a34a', '#f59e0b', '#06b6d4', '#8b5cf6', '#ec4899', '#94a3b8']

/**
 * 获取北京时间日期 key（YYYY-MM-DD）
 * @param {Date} date - 参考时间
 * @returns {string}
 */
function getBeijingDayKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })

  const parts = formatter.formatToParts(date)
  const map = {}

  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      map[part.type] = part.value
    }
  }

  return `${map.year}-${map.month}-${map.day}`
}

/**
 * 生成闭区间日期序列
 * @param {string} startDate - 开始日期（YYYY-MM-DD）
 * @param {string} endDate - 结束日期（YYYY-MM-DD）
 * @returns {string[]}
 */
function buildDateRange(startDate, endDate) {
  const result = []
  const cursor = getBeijingDayStartByKey(startDate)
  const end = getBeijingDayStartByKey(endDate)

  while (cursor <= end) {
    result.push(getBeijingDayKey(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return result
}

/**
 * 获取模型颜色
 * @param {string} model - 模型名
 * @returns {string}
 */
function getModelColor(model) {
  const normalized = (model || '').toLowerCase()

  if (MODEL_COLORS[normalized]) {
    return MODEL_COLORS[normalized]
  }

  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (normalized.includes(key)) {
      return color
    }
  }

  return MODEL_COLORS.default
}

/**
 * 使用最大余数法计算百分比，确保总和为 100%
 * @param {Array<object>} models - 模型数组
 * @param {number} total - 总量
 * @returns {Array<object>}
 */
function calculatePercentagesWithLargestRemainder(models, total) {
  if (total === 0 || models.length === 0) {
    return models.map((model) => ({ ...model, percent: 0 }))
  }

  const withFraction = models.map((model) => {
    const exactPercent = (model.total / total) * 100
    const floorPercent = Math.floor(exactPercent)
    return { ...model, exactPercent, floorPercent, fraction: exactPercent - floorPercent }
  })

  let remaining = 100 - withFraction.reduce((sum, model) => sum + model.floorPercent, 0)

  const sortedByFraction = withFraction
    .map((model, index) => ({ ...model, originalIndex: index }))
    .sort((a, b) => b.fraction - a.fraction || b.total - a.total)

  for (let i = 0; i < remaining && i < sortedByFraction.length; i += 1) {
    sortedByFraction[i].floorPercent += 1
  }

  return sortedByFraction
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((model) => ({ ...model, percent: model.floorPercent }))
}

/**
 * 百分比显示文案
 * @param {number} percent - 百分比
 * @param {number} modelTotal - 模型总量
 * @param {number} grandTotal - 总量
 * @returns {string}
 */
function formatPercentDisplay(percent, modelTotal, grandTotal) {
  if (percent === 0 && modelTotal > 0 && grandTotal > 0) {
    return '<1%'
  }
  return `${percent}%`
}

/**
 * 从模型聚合 Map 生成展示数据
 * @param {Map<string, object>} aggregated - 模型聚合 Map
 * @returns {{total:number,input:number,output:number,cacheRead:number,cacheCreate:number,models:Array,distribution:Array,isExtremeScenario:boolean,modelCount:number}}
 */
function generateViewData(aggregated) {
  const nonZeroModels = Array.from(aggregated.values())
    .filter((model) => model.total > 0)

  const models = nonZeroModels
    .sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name))
    .map((model) => ({ ...model, color: getModelColor(model.name) }))

  const total = models.reduce((sum, model) => sum + model.total, 0)
  const totalInput = models.reduce((sum, model) => sum + model.input, 0)
  const totalOutput = models.reduce((sum, model) => sum + model.output, 0)
  const totalCacheRead = models.reduce((sum, model) => sum + model.cacheRead, 0)
  const totalCacheCreate = models.reduce((sum, model) => sum + model.cacheCreate, 0)

  const modelsWithPercent = calculatePercentagesWithLargestRemainder(models, total)

  const isExtremeScenario = models.length > 5
  let distribution = []

  if (!isExtremeScenario) {
    distribution = modelsWithPercent.map((model) => ({
      name: model.name,
      value: model.total,
      percent: model.percent,
      displayPercent: formatPercentDisplay(model.percent, model.total, total),
      color: model.color,
      key: model.name
    }))
  } else {
    const topModels = modelsWithPercent.slice(0, 5)
    const otherModels = modelsWithPercent.slice(5)

    distribution = topModels.map((model) => ({
      name: model.name,
      value: model.total,
      percent: model.percent,
      displayPercent: formatPercentDisplay(model.percent, model.total, total),
      color: model.color,
      key: model.name
    }))

    const othersTotal = otherModels.reduce((sum, model) => sum + model.total, 0)
    const othersPercent = othersTotal > 0
      ? 100 - topModels.reduce((sum, model) => sum + model.percent, 0)
      : 0

    if (otherModels.length > 0) {
      distribution.push({
        name: `其他 (${otherModels.length}个模型)`,
        value: othersTotal,
        percent: othersPercent,
        displayPercent: formatPercentDisplay(othersPercent, othersTotal, total),
        color: MODEL_COLORS.default,
        key: 'others'
      })
    }
  }

  return {
    total,
    input: totalInput,
    output: totalOutput,
    cacheRead: totalCacheRead,
    cacheCreate: totalCacheCreate,
    models,
    distribution,
    isExtremeScenario,
    modelCount: models.length
  }
}

/**
 * 将项目聚合 Map 转为前端需要的分布数组
 * @param {Map<string, {name: string, value: number}>} aggregatedProjects - 项目聚合结果
 * @returns {Array<{name: string, value: number, color: string}>}
 */
function generateProjectDistribution(aggregatedProjects) {
  return Array.from(aggregatedProjects.values())
    .map((item, idx) => ({
      name: item.name,
      value: item.value,
      color: PROJECT_COLORS[idx % PROJECT_COLORS.length]
    }))
    .sort((a, b) => b.value - a.value)
}

/**
 * 处理 aggregate-usage-range IPC 请求
 * @param {{startDate?: string, endDate?: string, timezone?: string}} params - 请求参数
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<{success: boolean, data?: object, meta?: object, error?: string}>}
 */
async function handleAggregateUsageRange(params, deps = {}) {
  const now = deps.nowFn ? deps.nowFn() : new Date()

  const readDailySummaryFn = deps.readDailySummaryFn || readDailySummary
  const writeDailySummaryFn = deps.writeDailySummaryFn || writeDailySummary
  const recomputeDailySummaryFn = deps.recomputeDailySummaryFn || recomputeDailySummary

  const { startDate, endDate, timezone } = params || {}

  if (typeof startDate !== 'string' || typeof endDate !== 'string') {
    return { success: false, error: 'INVALID_DATE_RANGE' }
  }

  if (!isValidDateKey(startDate) || !isValidDateKey(endDate)) {
    return { success: false, error: 'INVALID_DATE_RANGE' }
  }

  if (startDate > endDate) {
    return { success: false, error: 'INVALID_DATE_RANGE' }
  }

  // 当前版本仅支持北京时间口径
  if (timezone && timezone !== 'Asia/Shanghai') {
    return { success: false, error: 'INVALID_TIMEZONE' }
  }

  const todayKey = getBeijingDayKey(now)
  if (endDate >= todayKey) {
    return { success: false, error: 'DATE_OUT_OF_RANGE' }
  }

  const dateRange = buildDateRange(startDate, endDate)

  let fromDailySummaryDays = 0
  let recomputedDays = 0
  let failedDays = 0
  let lastError = null

  const collectedSummaries = []

  for (const dateKey of dateRange) {
    let dailySummary = await readDailySummaryFn(dateKey, deps)

    if (dailySummary) {
      fromDailySummaryDays += 1
      collectedSummaries.push(dailySummary)
      continue
    }

    try {
      dailySummary = await recomputeDailySummaryFn(dateKey, deps)

      if (!dailySummary) {
        failedDays += 1
        lastError = 'RECOMPUTE_EMPTY'
        continue
      }

      recomputedDays += 1
      collectedSummaries.push(dailySummary)

      // 写盘失败不影响主流程，只影响后续缓存命中率
      try {
        await writeDailySummaryFn(dateKey, dailySummary, deps)
      } catch {
        // noop
      }
    } catch (error) {
      failedDays += 1
      lastError = error?.message || 'RECOMPUTE_FAILED'
    }
  }

  if (collectedSummaries.length === 0) {
    return {
      success: false,
      error: lastError || 'AGGREGATE_FAILED'
    }
  }

  const merged = mergeDailySummaries(collectedSummaries)
  const viewData = generateViewData(merged.models)
  const projectDistribution = generateProjectDistribution(merged.projects)

  return {
    success: true,
    data: {
      ...viewData,
      projectDistribution,
      period: 'custom',
      startDate,
      endDate
    },
    meta: {
      fromDailySummaryDays,
      recomputedDays,
      totalDays: dateRange.length,
      failedDays
    }
  }
}

module.exports = {
  handleAggregateUsageRange,
}
