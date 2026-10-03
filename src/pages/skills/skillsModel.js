/**
 * Skill 管理页纯规则（照签收定稿 specs/skills-redesign/Skill管理-定稿/）
 *
 * 负责：
 * - 左栏分组与排序：要处理（v2.1.11 起排第一，取代「外部」组）/ 在用（次数多到少）/ 近 30 天没用（还在装载的排前）/ 只读；
 *   次数读不出时资产库两组合成「资产库」
 * - 要处理的文案规则：在哪、和资产库的关系、副本位置、差异文件顺序、收进记录的时间与撤不了的原因
 * - 搜索（名字 + 一句话用途，不分大小写）与命中片段切分
 * - 数字与时间写法：约 2.5k tokens、今天 / 昨天 / 周几 / 几月几日
 * - 工具状态：读不出、没找到
 *
 * @module pages/skills/skillsModel
 */

export const TOOLS = Object.freeze([
  { id: 'claude-code', label: 'Claude Code', short: 'Claude', usageKey: 'claude' },
  { id: 'codex', label: 'Codex', short: 'Codex', usageKey: 'codex' },
])

export const OVERVIEW_ID = '__overview'

/** 装载总览下面的三个右栏视图（左栏仍选中装载总览） */
export const VIEW_IDS = Object.freeze({ projects: '__projects', recent: '__recent', ignored: '__ignored' })

/** 左栏「要处理」里一条的选中标记（和资产库里同名的 Skill 区分开） */
export const INBOX_PREFIX = 'inbox:'
export const inboxId = (name) => `${INBOX_PREFIX}${name}`
export const isInboxId = (id) => typeof id === 'string' && id.startsWith(INBOX_PREFIX)
export const inboxNameOf = (id) => (isInboxId(id) ? id.slice(INBOX_PREFIX.length) : null)
export const isOverviewLike = (id) => id === OVERVIEW_ID || Object.values(VIEW_IDS).includes(id)

const TOOL_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex' }
const TOOL_SHORTS = { 'claude-code': 'Claude', codex: 'Codex' }
export const toolLabelOf = (toolId) => TOOL_LABELS[toolId] || toolId

/** 要处理的详情栏头：和资产库的关系 */
export const RELATION_TEXT = Object.freeze({ diff: '资产库里的版本不一样', same: '资产库已有一样的', none: '资产库没有' })

/**
 * 快照里的要处理清单
 * @param {object|null} snapshot
 * @returns {object[]}
 */
export function inboxItemsOf(snapshot) {
  return snapshot?.inbox?.items || []
}

/**
 * 资产库已有的详情里「换成链接」对应的收进目标
 * @param {string} name
 * @param {object} gate - skill.gate[toolId]（why 为 same / external 时带 copy、资产库摘要、已链接的工具）
 * @returns {{item: object, copy: object}}
 */
export function gateCollectTarget(name, gate) {
  return { item: { name, relation: 'same', linkedTools: gate.linkedTools || [], libraryDigest: gate.libraryDigest ?? null }, copy: gate.copy }
}

/**
 * 在一份快照里重新找收进确认框的目标（内容变了以后按现在的样子更新确认框，定稿 C14）
 * @param {object} snapshot
 * @param {string} name
 * @param {string} sourceId
 * @returns {{item: object, copy: object}|null} 这一份已经不在时为 null
 */
export function collectTargetOf(snapshot, name, sourceId) {
  const item = inboxItemsOf(snapshot).find((entry) => entry.name === name)
  const copy = item?.copies.find((entry) => entry.sourceId === sourceId)
  if (copy) return { item, copy }
  const skill = (snapshot?.skills || []).find((entry) => entry.name === name)
  const gate = Object.values(skill?.gate || {}).find((entry) => entry?.copy?.sourceId === sourceId)
  return gate ? gateCollectTarget(name, gate) : null
}

/**
 * 左栏一条要处理的「在哪」：项目名或「工具 全局」，去重后顿号连；多于 1 份加份数
 * @param {object} item
 * @returns {string}
 */
export function inboxWhere(item) {
  const places = []
  for (const copy of item.copies || []) {
    const place = copy.scope === 'project' ? copy.projectName : `${TOOL_SHORTS[copy.toolId] || copy.toolId} 全局`
    if (!places.includes(place)) places.push(place)
  }
  const count = (item.copies || []).length
  return count > 1 ? `${places.join('、')} · ${count} 份` : places.join('、')
}

/**
 * 一份在哪：「Claude Code · my-blog 项目」/「Codex · 全局目录」
 * @param {{toolId: string, scope: string, projectName?: string|null}} copy
 * @returns {string}
 */
export function copyLabel(copy) {
  return `${toolLabelOf(copy.toolId)} · ${copy.scope === 'project' ? `${copy.projectName} 项目` : '全局目录'}`
}

function fileRank(file) {
  if (file === 'SKILL.md') return 0
  if (file.startsWith('scripts/') || /\.(py|sh|js|mjs|cjs|ts|rb)$/.test(file)) return 1
  return 2
}

/**
 * 一份和资产库差在哪些文件：SKILL.md 第一、脚本其次、其余按名字
 * @param {{added?: string[], removed?: string[], changed?: string[]}} diff
 * @returns {Array<{kind: '多'|'少'|'改', file: string}>}
 */
export function diffFiles(diff = {}) {
  const files = [
    ...(diff.added || []).map((file) => ({ kind: '多', file })),
    ...(diff.removed || []).map((file) => ({ kind: '少', file })),
    ...(diff.changed || []).map((file) => ({ kind: '改', file })),
  ]
  return files.sort((left, right) => fileRank(left.file) - fileRank(right.file) || left.file.localeCompare(right.file))
}

/**
 * 「和资产库不一样：多 1 个，少 3 个，改了 2 个」（为 0 的不写）
 * @param {object} diff
 * @param {string} [against] - 和谁比：默认资产库；几份都不在资产库时是「第一份」
 * @returns {string}
 */
export function diffSummary(diff = {}, against = '资产库') {
  const parts = [['多', diff.added], ['少', diff.removed], ['改了', diff.changed]]
    .filter(([, list]) => (list || []).length > 0)
    .map(([label, list]) => `${label} ${list.length} 个`)
  return `和${against}不一样：${parts.join('，')}`
}

/**
 * 这个名字最近一次还没撤回的收进（详情顶上的卡片用）
 * @param {object|null} snapshot
 * @param {string} name
 * @returns {object|null}
 */
export function latestOperation(snapshot, name) {
  return (snapshot?.operations || [])
    .filter((op) => op.name === name && op.state !== 'undone')
    .sort((left, right) => String(right.at).localeCompare(String(left.at)))[0] || null
}

/**
 * 收进记录的时间：今天写「21:40」（列表里写「今天 21:40」），更早写「9月30日 18:30」
 * @param {string} iso
 * @param {{todayPrefix?: boolean, now?: Date}} [options]
 * @returns {string}
 */
export function formatOpTime(iso, { todayPrefix = false, now = new Date() } = {}) {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return '—'
  const hm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  const sameDay = time.getFullYear() === now.getFullYear() && time.getMonth() === now.getMonth() && time.getDate() === now.getDate()
  if (sameDay) return todayPrefix ? `今天 ${hm}` : hm
  return `${time.getMonth() + 1}月${time.getDate()}日 ${hm}`
}

/**
 * 撤不了 / 恢复停住的原因
 * @param {string} reason
 * @param {string} [toolId] - 配置被改时写哪个工具
 * @returns {string}
 */
export function undoReasonText(reason, toolId) {
  switch (reason) {
    case 'source-occupied': return '原位置已经有同名文件夹'
    case 'library-changed': return '资产库里这份后来改过'
    case 'config-changed': return `${toolLabelOf(toolId || 'claude-code')} 的设置后来改过`
    case 'library-moved': return '资产库换了位置'
    case 'backup-incomplete': return '备份不完整'
    case 'later-operation': return '先撤回后面那次'
    case 'slot-changed': return '工具里的链接后来换过'
    case 'project-gone': return '原位置不在了，备份还在'
    default: return '现场和记录对不上'
  }
}

const READ_ONLY_ORIGINS = new Set(['synced', 'system', 'plugin', 'project', 'bundled', 'command'])

/**
 * 这个 Skill 是只读的（claude.ai 同步来的、Codex 系统自带的）
 * @param {object} skill
 * @returns {boolean}
 */
export function isReadOnly(skill) {
  return !skill.managed && (skill.origins || []).length > 0 && skill.origins.every((origin) => origin.mutable === false || READ_ONLY_ORIGINS.has(origin.origin))
}

const READ_ONLY_KINDS = Object.freeze({
  synced: { list: 'claude.ai 同步', header: 'claude.ai 同步 · 只读', where: '在 claude.ai 的设置里关' },
  system: { list: 'Codex 系统', header: 'Codex 系统自带 · 只读', where: 'Codex 自带，关不了' },
  command: { list: '旧命令', header: 'Claude Code 旧命令 · 只读', where: '在 ~/.claude/commands 里管理' },
})

/**
 * 只读 Skill 的来历，决定列表行尾、栏头与「去哪关」三处文案（按来源分，不再默认当 Codex 系统）
 * @param {object} skill
 * @returns {{list: string, header: string, where: string}}
 */
export function readOnlyKind(skill) {
  const origins = (skill.origins || []).map((origin) => origin.origin)
  const key = ['synced', 'system', 'command'].find((item) => origins.includes(item))
  return READ_ONLY_KINDS[key] || { list: '只读', header: '只读', where: '在它所属的工具里管理' }
}

/** 外部 Skill：不在资产库、可以收进来 */
export function isExternal(skill) {
  return !skill.managed && !isReadOnly(skill)
}

/** 至少在一个工具里装载着 */
export function isLoaded(skill) {
  return Object.values(skill.tools || {}).some((state) => state?.enabled === true)
}

/** 有位置已经找不到（删了、快捷方式断了） */
export function hasMissingFolder(skill) {
  return (skill.locations || []).some((location) => location.missing)
}

/** 同一个工具里装了两份（内容不一样） */
export function hasDuplicate(skill) {
  return Object.values(skill.tools || {}).some((state) => state?.duplicate)
}

/**
 * 某个工具的读取状态
 * @param {object|null} snapshot
 * @param {string} toolId
 * @returns {'ok'|'missing'|'unreadable'}
 */
export function toolStatus(snapshot, toolId) {
  const errors = (snapshot?.errors || []).filter((error) => error.toolId === toolId)
  if (errors.some((error) => error.code === 'CODEX_NOT_FOUND')) return 'missing'
  // 个人 Skill 目录读不出（权限等）也算读不出，不能显示成一个都没装
  if (errors.some((error) => ['tool', 'config', 'settings', 'user', 'legacy'].includes(error.origin))) return 'unreadable'
  return 'ok'
}

/** claude.ai 同步目录读不出 */
export function syncedUnreadable(snapshot) {
  return (snapshot?.errors || []).some((error) => error.toolId === 'claude-code' && error.origin === 'synced')
}

/**
 * 名字和用途里是否含搜索词
 * @param {object} skill
 * @param {string} query - 已 trim
 * @returns {boolean}
 */
export function matchesQuery(skill, query) {
  if (!query) return true
  const needle = query.toLowerCase()
  return [skill.name, skill.displayName, skill.description].some((value) => String(value || '').toLowerCase().includes(needle))
}

/**
 * 把一段文字按搜索词切开，命中的片段标 hit
 * @param {string} text
 * @param {string} query
 * @returns {Array<{text: string, hit: boolean}>}
 */
export function splitHits(text, query) {
  const value = String(text || '')
  if (!query) return [{ text: value, hit: false }]
  const lower = value.toLowerCase()
  const needle = query.toLowerCase()
  const parts = []
  let index = 0
  while (index < value.length) {
    const found = lower.indexOf(needle, index)
    if (found < 0) {
      parts.push({ text: value.slice(index), hit: false })
      break
    }
    if (found > index) parts.push({ text: value.slice(index, found), hit: false })
    parts.push({ text: value.slice(found, found + needle.length), hit: true })
    index = found + needle.length
  }
  return parts
}

/**
 * 左栏分组
 * @param {object[]} skills - 快照里的 Skill
 * @param {object} options
 * @param {Map<string, object>} options.usageMap - 名字 → { total, claude, codex }
 * @param {boolean} options.usageFailed - 次数读不出（资产库两组合成一组）
 * @param {string} options.query - 搜索词
 * @param {object[]} [options.inbox] - 要处理清单（快照 inbox.items）
 * @returns {Array<{id: string, title: string, skills: object[]}>} 空组不返回；要处理组里是清单条目，不是 Skill
 */
export function buildGroups(skills, { usageMap = new Map(), usageFailed = false, query = '', inbox = [] } = {}) {
  const visible = skills.filter((skill) => matchesQuery(skill, query))
  const count = (skill) => usageMap.get(skill.name)?.total || 0
  const byName = (a, b) => a.name.localeCompare(b.name)
  const managed = visible.filter((skill) => skill.managed)
  // 要处理排第一；全局目录里资产库没有的已经在这里，不再单列「外部」组
  const groups = [{ id: 'inbox', title: '要处理', skills: inbox.filter((item) => matchesQuery(item, query)) }]
  if (usageFailed) {
    groups.push({ id: 'library', title: '资产库', skills: [...managed].sort(byName) })
  } else {
    const used = managed.filter((skill) => count(skill) > 0).sort((a, b) => count(b) - count(a) || byName(a, b))
    // 近 30 天没用里，还在装载的最该关，排最前
    const unused = managed.filter((skill) => count(skill) === 0)
      .sort((a, b) => Number(isLoaded(b)) - Number(isLoaded(a)) || byName(a, b))
    groups.push({ id: 'used', title: '在用 · 近 30 天', skills: used })
    groups.push({ id: 'unused', title: '近 30 天没用', skills: unused })
    groups.push({ id: 'readonly', title: '只读 · 同步来的和系统自带的', skills: visible.filter(isReadOnly) })
    return groups.filter((group) => group.skills.length > 0)
  }
  groups.push({ id: 'readonly', title: '只读 · 同步来的和系统自带的', skills: visible.filter(isReadOnly) })
  return groups.filter((group) => group.skills.length > 0)
}

const TAB_LABELS = Object.freeze({ inbox: '要处理', used: '在用', unused: '没用', library: '资产库' })

/**
 * 左栏页签（2026-10-03 用户试用后定：要处理 | 在用 | 没用；读不出调用次数时 要处理 | 资产库）
 * @param {boolean} usageFailed
 * @returns {string[]}
 */
export function tabIdsOf(usageFailed) {
  return usageFailed ? ['inbox', 'library'] : ['inbox', 'used', 'unused']
}

/** 这一组（不带搜索词）有没有东西 */
const hasGroup = (baseGroups, id) => baseGroups.some((group) => group.id === id && group.skills.length > 0)

/**
 * 出哪几个页签：按不带搜索词的分组算，为 0 的不出（用户 10-03）；只剩一个时整排不出
 * @param {Array} baseGroups - 不带搜索词的 buildGroups 结果
 * @param {boolean} usageFailed
 * @returns {string[]}
 */
export function visibleTabsOf(baseGroups, usageFailed) {
  const tabs = tabIdsOf(usageFailed).filter((tab) => hasGroup(baseGroups, tab))
  return tabs.length > 1 ? tabs : []
}

/**
 * 某个页签里列哪几组：只读组跟在最后一个页签末尾（左栏 220 宽放不下第四个）
 * @param {string} tab
 * @param {string[]} tabs - visibleTabsOf 的结果
 * @returns {string[]} 分组 id
 */
export function groupIdsOfTab(tab, tabs) {
  return tab === tabs[tabs.length - 1] ? [tab, 'readonly'] : [tab]
}

/**
 * 分组属于哪个页签
 * @param {string} groupId
 * @param {string[]} tabs - visibleTabsOf 的结果
 * @returns {string|null}
 */
export function tabOfGroup(groupId, tabs) {
  return tabs.find((tab) => groupIdsOfTab(tab, tabs).includes(groupId)) || null
}

/**
 * 当前该停在哪个页签：选过的还在就留着；没选过（或选过的没了）有要处理先停要处理（用户 10-03），
 * 否则停第一个还在的；次数读出 / 读不出切换时在用、没用和资产库互相对应
 * @param {string|null} chosen
 * @param {Array} baseGroups
 * @param {boolean} usageFailed
 * @returns {string|null} 页签整排不出时为 null
 */
export function resolveTab(chosen, baseGroups, usageFailed) {
  const present = visibleTabsOf(baseGroups, usageFailed)
  if (present.length === 0) return null
  if (chosen && present.includes(chosen)) return chosen
  if (usageFailed && (chosen === 'used' || chosen === 'unused') && present.includes('library')) return 'library'
  if (!usageFailed && chosen === 'library') return present.find((tab) => tab !== 'inbox') || present[0]
  return present[0]
}

/**
 * 页签的选项：名字 + 条数（搜索时是搜到的条数，只读组不算）
 * @param {string[]} tabs - visibleTabsOf 的结果
 * @param {Array} groups - 当前（可能带搜索词）的 buildGroups 结果
 * @returns {Array<{value: string, label: string, count: number}>}
 */
export function tabOptionsOf(tabs, groups) {
  const count = (tab) => groups.find((group) => group.id === tab)?.skills.length || 0
  return tabs.map((tab) => ({ value: tab, label: TAB_LABELS[tab], count: count(tab) }))
}

/**
 * 选中的这一条在哪一组（不在列表里返回 null）
 * @param {Array} groups
 * @param {string} selectedId
 * @returns {string|null}
 */
export function groupOfSelected(groups, selectedId) {
  const name = inboxNameOf(selectedId)
  const group = groups.find((item) => (name
    ? item.id === 'inbox' && item.skills.some((skill) => skill.name === name)
    : item.id !== 'inbox' && item.skills.some((skill) => skill.name === selectedId)))
  return group ? group.id : null
}

/**
 * 上下文估算的写法：约 2.5k tokens
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokens(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return '—'
  if (tokens < 100) return '不到 0.1k'
  return `${(Math.round(tokens / 100) / 10).toFixed(1)}k`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const pad = (value) => String(value).padStart(2, '0')

/**
 * 调用记录的时间：今天「14:32」、昨天「昨天 14:32」、前 7 天「周六 20:42」、更早「9月20日 20:21」，跨年加年份
 * @param {string} iso
 * @param {Date} [now]
 * @returns {string}
 */
export function formatRecordTime(iso, now = new Date()) {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return '—'
  const hm = `${pad(time.getHours())}:${pad(time.getMinutes())}`
  const startOf = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(time)) / 86400000)
  if (days === 0) return hm
  if (days === 1) return `昨天 ${hm}`
  if (days > 1 && days < 7) return `${WEEKDAYS[time.getDay()]} ${hm}`
  const md = `${time.getMonth() + 1}月${time.getDate()}日 ${hm}`
  return time.getFullYear() === now.getFullYear() ? md : `${time.getFullYear()}年${md}`
}

/**
 * 调用记录的项目名：Claude 的会话目录是编码后的 cwd，取最后一段；Codex 没有项目，留空
 * @param {object} record
 * @returns {string}
 */
export function recordProject(record) {
  const relative = record?.session?.relativePath || ''
  if (record?.tool !== 'claude' || !relative.includes('/')) return ''
  const encoded = relative.split('/')[0]
  const parts = encoded.split('-').filter(Boolean)
  return parts[parts.length - 1] || ''
}

/**
 * 详情栏头的来源说明
 * @param {object} skill
 * @returns {string}
 */
export function sourceLabel(skill) {
  if (skill.managed) return '个人'
  if (isReadOnly(skill)) return readOnlyKind(skill).header
  return '外部，不在资产库'
}
