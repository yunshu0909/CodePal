/**
 * 模型接入页 · 视图推导（纯函数）
 *
 * 负责：
 * - 各家在页面上的显示信息（名称、类型字、图标色、Key 前缀），名字一开始就知道，骨架也能显示卡头
 * - 失败原因文案、「{时间} 测过」的时间写法
 * - 模型名 / 上限的校验与千分位
 * - 一屏只留一个主按钮：填写 Key > 重新检测 > 安装命令；弹层打开时让给弹层里的按钮
 *
 * 规则来源：specs/第三方模型接入/模型接入-定稿/前端设计定稿-模型接入.md §3、§4、§6
 *
 * @module features/models/modelsView
 */

/**
 * 各家显示信息，顺序即页面顺序；名称、类型字、Key 前缀、思考强度档位与主进程预设一致（tests/models/modelsView.test.js 核对）
 * efforts：这家真正区分的思考强度，照 Claude Code 原值不翻译（DeepSeek 把 medium、xhigh 当 high，所以只给三档）
 * @type {Array<{id: string, name: string, type: string, color: string, keyPrefix: string, efforts: string[]}>}
 */
export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', type: '按量', color: 'var(--ic-blue)', keyPrefix: 'sk-', efforts: ['low', 'high', 'max'] },
  { id: 'mimo-api', name: 'MiMo API', type: '按量', color: 'var(--ic-orange)', keyPrefix: 'sk-', efforts: ['high'] },
  { id: 'zhipu-api', name: '智谱 API', type: '按量', color: 'var(--ic-green)', keyPrefix: '', efforts: ['low', 'high', 'max'] },
  { id: 'kimi-api', name: 'Kimi API', type: '按量', color: 'var(--ic-purple)', keyPrefix: '', efforts: ['low', 'high', 'max'] },
  { id: 'zhipu-coding', name: '智谱 Coding Plan', type: '套餐', color: 'var(--ic-green)', keyPrefix: '', efforts: ['low', 'high', 'max'] },
  { id: 'kimi-coding', name: 'Kimi Coding Plan', type: '套餐', color: 'var(--ic-purple)', keyPrefix: '', efforts: ['low', 'high', 'max'] },
  { id: 'minimax-api', name: 'MiniMax API', type: '按量', color: 'var(--ic-orange)', keyPrefix: '', efforts: [] },
  { id: 'minimax-plan', name: 'MiniMax M Plan', type: '套餐', color: 'var(--ic-orange)', keyPrefix: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
]

/** 输出上限最多填到这里：Claude Code 请求里的 max_tokens 最多 128,000，填更大也会被压回 */
export const MAX_OUTPUT_CAP = 128000

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/
const DAY = 86400000

const pad = (n) => String(n).padStart(2, '0')

/** 本机时区零点 */
function startOfDay(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * 最近一次失败的红字：原因 + 补救
 * @param {{reason: string, message?: string|null}} lastResult
 * @param {string} providerName
 * @returns {string}
 */
export function reasonText(lastResult, providerName) {
  switch (lastResult.reason) {
    case 'key': return 'Key 无效，更换 Key 后重试'
    case 'balance': return '余额不足，充值后重试'
    case 'model': return `${providerName} 没有这个模型，检查模型名`
    case 'net': return `连不上 ${providerName}，检查网络后重试`
    default: return lastResult.message ? `调用失败：${lastResult.message}` : '调用失败'
  }
}

/**
 * 「{时间} 测过」的时间：今天「20:38」、昨天「昨天 21:48」、今年「9月17日 08:15」、往年「2025年12月3日」
 * 只有时分用圆体，所以拆成前缀和时分两段
 * @param {string|number} at - 测试时间
 * @param {number} now - 当前时间（毫秒）
 * @returns {{prefix: string, clock: string|null}}
 */
export function testedAtParts(at, now) {
  const d = new Date(at)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const days = Math.round((startOfDay(now) - startOfDay(d.getTime())) / DAY)
  if (days <= 0) return { prefix: '', clock }
  if (days === 1) return { prefix: '昨天 ', clock }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  if (d.getFullYear() === new Date(now).getFullYear()) return { prefix: `${md} `, clock }
  return { prefix: `${d.getFullYear()}年${md}`, clock: null }
}

/**
 * 模型名校验（主进程还会再校验一次，以主进程为准）
 * @param {string} name - 已去掉首尾空格
 * @param {string[]} otherNames - 同一家其他模型的名字
 * @returns {string|null} 红字；合法返回 null
 */
export function modelNameError(name, otherNames) {
  if (!name) return '模型名不能为空'
  if (!NAME_RE.test(name)) return '只能用字母、数字和 . - _'
  const lower = name.toLowerCase()
  if (PROVIDERS.some((p) => p.id.toLowerCase() === lower)) return '不能和供应商同名'
  if (otherNames.some((n) => n.toLowerCase() === lower)) return '已经有这个模型了'
  return null
}

/**
 * 上限输入：允许带千分位，只收正整数
 * @param {string} text
 * @returns {number|null}
 */
export function parsePositiveInt(text) {
  const raw = String(text).replace(/,/g, '').trim()
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 1000000 → 1,000,000 */
export const formatInt = (n) => Number(n).toLocaleString('en-US')

/**
 * 终端启动命令：命令目录在 PATH 里写命令名，不在就写完整路径
 * @param {string} modelName
 * @param {{onPath?: boolean, binDir?: string}|null} commands
 * @param {string} [providerId] - DeepSeek 保留历史命令名，新增渠道按 ID 隔离
 * @returns {string}
 */
export function commandText(modelName, commands, providerId = 'deepseek') {
  const name = providerId === 'deepseek' ? `codepal-${modelName}` : `codepal-${providerId}--${modelName}`
  return commands && commands.onPath === false ? `${commands.binDir}/${name}` : name
}

/**
 * Claude Code 挡住了「测一下」时顶部那一行的内容；没挡住返回 null
 * @param {{found: boolean, version?: string|null, tooOld?: boolean, required?: string}|null} claudeCode
 * @returns {{title: string, desc: string|null, status: string}|null}
 */
export function claudeBlock(claudeCode) {
  if (!claudeCode) return null
  if (!claudeCode.found) return { title: '没找到 Claude Code', desc: null, status: '未安装' }
  if (claudeCode.tooOld) return { title: 'Claude Code 版本太旧', desc: `当前 ${claudeCode.version}，需要 ${claudeCode.required} 或更新`, status: '需升级' }
  return null
}

/**
 * 顶部终端命令那一行要不要出现：至少一个模型，且有模型缺命令、某家缺稳定入口（审核走它），
 * 或者现有命令交给别的 CodePal 执行（otherApp）
 * @param {object} data - models:list 的 data
 * @returns {boolean}
 */
export function needsCommands(data) {
  const hasModel = Object.values(data.providers || {}).some((p) => p.keySet && p.models.length > 0)
  const c = data.commands || {}
  return hasModel && Boolean((c.missing && c.missing.length) || (c.missingEntries && c.missingEntries.length) || c.otherApp)
}

/**
 * 顶部终端命令那一行的内容；不需要时返回 null。命令指向别的 CodePal 时说清是哪一个，
 * 因为那个版本可能不认识这里新加的模型，点「安装命令」改由当前这个执行
 * @param {object} data - models:list 的 data
 * @returns {{title: string, desc: string|null, status: string}|null}
 */
export function commandsBlock(data) {
  if (!needsCommands(data)) return null
  const other = data.commands?.otherApp
  if (!other) return { title: '终端命令未安装', desc: null, status: '未安装' }
  const where = other.version ? `${other.version}${other.dev ? ' 开发版' : ''}（${other.location}）` : other.location
  return {
    title: '终端命令还在用另一个 CodePal',
    desc: `现在指向 ${where}，这里新加的模型在终端里可能用不了；点安装命令改用当前这个`,
    status: '要更新',
  }
}

/**
 * 这一屏哪个按钮是主按钮
 * @param {object} data - models:list 的 data
 * @param {boolean} popoverOpen - 有弹层开着时，主按钮让给弹层里的「保存 / 添加」
 * @returns {'key'|'recheck'|'install'|null}
 */
export function primaryAction(data, popoverOpen) {
  if (popoverOpen) return null
  const anyKey = PROVIDERS.some((p) => data.providers?.[p.id]?.keySet)
  if (!anyKey) return 'key'
  if (claudeBlock(data.claudeCode)) return 'recheck'
  if (needsCommands(data)) return 'install'
  return null
}
