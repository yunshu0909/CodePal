/**
 * 会话状态页的显示规则（纯函数，便于测试）
 *
 * 负责：
 * - 状态标签：等你确认 橙 / 进行中 蓝 / 完成了 绿 / 已停止 灰
 * - 时间写法：进行中写已进行多久（3 分钟），其余写多久以前（12 分钟前）；不到 1 分钟写「刚刚」
 * - 说明行：工具 · 在干嘛；等你确认时优先写它问的那句话
 * - 检测到的工具一行怎么写
 *
 * 设计：specs/状态提醒重做/状态清单-会话状态-草案.md（A1、A10、A14、C1）
 *
 * @module pages/sessionStatus/sessionStatusView
 */

export const STATE_TAG = Object.freeze({
  attention: { tone: 'orange', label: '等你确认' },
  busy: { tone: 'blue', label: '进行中' },
  done: { tone: 'green', label: '完成了' },
  // 你中途停止（Codex 的中断时机）：灰色，不通知
  stopped: { tone: 'gray', label: '已停止' },
})

/**
 * @param {number} epochSec - 状态写下的时间（秒）
 * @param {string} state
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatSessionTime(epochSec, state, nowMs = Date.now()) {
  const minutes = Math.max(0, Math.floor((nowMs - (Number(epochSec) || 0) * 1000) / 60000))
  if (minutes < 1) return '刚刚'
  const text = minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时`
  return state === 'busy' ? text : `${text}前`
}

/**
 * @param {{state: string, source: string, task?: string, ask?: string}} session
 * @returns {string}
 */
export function describeSession(session) {
  const what = session.state === 'attention' ? (session.ask || session.task) : session.task
  return what ? `${session.source} · ${what}` : session.source
}

/**
 * @param {{claude: boolean, codex: boolean}} tools
 * @returns {string}
 */
export function describeTools(tools) {
  const names = [tools?.claude && 'Claude Code', tools?.codex && 'Codex'].filter(Boolean)
  return names.length ? names.join(' · ') : '—'
}
