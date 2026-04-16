/**
 * 预设周期用量聚合处理器
 *
 * 负责：
 * - 校验 today/week/month/allTime 周期参数
 * - today 走轻量实时扫描
 * - week/month/allTime 走按天汇总与真实进度
 *
 * @module electron/aggregateUsagePeriodHandler
 */

const {
  scanClaudeLogs,
  scanCodexLogs,
  aggregateByModel,
  aggregateByProject,
} = require('./services/usageLogScanService')
const { buildUsageViewData } = require('./services/usageViewDataService')
const {
  getBeijingDayKey,
  getPresetPeriodDateRange,
  aggregateUsageDateRange,
} = require('./services/usageDateRangeAggregationService')

const VALID_PERIODS = new Set(['today', 'week', 'month', 'allTime'])

/**
 * 根据北京时间日期 key 获取 UTC 窗口起点
 * @param {string} dateKey - YYYY-MM-DD
 * @returns {Date}
 */
function getBeijingDayStart(dateKey) {
  return new Date(`${dateKey}T00:00:00+08:00`)
}

/**
 * 聚合 today 实时数据
 * @param {{period: 'today'}} params - 聚合参数
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function aggregateTodayUsage(params, deps = {}) {
  try {
    const now = deps.nowFn ? deps.nowFn() : new Date()
    const todayKey = getBeijingDayKey(now)
    const start = getBeijingDayStart(todayKey)
    const end = new Date(now)

    const [claudeRecords, codexRecords] = await Promise.all([
      scanClaudeLogs(start, end, deps),
      scanCodexLogs(start, end, deps)
    ])

    const allRecords = [...claudeRecords, ...codexRecords]
    const aggregatedModels = aggregateByModel(allRecords)
    const aggregatedProjects = aggregateByProject(allRecords)
    const viewData = buildUsageViewData(aggregatedModels, aggregatedProjects)

    return {
      success: true,
      data: {
        ...viewData,
        period: params.period,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        recordCount: allRecords.length
      }
    }
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED' }
    }

    return { success: false, error: error?.message || 'AGGREGATE_FAILED' }
  }
}

/**
 * 处理 aggregate-usage-period IPC 请求
 * @param {{taskId?: string, period?: 'today'|'week'|'month'|'allTime', timezone?: string}} params - 聚合参数
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<{success: boolean, data?: object, meta?: object, error?: string}>}
 */
async function handleAggregateUsagePeriod(params, deps = {}) {
  const { taskId, period, timezone } = params || {}

  if (!VALID_PERIODS.has(period)) {
    return { success: false, error: 'INVALID_PERIOD' }
  }

  if (timezone && timezone !== 'Asia/Shanghai') {
    return { success: false, error: 'INVALID_TIMEZONE' }
  }

  if (period === 'today') {
    return aggregateTodayUsage({ period }, deps)
  }

  const now = deps.nowFn ? deps.nowFn() : new Date()
  const { startDate, endDate } = getPresetPeriodDateRange(period, now)

  return aggregateUsageDateRange({
    taskId,
    period,
    startDate,
    endDate
  }, deps)
}

module.exports = {
  handleAggregateUsagePeriod
}
