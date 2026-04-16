/**
 * 用量日期区间聚合服务
 *
 * 负责：
 * - 按天读取/补算日汇总
 * - 合并日期区间内的模型与项目数据
 * - 产出真实进度事件（已完成天数 / 总天数）
 *
 * @module electron/services/usageDateRangeAggregationService
 */

const {
  getBeijingDayStartByKey,
  readDailySummary,
  writeDailySummary,
  recomputeDailySummary,
  mergeDailySummaries,
} = require('./dailySummaryService')
const { buildUsageViewData } = require('./usageViewDataService')

const PROGRESS_EMIT_INTERVAL_MS = 250
const EVENT_LOOP_YIELD_INTERVAL_MS = 32

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
 * 获取北京时间相对日期 key（YYYY-MM-DD）
 * @param {number} offsetDays - 相对今天的偏移天数
 * @param {Date} date - 参考时间
 * @returns {string}
 */
function getBeijingRelativeDayKey(offsetDays, date = new Date()) {
  const dayStart = getBeijingDayStartByKey(getBeijingDayKey(date))
  dayStart.setUTCDate(dayStart.getUTCDate() + offsetDays)
  return getBeijingDayKey(dayStart)
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
 * 获取预设周期对应的日期区间
 * @param {'week'|'month'|'allTime'} period - 预设周期
 * @param {Date} now - 当前时间
 * @returns {{startDate: string, endDate: string}}
 */
function getPresetPeriodDateRange(period, now = new Date()) {
  switch (period) {
    case 'week':
      return {
        startDate: getBeijingRelativeDayKey(-7, now),
        endDate: getBeijingRelativeDayKey(-1, now)
      }
    case 'month':
      return {
        startDate: getBeijingRelativeDayKey(-30, now),
        endDate: getBeijingRelativeDayKey(-1, now)
      }
    case 'allTime':
      return {
        startDate: '2020-01-01',
        endDate: getBeijingRelativeDayKey(-1, now)
      }
    default:
      return {
        startDate: getBeijingRelativeDayKey(-1, now),
        endDate: getBeijingRelativeDayKey(-1, now)
      }
  }
}

/**
 * 安全发送进度事件
 * @param {(payload: object) => void|Promise<void>} onProgress - 进度回调
 * @param {object} payload - 进度数据
 */
async function emitProgress(onProgress, payload) {
  if (typeof onProgress !== 'function') {
    return
  }

  try {
    await onProgress(payload)
  } catch {
    // 进度回调失败时不阻断主流程
  }
}

/**
 * 构建节流后的进度上报器
 * 为什么要节流：
 * - 冷缓存时单日扫描很慢，热缓存时又可能在极短时间内扫过上千天
 * - 如果每一天都立刻通过 IPC 推给渲染层，会让主进程和前端都出现“发涩”感
 * - 节流后仍然展示真实进度，只是优先保留最近一次快照
 * @param {(payload: object) => void|Promise<void>} onProgress - 进度回调
 * @returns {{emit: (payload: object) => Promise<void>, flush: () => Promise<void>}}
 */
function createProgressReporter(onProgress) {
  let lastEmittedAt = 0
  let queuedPayload = null

  return {
    async emit(payload) {
      const now = Date.now()
      const isTerminalStatus = payload?.status === 'completed' || payload?.status === 'failed'

      if (
        lastEmittedAt === 0
        || isTerminalStatus
        || (now - lastEmittedAt) >= PROGRESS_EMIT_INTERVAL_MS
      ) {
        lastEmittedAt = now
        queuedPayload = null
        await emitProgress(onProgress, payload)
        return
      }

      queuedPayload = payload
    },

    async flush() {
      if (!queuedPayload) {
        return
      }

      const latestPayload = queuedPayload
      queuedPayload = null
      lastEmittedAt = Date.now()
      await emitProgress(onProgress, latestPayload)
    }
  }
}

/**
 * 主动让出一次事件循环
 * 为什么要让步：
 * - 长区间缓存命中时，循环可能在很短时间内跑很多天
 * - 给事件循环一个空档，可以减少窗口点击和动画的粘滞感
 * @param {object} deps - 依赖注入
 * @returns {Promise<void>}
 */
async function yieldToEventLoop(deps = {}) {
  const yieldToEventLoopFn = deps.yieldToEventLoopFn
    || (() => new Promise((resolve) => setTimeout(resolve, 0)))

  await yieldToEventLoopFn()
}

/**
 * 聚合指定日期区间内的用量
 * @param {{taskId?: string, period?: string, startDate: string, endDate: string}} params - 聚合参数
 * @param {object} [deps] - 依赖注入（测试用）
 * @returns {Promise<{success: boolean, data?: object, meta?: object, error?: string}>}
 */
async function aggregateUsageDateRange(params, deps = {}) {
  const {
    taskId = '',
    period = 'custom',
    startDate,
    endDate,
  } = params

  const readDailySummaryFn = deps.readDailySummaryFn || readDailySummary
  const writeDailySummaryFn = deps.writeDailySummaryFn || writeDailySummary
  const recomputeDailySummaryFn = deps.recomputeDailySummaryFn || recomputeDailySummary
  const dateRange = buildDateRange(startDate, endDate)
  const totalDays = dateRange.length
  const progressReporter = createProgressReporter(deps.onProgress)

  let cachedDays = 0
  let recomputedDays = 0
  let failedDays = 0
  let lastError = null
  let lastYieldAt = Date.now()

  const collectedSummaries = []

  await progressReporter.emit({
    taskId,
    status: 'running',
    period,
    startDate,
    endDate,
    totalDays,
    processedDays: 0,
    cachedDays,
    recomputedDays,
    failedDays,
    progressPercent: 0,
    currentDate: dateRange[0] || null,
    currentSource: null
  })

  for (const [index, dateKey] of dateRange.entries()) {
    let currentSource = 'cache'
    let dailySummary = await readDailySummaryFn(dateKey, deps)

    if (dailySummary) {
      cachedDays += 1
      collectedSummaries.push(dailySummary)
    } else {
      currentSource = 'recomputed'

      try {
        dailySummary = await recomputeDailySummaryFn(dateKey, deps)

        if (!dailySummary) {
          currentSource = 'failed'
          failedDays += 1
          lastError = 'RECOMPUTE_EMPTY'
        } else {
          recomputedDays += 1
          collectedSummaries.push(dailySummary)

          // 写盘失败只会影响后续命中率，不应中断本次计算。
          try {
            await writeDailySummaryFn(dateKey, dailySummary, deps)
          } catch {
            // noop
          }
        }
      } catch (error) {
        currentSource = 'failed'
        failedDays += 1
        lastError = error?.message || 'RECOMPUTE_FAILED'
      }
    }

    await progressReporter.emit({
      taskId,
      status: 'running',
      period,
      startDate,
      endDate,
      totalDays,
      processedDays: index + 1,
      cachedDays,
      recomputedDays,
      failedDays,
      progressPercent: Math.round(((index + 1) / totalDays) * 100),
      currentDate: dateKey,
      currentSource
    })

    // 长循环里定期让步，减少 Electron 主进程连续占用带来的操作发涩。
    if ((Date.now() - lastYieldAt) >= EVENT_LOOP_YIELD_INTERVAL_MS) {
      lastYieldAt = Date.now()
      await yieldToEventLoop(deps)
    }
  }

  if (collectedSummaries.length === 0) {
    await progressReporter.emit({
      taskId,
      status: 'failed',
      period,
      startDate,
      endDate,
      totalDays,
      processedDays: totalDays,
      cachedDays,
      recomputedDays,
      failedDays,
      progressPercent: 100,
      currentDate: dateRange[dateRange.length - 1] || null,
      currentSource: 'failed'
    })

    return {
      success: false,
      error: lastError || 'AGGREGATE_FAILED'
    }
  }

  await progressReporter.flush()
  const merged = mergeDailySummaries(collectedSummaries)
  const viewData = buildUsageViewData(merged.models, merged.projects)

  await progressReporter.emit({
    taskId,
    status: 'completed',
    period,
    startDate,
    endDate,
    totalDays,
    processedDays: totalDays,
    cachedDays,
    recomputedDays,
    failedDays,
    progressPercent: 100,
    currentDate: dateRange[dateRange.length - 1] || null,
    currentSource: null
  })

  return {
    success: true,
    data: {
      ...viewData,
      period,
      startDate,
      endDate
    },
    meta: {
      fromDailySummaryDays: cachedDays,
      cachedDays,
      recomputedDays,
      totalDays,
      failedDays
    }
  }
}

module.exports = {
  getBeijingDayKey,
  getBeijingRelativeDayKey,
  buildDateRange,
  getPresetPeriodDateRange,
  aggregateUsageDateRange,
}
