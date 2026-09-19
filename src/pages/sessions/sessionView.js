/**
 * 对话回顾页面视图推导
 *
 * 负责：
 * - 按天分组（今天 / 昨天 / 前 7 天 / 更早）与两种时间写法
 * - 项目方块颜色、项目菜单数据、按项目 / 是否含自动调用筛选
 * - 消息分组：把连续的工具调用合成一块
 * - 标题回退与 resume 命令
 *
 * 规则来源：specs/redesign-CodePal视觉重做/对话回顾-定稿/前端设计定稿-对话回顾.md §6
 *
 * @module pages/sessions/sessionView
 */

const DAY = 86400000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
// 不用红：红在这套规范里表示出错，项目方块是红的会被看成出了问题
const PALETTE = ['blue', 'purple', 'orange', 'teal', 'brown', 'green']

const pad = (n) => String(n).padStart(2, '0')
const toMs = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

/** 本机时区零点 */
function startOfDay(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 相差几个自然日（按零点算，跨夏令时也取整） */
function daysAgo(ts, now) {
  return Math.round((startOfDay(now) - startOfDay(toMs(ts))) / DAY)
}

const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** 日期：同年写「9月2日」，跨年写「2025年12月30日」 */
function dateText(d, now) {
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}年${md}`
}

/**
 * 分组名
 * @param {number|string} ts - 时间
 * @param {number} now - 当前时间（毫秒）
 * @returns {'今天'|'昨天'|'前 7 天'|'更早'}
 */
export function dayGroup(ts, now) {
  const n = daysAgo(ts, now)
  if (n <= 0) return '今天'
  if (n === 1) return '昨天'
  if (n <= 7) return '前 7 天'
  return '更早'
}

/**
 * 列表行尾的时间：今天、昨天写时分；前 7 天写星期；更早写日期
 * @param {number|string} ts
 * @param {number} now
 * @returns {string}
 */
export function formatRowTime(ts, now) {
  const d = new Date(toMs(ts))
  const group = dayGroup(ts, now)
  if (group === '今天' || group === '昨天') return clock(d)
  if (group === '前 7 天') return WEEKDAYS[d.getDay()]
  return dateText(d, now)
}

/**
 * 对话页元信息里的时间：今天 14:36 / 昨天 22:41 / 9月16日 10:02
 * @param {number|string} ts
 * @param {number} now
 * @returns {string}
 */
export function formatWhen(ts, now) {
  const d = new Date(toMs(ts))
  const n = daysAgo(ts, now)
  if (n <= 0) return `今天 ${clock(d)}`
  if (n === 1) return `昨天 ${clock(d)}`
  return `${dateText(d, now)} ${clock(d)}`
}

/**
 * 绝对日期 + 时分：消息流开头那行（9月19日 10:12；跨年带年份）
 * @param {number|string} ts
 * @param {number} now
 * @returns {string}
 */
export function formatDateTime(ts, now) {
  const d = new Date(toMs(ts))
  return `${dateText(d, now)} ${clock(d)}`
}

/**
 * 按天分组，保持传入顺序（已按时间倒序），只出现有内容的组
 * @param {Array<{modifiedAt: string}>} sessions
 * @param {number} now
 * @returns {Array<{label: string, items: Array}>}
 */
export function groupSessions(sessions, now) {
  const groups = []
  for (const s of sessions) {
    const label = dayGroup(s.modifiedAt, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(s)
    else groups.push({ label, items: [s] })
  }
  return groups
}

/**
 * 项目方块颜色：按项目名固定映射到 6 色
 * @param {string} name - 项目名
 * @returns {string} blue / purple / orange / teal / brown / green
 */
export function projectColor(name = '') {
  let h = 0
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/**
 * 一条对话的方块颜色：自动调用的一律灰
 * @param {{projectName: string, auto: boolean}} session
 * @returns {string}
 */
export function iconColor(session) {
  return session.auto ? 'gray' : projectColor(session.projectName)
}

/**
 * 项目菜单：只含手动对话的项目，按各项目最近一次活动倒序
 * @param {Array<object>} sessions - listRecent 的结果（已按时间倒序）
 * @returns {Array<{projectPath: string, projectName: string, parentDir: string, count: number}>}
 */
export function buildProjectMenu(sessions) {
  const byPath = new Map()
  for (const s of sessions) {
    if (s.auto || !s.projectPath) continue
    const item = byPath.get(s.projectPath)
    if (item) {
      item.count += 1
      if (s.modifiedAt > item.latest) item.latest = s.modifiedAt
    } else {
      byPath.set(s.projectPath, { projectPath: s.projectPath, projectName: s.projectName, parentDir: s.parentDir, count: 1, latest: s.modifiedAt })
    }
  }
  return [...byPath.values()]
    .sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0))
    .map(({ latest, ...rest }) => rest)
}

/**
 * 按当前筛选过滤
 * @param {Array<object>} sessions
 * @param {{projectPath: string|null, includeAuto: boolean}} filter
 * @returns {Array<object>}
 */
export function filterSessions(sessions, { projectPath, includeAuto }) {
  return sessions.filter((s) => (includeAuto || !s.auto) && (!projectPath || s.projectPath === projectPath))
}

/**
 * 消息分组：工具调用攒成一块，放在下一段文字 / 下一句提问之前
 * @param {Array<object>} messages - readSession 的消息（正序）
 * @returns {Array<{type: 'ask'|'answer'|'tools'|'compact', key: string, message?: object, toolUses?: Array}>}
 */
export function groupMessages(messages) {
  const blocks = []
  let pending = []
  let pendingKey = null
  const flush = () => {
    if (pending.length) blocks.push({ type: 'tools', key: `t${pendingKey}`, toolUses: pending })
    pending = []
    pendingKey = null
  }
  for (const m of messages) {
    if (m.kind === 'answer') {
      if (m.text) {
        flush()
        blocks.push({ type: 'answer', key: `a${m.offset}`, message: m })
      }
      if (m.toolUses?.length) {
        if (pendingKey == null) pendingKey = m.offset
        pending = pending.concat(m.toolUses)
      }
    } else {
      flush()
      blocks.push({ type: m.kind, key: `${m.kind}${m.offset}`, message: m })
    }
  }
  flush()
  return blocks
}

/**
 * 列表与对话页显示的标题
 * @param {{title: string|null}} session
 * @returns {string}
 */
export function displayTitle(session) {
  return session.title || '（无标题）'
}

/**
 * 复制到剪贴板的 resume 命令
 * @param {string} cwd - 对话的工作目录
 * @param {string} sessionId - 对话 id
 * @returns {string}
 */
export function resumeCommand(cwd, sessionId) {
  return `cd "${cwd}" && claude --resume ${sessionId}`
}
