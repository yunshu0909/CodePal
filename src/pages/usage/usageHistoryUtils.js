/**
 * 满载率趋势历史数据工具函数 (v1.4.4)
 *
 * 负责：
 * - 把 completedCycles 按是否为异常条目分类
 * - 过滤超过 30 天的异常条目（UI 不展示但 JSON 保留）
 * - 计算满载率（只基于正常条目，样本为 0 时返回 null 表示"样本不足"）
 *
 * @module pages/usage/usageHistoryUtils
 */

const ONE_DAY_SECONDS = 86400
const ANOMALY_DISPLAY_WINDOW_DAYS = 30
const MAX_NORMAL_CYCLES_FOR_AVG = 4

/**
 * 当前时刻秒数（抽出便于测试注入）
 * @returns {number}
 */
function nowInSeconds() {
  return Math.floor(Date.now() / 1000)
}

/**
 * 判定周期条目是否为异常条目
 * 老数据无 anomaly 字段时默认按正常处理
 * @param {object} cycle
 * @returns {boolean}
 */
function isAnomaly(cycle) {
  return cycle?.anomaly === true
}

/**
 * 把已完成周期按正常 / 近 30 天内异常分类，并计算满载率均值
 *
 * @param {Array<object>} completedCycles - 已完成周期列表（最新在前）
 * @param {number} [refNowSec] - 参考"现在"的秒时间戳，缺省取当前时间
 * @returns {{
 *   normalCycles: object[],       // 用于展示，取最近 4 条
 *   normalCyclesTotal: number,    // 全部正常条目数，用于 footer 汇总
 *   recentAnomalies: object[],    // 近 30 天内异常条目，按原顺序保留
 *   avgPeak: number|null,         // null 表示样本不足
 * }}
 */
export function classifyHistory(completedCycles, refNowSec) {
  const cycles = Array.isArray(completedCycles) ? completedCycles : []
  const ref = Number.isFinite(refNowSec) ? refNowSec : nowInSeconds()
  const cutoff = ref - ANOMALY_DISPLAY_WINDOW_DAYS * ONE_DAY_SECONDS

  const normalAll = []
  const anomalyRecent = []

  for (const cycle of cycles) {
    if (!cycle || typeof cycle !== 'object') continue

    if (isAnomaly(cycle)) {
      const end = Number(cycle.periodEnd)
      if (Number.isFinite(end) && end >= cutoff) {
        anomalyRecent.push(cycle)
      }
      continue
    }

    normalAll.push(cycle)
  }

  const normalForAvg = normalAll.slice(0, MAX_NORMAL_CYCLES_FOR_AVG)
  let avgPeak = null
  if (normalForAvg.length > 0) {
    const sum = normalForAvg.reduce((acc, c) => {
      const v = Number(c?.peakPercentage)
      return acc + (Number.isFinite(v) ? v : 0)
    }, 0)
    avgPeak = Math.round(sum / normalForAvg.length)
  }

  return {
    normalCycles: normalForAvg,
    normalCyclesTotal: normalAll.length,
    recentAnomalies: anomalyRecent,
    avgPeak,
  }
}

/**
 * 计算周期天数（向下取整，最小 1）
 * @param {number|null|undefined} startSec - 起始秒时间戳
 * @param {number|null|undefined} endSec - 结束秒时间戳
 * @returns {number} 天数，异常输入返回 0
 */
export function cycleDurationDays(startSec, endSec) {
  // null/undefined/空字符串按非法处理（Number(null) 为 0 会误通过）
  if (startSec == null || endSec == null || startSec === '' || endSec === '') return 0
  const start = Number(startSec)
  const end = Number(endSec)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  const days = Math.floor((end - start) / ONE_DAY_SECONDS)
  return Math.max(1, days)
}

export const __INTERNAL__ = {
  ONE_DAY_SECONDS,
  ANOMALY_DISPLAY_WINDOW_DAYS,
  MAX_NORMAL_CYCLES_FOR_AVG,
}
