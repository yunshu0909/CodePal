/**
 * 出口 IP 页面视图推导
 *
 * 负责：
 * - 把主进程推来的 state 翻成页面画面：从未检测 / 首次检测中 / 有结果 / 再次检测中 / 失败
 * - 标签（稳定 / 刚变化）、10 分钟内的变化行、失败原因句、按钮文字与主次
 * - 时间与归属地的写法、变化记录行、「近 7 天 N 次」与两种空态
 *
 * 规则来源：specs/redesign-CodePal视觉重做/网络诊断-定稿/前端设计定稿-网络诊断.md §3–§6
 *
 * @module pages/network/egressView
 */

/** 「刚变化」与变化行保留多久 */
const RECENT_CHANGE_MS = 10 * 60 * 1000

const FAIL_TEXT = {
  timeout: '连接检测服务超时，检查网络或代理后重试',
  other: '公网 IP 检测失败，请检查网络连接',
}

const pad = (n) => String(n).padStart(2, '0')

/** 本机时区的零点 */
function startOfDay(ts) {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * 时间写法：今天只写 HH:mm:ss（记录行加「今天」），昨天「昨天 HH:mm:ss」，更早「M月D日 HH:mm:ss」
 * @param {number} ts - 毫秒时间戳
 * @param {number} now - 当前时间
 * @param {{todayPrefix?: boolean}} [options]
 * @returns {string}
 */
export function formatClock(ts, now, { todayPrefix = false } = {}) {
  const d = new Date(ts)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000)
  if (dayDiff === 0) return todayPrefix ? `今天 ${clock}` : clock
  if (dayDiff === 1) return `昨天 ${clock}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`
}

/**
 * 归属地写法：「国家 · 城市」，只有一项就写一项，都没有为空串
 * @param {{country: string|null, city: string|null}|null} location
 * @returns {string}
 */
export function formatLocation(location) {
  return [location?.country, location?.city].filter(Boolean).join(' · ')
}

/**
 * 从服务 state 推导页面画面
 * @param {object} state - 主进程 getState() 的快照
 * @param {{now: number, probing?: boolean}} options - probing = 页面刚点了「检测一次」还没回来
 * @returns {object}
 */
export function deriveEgressView(state, { now, probing = false }) {
  const current = state?.current || null
  const detecting = probing || state?.status === 'detecting'
  const failed = !detecting && state?.status === 'failed'

  let mode = 'ok'
  if (detecting) mode = current ? 'again' : 'first'
  else if (failed) mode = 'fail'
  else if (!current) mode = 'na'

  const changeLog = state?.changeLog || []
  const latest = changeLog[0]
  const recent = Boolean(
    current && latest && latest.toIp === current.ip && now - latest.at < RECENT_CHANGE_MS,
  )

  let tag = null
  if (state?.isEnabled && current && (mode === 'ok' || mode === 'again')) {
    tag = recent ? 'changed' : 'stable'
  }

  const button = {
    label: detecting ? '检测中…' : mode === 'fail' ? '重试' : '检测一次',
    // 没有值时「检测一次」是此刻唯一该做的事，用主按钮；有值后退回白按钮
    primary: !current && mode !== 'fail',
    disabled: detecting,
  }

  return {
    mode,
    tag,
    button,
    ip: current?.ip || null,
    locationText: formatLocation(current?.location),
    checkedText: current ? formatClock(current.checkedAt, now) : '',
    change: recent && (mode === 'ok' || mode === 'again')
      ? { timeText: formatClock(latest.at, now), fromIp: latest.fromIp, fromLocationText: formatLocation(latest.fromLocation) }
      : null,
    failText: mode === 'fail' ? (FAIL_TEXT[state?.failReason] || FAIL_TEXT.other) : null,
    lastSuccess: mode === 'fail' && current
      ? { ip: current.ip, locationText: formatLocation(current.location), timeText: formatClock(current.checkedAt, now) }
      : null,
    log: changeLog.map((entry) => ({
      key: `${entry.at}-${entry.toIp}`,
      timeText: formatClock(entry.at, now, { todayPrefix: true }),
      fromIp: entry.fromIp,
      toIp: entry.toIp,
      foundByManual: Boolean(entry.foundByManual),
    })),
    logCountText: changeLog.length ? `近 7 天 ${changeLog.length} 次` : null,
    emptyText: changeLog.length ? null : (state?.hasCompared ? '近 7 天没有 IP 变化' : '还没有 IP 变化记录'),
  }
}
