/**
 * 要处理清单
 *
 * 负责：
 * - 扫两个工具的全局目录和找到的项目目录，列出还没进资产库的每一份：
 *   全局目录里资产库没有的、和资产库不一样的；项目里的每一份（不论一样不一样）（「要什么」第 4 版、定稿 A5）
 * - 已核实指向资产库的链接不算（A18）；插件、claude.ai 同步、系统自带的不进（A11）；忽略过的不进（A12）
 * - 每份和资产库比：一样 / 不一样（多、少、改了哪些文件）/ 资产库没有；同名都不在资产库时比较彼此（A16）；
 *   Codex 项目里 SKILL.md 不同的标适配提醒（C15）；排序 不一样 → 资产库已有 → 资产库没有、同类按名字（A10）
 * - 资产库已有的名字：每个工具的全局位置被谁占着、为什么（gate，C13）；从项目收进会被挡的份标 blockedBy
 * - 只读：不写任何东西；可以只扫给定的几个名字（单个操作后只重读这个名字）
 * 对外的结果里不带绝对路径；绝对路径只放在 copiesById 里供主进程自己用。
 *
 * @module electron/modules/skills/inboxScan
 */

const fs = require('fs/promises')
const path = require('path')
const { readEntries, contentDigest, compareEntries } = require('./skillDigest')
const { isIgnored } = require('./ignoreStore')
const { slotPaths, occupiedSlot } = require('./slotGuard')
const { readSkillMetadata } = require('../../services/skillMetadataService')

const KIND_ORDER = { diff: 0, same: 1, none: 2 }

function displayPath(absolutePath, homeDir) {
  if (absolutePath === homeDir) return '~'
  return absolutePath.startsWith(`${homeDir}${path.sep}`) ? `~${absolutePath.slice(homeDir.length)}` : absolutePath
}

/** 和快照里来源的 sourceId 同一个算法（工具 + 来源类别 + 位置），延迟加载避免循环引用 */
function sourceIdOf(toolId, origin, absolutePath) {
  return require('../../services/skillControlService').sourceIdOf(toolId, { origin, absolutePath })
}

async function realpathOrNull(target) {
  try { return await fs.realpath(target) } catch { return null }
}

const isSafeName = (name) => typeof name === 'string' && name.length > 0 && !name.startsWith('.') && path.basename(name) === name

/**
 * 一个根目录下的 Skill 条目（目录或链接，里面有 SKILL.md）
 * @returns {Promise<Array<{name: string, absolutePath: string, isLink: boolean}>>}
 */
async function listRoot(root, names) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!isSafeName(entry.name) || (names && !names.has(entry.name))) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const absolutePath = path.join(root, entry.name)
    try {
      await fs.access(path.join(absolutePath, 'SKILL.md'))
    } catch {
      continue
    }
    out.push({ name: entry.name, absolutePath, isLink: entry.isSymbolicLink() })
  }
  return out
}

/** 要扫的根：两个工具的全局目录 + 每个找到的项目里的三类目录 */
function rootsOf(homeDir, projects) {
  const roots = [
    { toolId: 'claude-code', scope: 'global', origin: 'user', root: path.join(homeDir, '.claude', 'skills') },
    { toolId: 'codex', scope: 'global', origin: 'user', root: path.join(homeDir, '.agents', 'skills') },
    { toolId: 'codex', scope: 'global', origin: 'legacy', root: path.join(homeDir, '.codex', 'skills') },
  ]
  for (const project of projects?.projects || []) {
    for (const item of project.roots || []) {
      roots.push({ toolId: item.toolId, scope: 'project', origin: 'project', root: item.root, projectName: project.name, projectPath: project.path })
    }
  }
  return roots
}

function loadStateOf(copy, { claudeOverrides, codexListed }) {
  if (copy.toolId === 'claude-code') return claudeOverrides?.get(copy.name) === 'disabled' ? 'disabled' : 'loaded'
  if (codexListed === null) return 'unknown'
  const hit = (codexListed || []).find((item) => item.path === copy.realSkillMd)
  if (!hit) return 'loaded'
  return hit.enabled === false ? 'disabled' : 'loaded'
}

/**
 * 扫出候选的每一份（含已链接资产库、忽略过、全局一样的——后面再分去处）
 * @returns {Promise<Map<string, object[]>>} 名字 → 各份（带绝对路径）
 */
async function scanCopies({ homeDir, projects, names }) {
  const byName = new Map()
  for (const spec of rootsOf(homeDir, projects)) {
    for (const entry of await listRoot(spec.root, names)) {
      const real = await realpathOrNull(entry.absolutePath)
      if (!real) continue
      // 插件目录里的不进（插件自己管）
      if (real.includes(`${path.sep}.claude${path.sep}plugins${path.sep}`) || real.includes(`${path.sep}.codex${path.sep}plugins${path.sep}`)) continue
      const copy = {
        name: entry.name,
        toolId: spec.toolId,
        scope: spec.scope,
        origin: spec.origin,
        projectName: spec.projectName || null,
        projectPath: spec.projectPath || null,
        absolutePath: entry.absolutePath,
        displayPath: displayPath(entry.absolutePath, homeDir),
        isLink: entry.isLink,
        linkTarget: entry.isLink ? await fs.readlink(entry.absolutePath).catch(() => null) : null,
        real,
        realSkillMd: await realpathOrNull(path.join(entry.absolutePath, 'SKILL.md')),
        // 链接指到别处时给实际位置（~ 写法），页面在路径下面多写一行「→ 实际位置」
        targetDisplay: entry.isLink ? displayPath(real, homeDir) : null,
      }
      copy.sourceId = sourceIdOf(copy.toolId, copy.origin, copy.absolutePath)
      if (!byName.has(entry.name)) byName.set(entry.name, [])
      byName.get(entry.name).push(copy)
    }
  }
  return byName
}

function publicCopy(copy) {
  return {
    sourceId: copy.sourceId,
    toolId: copy.toolId,
    scope: copy.scope,
    projectName: copy.projectName,
    displayPath: copy.displayPath,
    relation: copy.relation,
    digest: copy.digest,
    diff: copy.diff,
    peerDiff: copy.peerDiff || null,
    adaptedHint: copy.adaptedHint,
    isLink: copy.isLink,
    targetDisplay: copy.targetDisplay || null,
    loadState: copy.loadState,
    blockedBy: copy.blockedBy,
  }
}

/**
 * 把一个名字的各份分到：清单 / 已链接资产库 / 忽略 / 全局一样，并算资产库已有时的占位原因
 * @returns {Promise<{item: object|null, gate: object|null, copies: object[]}>}
 */
async function classifyName(name, copies, ctx) {
  const libraryPath = path.join(ctx.repoPath, name)
  let libraryEntries = null
  try {
    await fs.access(path.join(libraryPath, 'SKILL.md'))
    libraryEntries = await readEntries(libraryPath, ctx.deps)
  } catch {
    libraryEntries = null
  }
  const libraryReal = libraryEntries ? await realpathOrNull(libraryPath) : null
  const linkedTools = new Set()
  const listed = []
  const everyCopy = []
  for (const copy of copies) {
    if (libraryReal && copy.real === libraryReal) {
      if (copy.scope === 'global') linkedTools.add(copy.toolId)
      continue
    }
    let entries
    try {
      entries = await readEntries(copy.absolutePath, ctx.deps)
    } catch {
      continue
    }
    copy.entries = entries
    copy.digest = contentDigest(entries)
    if (libraryEntries) {
      const compared = compareEntries(libraryEntries, entries)
      copy.relation = compared.relation
      copy.diff = { added: compared.added, removed: compared.removed, changed: compared.changed }
    } else {
      copy.relation = 'none'
      copy.diff = { added: [], removed: [], changed: [] }
    }
    copy.adaptedHint = copy.toolId === 'codex' && copy.scope === 'project' && copy.relation === 'diff' && copy.diff.changed.includes('SKILL.md')
    copy.ignored = isIgnored(ctx.ignores, copy.toolId, copy.absolutePath)
    copy.loadState = loadStateOf(copy, ctx)
    everyCopy.push(copy)
    // 全局目录里和资产库一样的不进清单（范围）；忽略过的不进
    if (copy.ignored) continue
    if (copy.scope === 'global' && copy.relation === 'same') continue
    listed.push(copy)
  }

  // 收进到某个工具时那个工具的全局位置被占着：这一份收不了（全局那份自己就是这个位置时不算）
  for (const copy of listed) {
    const occupied = await occupiedSlot({ homeDir: ctx.homeDir, toolId: copy.toolId, name, libraryPath, except: copy.absolutePath })
    copy.blockedBy = occupied ? { toolId: copy.toolId } : null
  }

  // 资产库已有的名字：每个工具的全局位置被谁占着
  let gate = null
  if (libraryEntries) {
    for (const toolId of ['claude-code', 'codex']) {
      for (const slot of slotPaths(ctx.homeDir, toolId, name)) {
        const occupant = everyCopy.find((copy) => copy.absolutePath === slot)
        if (!occupant) continue
        let why
        if (occupant.ignored) why = 'ignored'
        else if (occupant.relation !== 'same') why = 'pending'
        else why = occupant.isLink ? 'external' : 'same'
        const entry = { why }
        if (why === 'same' || why === 'external') {
          // 「换成链接」走收进：确认框要拿资产库这一版去核对，也要知道哪些工具链着资产库
          entry.sourceId = occupant.sourceId
          entry.copy = publicCopy({ ...occupant, blockedBy: null })
          entry.libraryDigest = contentDigest(libraryEntries)
          entry.linkedTools = [...linkedTools]
        }
        gate = { ...(gate || {}), [toolId]: entry }
        break
      }
    }
  }

  if (listed.length === 0) return { item: null, gate, copies: everyCopy }
  const relations = new Set(listed.map((copy) => copy.relation))
  const relation = relations.has('diff') ? 'diff' : relations.has('same') ? 'same' : 'none'
  let peers = null
  if (!libraryEntries && listed.length > 1) peers = new Set(listed.map((copy) => copy.digest)).size === 1 ? 'same' : 'diff'
  // 几份都不在资产库且不一样：从第二份起写和第一份差在哪（定稿 A16）
  if (peers === 'diff') {
    for (const copy of listed.slice(1)) {
      const compared = compareEntries(listed[0].entries, copy.entries)
      copy.peerDiff = compared.relation === 'same' ? null : { added: compared.added, removed: compared.removed, changed: compared.changed }
    }
  }
  const metadata = await readSkillMetadata(listed[0].absolutePath, ctx.deps)
  const item = {
    name,
    displayName: metadata.name || name,
    description: metadata.description || '',
    relation,
    libraryDigest: libraryEntries ? contentDigest(libraryEntries) : null,
    peers,
    linkedTools: [...linkedTools],
    copies: listed.map(publicCopy),
  }
  return { item, gate, copies: everyCopy }
}

/**
 * 算要处理清单
 * @param {object} params
 * @param {string} params.homeDir
 * @param {string} params.repoPath - 资产库绝对路径
 * @param {{scanned: number, projects: Array}} params.projects - discoverProjects 的结果
 * @param {Array} params.ignores - 忽略记录
 * @param {string[]} [params.names] - 只算这几个名字
 * @param {Map<string,string>} [params.claudeOverrides] - Claude 设置里每个名字的开关状态（装载状态用）
 * @param {Array|null} [params.codexListed] - Codex 接口列出的 Skill；null 表示读不出
 * @param {object} [deps] - readFileFn 等可注入
 * @returns {Promise<{items: object[], gates: Record<string, object>, projects: {scanned: number, found: object[]}, copiesById: Map<string, object>}>}
 */
async function buildInbox({ homeDir, repoPath, projects, ignores = [], names, claudeOverrides, codexListed }, deps = {}) {
  const nameSet = names ? new Set(names) : null
  const byName = await scanCopies({ homeDir, projects, names: nameSet })
  const ctx = { homeDir, repoPath, ignores, claudeOverrides, codexListed: codexListed === undefined ? [] : codexListed, deps }
  const items = []
  const gates = {}
  const copiesById = new Map()
  const libraryNames = new Set()
  if (nameSet) {
    for (const name of nameSet) {
      if (!byName.has(name)) byName.set(name, [])
    }
  }
  for (const [name, copies] of byName) {
    const { item, gate, copies: classified } = await classifyName(name, copies, ctx)
    if (item) items.push(item)
    if (gate) gates[name] = gate
    for (const copy of classified) copiesById.set(copy.sourceId, copy)
    if (gate) libraryNames.add(name)
  }
  items.sort(byKind)
  return { items, gates, projects: summarizeProjects(projects, items, copiesById), copiesById }
}

const byKind = (left, right) => KIND_ORDER[left.relation] - KIND_ORDER[right.relation] || left.name.localeCompare(right.name)

/** 每个找到的项目里有几份在清单上 */
function summarizeProjects(projects, items, copiesById) {
  const counts = new Map()
  for (const item of items) {
    for (const copy of item.copies) {
      const internal = copiesById.get(copy.sourceId)
      if (internal?.projectPath) counts.set(internal.projectPath, (counts.get(internal.projectPath) || 0) + 1)
    }
  }
  const found = (projects?.projects || []).map((project) => ({
    name: project.name,
    displayPath: project.displayPath,
    copies: counts.get(project.path) || 0,
    error: project.error || null,
  }))
  return { scanned: projects?.scanned || 0, found }
}

/**
 * 只重读了几个名字：把新结果并进上次的清单
 * @param {object} previous - 上次 buildInbox 的结果
 * @param {object} fresh - 这几个名字的 buildInbox 结果
 * @param {string[]} names
 * @param {object} projects
 * @returns {object} 与 buildInbox 同形
 */
function mergeInbox(previous, fresh, names, projects) {
  const touched = new Set(names)
  const items = [...previous.items.filter((item) => !touched.has(item.name)), ...fresh.items].sort(byKind)
  const gates = Object.fromEntries(Object.entries(previous.gates).filter(([name]) => !touched.has(name)))
  Object.assign(gates, fresh.gates)
  const copiesById = new Map([...previous.copiesById].filter(([, copy]) => !touched.has(copy.name)))
  for (const [id, copy] of fresh.copiesById) copiesById.set(id, copy)
  return { items, gates, projects: summarizeProjects(projects, items, copiesById), copiesById }
}

module.exports = { buildInbox, mergeInbox }
