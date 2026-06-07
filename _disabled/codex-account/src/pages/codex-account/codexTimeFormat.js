/**
 * Codex 账户页时间格式化工具
 *
 * 负责：
 * - 从"上次切入"时间戳 → 5h / 7d 窗口的剩余倒计时文案
 * - 人性化"多久之前"（刚刚 / N 分钟前 / 昨天 14:30 / 3 天前）
 *
 * 说明：V1 不查 OpenAI 额度接口，5h/7d 窗口从"最近一次切入"起算，
 *       不能保证精确但足够用户作切换决策。
 *
 * @module pages/codex-account/codexTimeFormat
 */

const MS_PER_MIN  = 60_000
const MS_PER_HOUR = 60 * MS_PER_MIN
const MS_PER_DAY  = 24 * MS_PER_HOUR

const WINDOW_5H_MS = 5 * MS_PER_HOUR
const WINDOW_7D_MS = 7 * MS_PER_DAY

/**
 * 给定"上次切入时间"，算 5 小时窗口的剩余倒计时描述
 *
 * V1.6.2 修复：旧文案"已重置"会误导用户以为 ChatGPT 服务端窗口已重置，
 * 实际只是本地从"上次切入"起算的倒计时到期。改成不撒谎的措辞。
 * （彻底解决要等 V1.6.3 接入 wham/usage 拿真实 reset_at）
 *
 * @param {number|null} lastSwitchAt - UNIX 毫秒，null 表示从未切入
 * @param {number} [now=Date.now()]
 * @returns {{text: string, urgent: boolean}}
 */
export function fiveHourWindowText(lastSwitchAt, now = Date.now()) {
  if (!lastSwitchAt) return { text: '尚未切入过', urgent: false }
  const remaining = WINDOW_5H_MS - (now - lastSwitchAt)
  if (remaining <= 0) return { text: '本地计时已过', urgent: false }
  return { text: `约 ${formatDuration(remaining)} 后重置`, urgent: remaining < MS_PER_HOUR }
}

/**
 * 7 天窗口的剩余倒计时描述
 */
export function sevenDayWindowText(lastSwitchAt, now = Date.now()) {
  if (!lastSwitchAt) return { text: '尚未切入过', urgent: false }
  const remaining = WINDOW_7D_MS - (now - lastSwitchAt)
  if (remaining <= 0) return { text: '本地计时已过', urgent: false }
  return { text: `约 ${formatDuration(remaining)} 后重置`, urgent: false }
}

/**
 * "上次切入"的人性化文案
 * 规则：< 1min 显示"刚刚"；< 1h 显示"N 分钟前"；
 *      同日显示"今天 HH:MM"；昨日显示"昨天 HH:MM"；
 *      7 天内显示"N 天前"；超过显示日期 MM-DD
 */
export function lastSwitchText(lastSwitchAt, now = Date.now()) {
  if (!lastSwitchAt) return '从未使用'
  const diff = now - lastSwitchAt
  if (diff < MS_PER_MIN) return '刚刚'
  if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MIN)} 分钟前`

  const then = new Date(lastSwitchAt)
  const today = new Date(now)
  const sameDay = then.toDateString() === today.toDateString()
  if (sameDay) return `今天 ${pad2(then.getHours())}:${pad2(then.getMinutes())}`

  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (then.toDateString() === yesterday.toDateString()) {
    return `昨天 ${pad2(then.getHours())}:${pad2(then.getMinutes())}`
  }

  const diffDays = Math.floor(diff / MS_PER_DAY)
  if (diffDays < 7) return `${diffDays} 天前`

  return `${pad2(then.getMonth() + 1)}-${pad2(then.getDate())}`
}

function formatDuration(ms) {
  const hours = Math.floor(ms / MS_PER_HOUR)
  const mins = Math.floor((ms % MS_PER_HOUR) / MS_PER_MIN)
  const days = Math.floor(ms / MS_PER_DAY)
  if (days >= 1) {
    const remHours = Math.floor((ms - days * MS_PER_DAY) / MS_PER_HOUR)
    return `${days}d ${remHours}h`
  }
  if (hours >= 1) return `${hours}h ${mins}m`
  if (mins >= 1) return `${mins}m`
  return '不到 1m'
}

function pad2(n) { return String(n).padStart(2, '0') }
