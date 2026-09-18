/**
 * Claude Code 设置页的纯数据与判断
 *
 * 负责：
 * - 六个默认权限模式的顺序、名字、说明、色块与图标路径
 * - 接入状态到行内文案 / 点色 / 动作的映射（文案均为现有代码原文）
 * - 终端预览的固定示例数据、模式行与三档判色
 *
 * 规则照搬定稿 specs/redesign-CodePal视觉重做/Claude设置-定稿/前端设计定稿-Claude设置.md §6、§11.5。
 *
 * @module pages/claudeSettings/claudeSettings
 */

/** 模式顺序固定：全自动排第一 */
export const PERMISSION_MODES = [
  { id: 'bypassPermissions', name: '全自动', desc: '自动执行所有操作，无需确认', color: '#2b7fff', icon: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z' },
  { id: 'auto', name: '自动审批', desc: '由审批模型判断操作；可用性取决于客户端和账户', color: '#8e4ee6', icon: 'M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2' },
  { id: 'acceptEdits', name: '自动编辑', desc: '自动接受文件改动，命令执行和网络访问仍需确认', color: '#ff9500', icon: 'M10.5 2.5 13.5 5.5 6 13H3v-3z' },
  { id: 'default', name: '每次询问', desc: '每次执行操作前都会征求你的确认', color: '#30a14e', icon: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z' },
  { id: 'dontAsk', name: '仅预先授权', desc: '只执行已允许的操作；遇到未授权操作时不再询问', color: '#8e8e93', icon: 'M8 1.5 13 3.5v4c0 3-2.2 5.3-5 6.5-2.8-1.2-5-3.5-5-6.5v-4z' },
  { id: 'plan', name: '只读规划', desc: '只读文件并给出规划，不执行任何操作', color: '#32ade6', icon: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z', circle: true },
]

/**
 * 按模式 ID 取模式定义
 * @param {string|null} id - 模式 ID
 * @returns {object|undefined}
 */
export function findMode(id) {
  return PERMISSION_MODES.find((m) => m.id === id)
}

/** 写入失败的现有错误文案映射（原样沿用旧页面） */
export const SWITCH_ERROR_MESSAGES = {
  PERMISSION_DENIED: '切换失败，无法写入配置文件（权限不足）',
  DISK_FULL: '切换失败，磁盘空间不足',
  BACKUP_FAILED: '切换失败，无法备份原配置',
  WRITE_ERROR: '切换失败，无法写入配置文件',
  INVALID_MODE: '无效的模式选择',
}

/** 视为「已接入」的接入状态：开关可用、预览画状态栏 */
export const CONNECTED_STATES = new Set(['ready', 'waiting_for_data'])

/**
 * 接入状态行的显示
 * @param {string} state - integrationState 或 read_error
 * @param {{committed?: boolean}} [extra] - 接入失败时区分「已写入但校验不过」
 * @returns {{tone: ''|'off'|'warn'|'bad', text: string, action: null|{kind: string, label: string, primary?: boolean}}}
 */
export function integrationView(state, extra = {}) {
  switch (state) {
    case 'ready':
    case 'waiting_for_data':
      return { tone: '', text: '已接入', action: null }
    case 'not_configured':
      return { tone: 'off', text: '未接入', action: { kind: 'install', label: '立即接入', primary: true } }
    case 'conflict':
      return { tone: 'warn', text: '检测到已有自定义 statusLine', action: { kind: 'takeover', label: '查看接管说明' } }
    case 'setup_failed':
      return { tone: 'bad', text: extra.committed ? '配置已写入但未通过校验' : '无法写入 Claude 配置', action: { kind: 'install', label: '重试接入' } }
    case 'not_installed':
      return { tone: 'off', text: '本机未安装 Claude Code', action: { kind: 'reload', label: '刷新状态' } }
    default:
      return { tone: 'bad', text: '无法读取额度状态', action: { kind: 'reload', label: '重试' } }
  }
}

/** 终端预览的固定示例数据：预览只示意终端底部长什么样，不读快照 */
export const EXAMPLE = { model: 'Opus 5', ctx: 16, five: 4, week: 69, reset: 'in 25m (15:30)', branch: 'master' }

/** Claude Code 模式表（2.1.276 实测）的模式行；「每次询问」与未配置不显示模式行 */
export const MODE_LINES = {
  bypassPermissions: { text: '⏵⏵ bypass permissions on', tone: 'bypass' },
  dontAsk: { text: "⏵⏵ don't ask on", tone: 'bypass' },
  acceptEdits: { text: '⏵⏵ accept edits on', tone: 'edit' },
  plan: { text: '⏸ plan mode on', tone: 'plan' },
  auto: { text: '⏵⏵ auto mode on', tone: 'auto' },
}

/**
 * 三档判色，与状态栏脚本一致
 * @param {number} pct - 百分比
 * @param {boolean} [isContext] - 上下文断点 50 / 80，额度断点 60 / 85
 * @returns {'g'|'y'|'r'}
 */
export function pctTone(pct, isContext = false) {
  if (isContext) return pct < 50 ? 'g' : pct < 80 ? 'y' : 'r'
  return pct < 60 ? 'g' : pct < 85 ? 'y' : 'r'
}

/**
 * 上下文条：10 格、每格 8 份
 * @param {number} pct - 上下文占用百分比
 * @returns {{filled: string, empty: string}}
 */
export function contextBar(pct) {
  const parts = '▏▎▍▌▋▊▉█'
  const units = Math.round((pct / 100) * 80)
  const full = Math.floor(units / 8)
  const rem = units % 8
  let filled = '█'.repeat(full)
  let empty = 10 - full
  if (full < 10 && rem > 0) {
    filled += parts[rem - 1]
    empty -= 1
  }
  return { filled, empty: '░'.repeat(empty) }
}

/**
 * 开关与配置值：off 显示关，其余（含旧值 threshold）显示开
 * @param {string|undefined} displayMode - 配置里的显示方式
 * @returns {boolean}
 */
export function isStatusLineShown(displayMode) {
  return displayMode !== 'off'
}
