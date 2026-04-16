/**
 * 自定义日期区间聚合处理器
 *
 * 负责：
 * - 校验自定义日期区间参数（开始/结束/北京时间边界）
 * - 调度按天读取/补算流程
 * - 返回与 Usage 页一致的聚合结果
 *
 * @module electron/aggregateUsageRangeHandler
 */

const { isValidDateKey } = require('./services/dailySummaryService')
const {
  getBeijingDayKey,
  aggregateUsageDateRange,
} = require('./services/usageDateRangeAggregationService')

/**
 * 处理 aggregate-usage-range IPC 请求
 * @param {{taskId?: string, startDate?: string, endDate?: string, timezone?: string}} params - 请求参数
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<{success: boolean, data?: object, meta?: object, error?: string}>}
 */
async function handleAggregateUsageRange(params, deps = {}) {
  const now = deps.nowFn ? deps.nowFn() : new Date()
  const { taskId, startDate, endDate, timezone } = params || {}

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

  return aggregateUsageDateRange({
    taskId,
    period: 'custom',
    startDate,
    endDate
  }, deps)
}

module.exports = {
  handleAggregateUsageRange,
}
