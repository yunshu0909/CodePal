/**
 * 对话回顾服务
 *
 * 负责：
 * - 跨项目列出最近的 Claude Code 对话（只读每个文件的头尾，不整份读）
 * - 从对话文件尾部倒着分页读消息，过滤系统注入的内容，带上工具调用与压缩标记
 * - 按项目 / 是否含自动调用的范围做全文搜索
 * - 数据目录可由 CODEPAL_CLAUDE_PROJECTS_DIR 或参数覆盖（测试与截图用构造数据）
 *
 * 规则来源：specs/redesign-CodePal视觉重做/对话回顾-定稿/前端设计定稿-对话回顾.md §7
 *
 * @module electron/services/sessionBrowserService
 */

const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const { backgroundProjectsDir: resolveBackgroundProjectsDir } = require('../platform/modelPaths')
const { readHeadLines, scanBackward, scanForward } = require('./sessionFileReader')
// 与已安装的会话钩子共享前缀，避免两处把同一条系统注入判成不同来源。
const SYSTEM_MESSAGE_PREFIXES = require('../../templates/k28-status-light/system-message-prefixes.json')

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024
const TITLE_MAX = 80
const TARGET_MAX = 60
const SNIPPET_SIDE = 40
const META_LIMIT = 10_000
const META_MAX_AGE_MS = 10 * 60_000
const metadataIndex = new Map()
const SAFE_ID = /^[a-zA-Z0-9_-]+$/

/**
 * 当前数据目录：参数 > 环境变量 > ~/.claude/projects（每次调用时取，便于测试切换）
 * @param {string} [override] - 调用方传入的目录
 * @returns {string}
 */
function getProjectsDir(override) {
  return override || process.env.CODEPAL_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
}

/** @param {object} options Trusted service overrides. @returns {Array<object>} Server-owned source roots. */
function sourceRoots(options = {}) {
  const primary = getProjectsDir(options.projectsDir)
  // A fixture-only primary override must never pull production conversations into tests/screenshots.
  const isolated = options.backgroundProjectsDir ||
    ((!options.projectsDir && !process.env.CODEPAL_CLAUDE_PROJECTS_DIR) || process.env.CODEPAL_MODELS_HOME
      ? resolveBackgroundProjectsDir() : null)
  return [{ root: primary, source: null }, ...(isolated ? [{ root: isolated, source: 'codepal' }] : [])]
}

/** @param {string} root Trusted root. @param {string} projectId Raw ID. @param {string} sessionId Raw ID. @returns {Promise<string>} Confined canonical file. */
async function confinedFile(root, projectId, sessionId) {
  const file = sessionFile(root, projectId, sessionId)
  const realRoot = await fsp.realpath(root)
  const realFile = await fsp.realpath(file)
  const relative = path.relative(realRoot, realFile)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('INVALID_ID')
  return realFile
}

/** @param {object} options Trusted overrides. @param {string} projectId Namespaced or legacy ID. @param {string} sessionId Raw ID. @returns {Promise<string>} Resolved file. */
async function resolveSessionFile(options, projectId, sessionId) {
  const isBackground = typeof projectId === 'string' && projectId.startsWith('codepal:')
  const source = sourceRoots(options).find(item => item.source === (isBackground ? 'codepal' : null))
  if (!source) throw Error('INVALID_ID')
  return confinedFile(source.root, isBackground ? projectId.slice(8) : projectId, sessionId)
}

/**
 * 编码目录名的最后一段（没有 cwd 时的项目名兜底）
 * @param {string} encoded - 如 -Users-x-Documents-demo
 * @returns {string}
 */
function decodeProjectName(encoded) {
  const parts = encoded.replace(/^-/, '').split('-').filter(Boolean)
  return parts[parts.length - 1] || encoded
}

/**
 * 是否为 Claude Code 注入的系统标签消息（不是用户真正的输入）
 * @param {string} text
 * @returns {boolean}
 */
function isSystemTagMessage(text) {
  if (!text) return true
  const t = text.trimStart()
  return SYSTEM_MESSAGE_PREFIXES.some((prefix) => t.startsWith(prefix))
}

/** 把内容块数组或字符串里的文字拼起来 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
}

const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ').trim()

/**
 * 工具调用的对象：文件名 → 命令 → 匹配式 → 网址 → 说明，截 60 字
 * @param {object} input - tool_use 的 input
 * @returns {string}
 */
function toolTarget(input = {}) {
  const raw = (input.file_path && path.basename(String(input.file_path)))
    || input.command || input.pattern || input.url || input.description || ''
  return oneLine(String(raw)).slice(0, TARGET_MAX)
}

/**
 * 一行 JSON → 页面消息；不是消息的行返回 null
 * @param {object} obj - 解析后的行
 * @returns {{kind: 'ask'|'answer'|'compact', text?: string, toolUses?: Array, timestamp?: string}|null}
 */
function toMessage(obj) {
  if (!obj || typeof obj !== 'object') return null
  if (obj.type === 'user') {
    if (obj.isMeta) return null
    if (obj.isCompactSummary) return { kind: 'compact', timestamp: obj.timestamp || '' }
    const text = textOf(obj.message?.content)
    if (!text || isSystemTagMessage(text)) return null
    return { kind: 'ask', text, timestamp: obj.timestamp || '' }
  }
  if (obj.type === 'assistant') {
    const content = Array.isArray(obj.message?.content) ? obj.message.content : []
    const text = textOf(content)
    const toolUses = content
      .filter((c) => c && c.type === 'tool_use')
      .map((c) => ({ name: String(c.name || ''), target: toolTarget(c.input) }))
    if (!text && toolUses.length === 0) return null
    return { kind: 'answer', text, toolUses, timestamp: obj.timestamp || '' }
  }
  return null
}

function parse(text) {
  try { return JSON.parse(text) } catch { return null }
}

/**
 * 上级目录写法：家目录换成 ~
 * @param {string} dir
 * @returns {string}
 */
function tildify(dir) {
  const home = os.homedir()
  if (dir === home) return '~'
  return dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir
}

/**
 * 一个对话文件的元数据（只读头 64KB、尾 256KB）
 * @param {string} projectId - 编码后的项目目录名
 * @param {string} file - 对话文件路径
 * @param {object} stat - 本次枚举得到的文件状态，避免重复读取
 * @returns {Promise<object|null>} 一句真实提问都没有时返回 null
 */
async function readSessionMeta(projectId, file, stat) {
  let cwd = null
  let entrypoint = null
  let firstPrompt = null
  let branch = null
  for (const { text } of await readHeadLines(file, HEAD_BYTES)) {
    const obj = parse(text)
    if (!obj) continue
    if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd
    if (!entrypoint && typeof obj.entrypoint === 'string') entrypoint = obj.entrypoint
    if (typeof obj.gitBranch === 'string' && obj.gitBranch) branch = obj.gitBranch
    if (!firstPrompt) {
      const m = toMessage(obj)
      if (m && m.kind === 'ask') firstPrompt = m.text
    }
  }

  let aiTitle = null
  let lastPrompt = null
  let tailBranch = null
  let tailPrompt = null
  // 开头 64KB 可能全是大段快照行（真实数据里有），工作目录与启动方式也从尾部取一份兜底
  let tailCwd = null
  let tailEntrypoint = null
  // 最后一条助手消息的模型：CodePal 用别家模型开的会话（如 deepseek-flash）在详情里标出来
  let tailModel = null
  const needSession = () => !tailBranch || !tailPrompt || (!cwd && !tailCwd) || (!entrypoint && !tailEntrypoint)
  await scanBackward(file, { maxBytes: TAIL_BYTES }, (text) => {
    // 粗筛：只解析可能有用的行，避免尾部大段工具输出拖慢
    if (!aiTitle && text.includes('"ai-title"')) { const o = parse(text); if (o?.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle }
    if (!lastPrompt && text.includes('"last-prompt"')) { const o = parse(text); if (o?.type === 'last-prompt' && o.lastPrompt) lastPrompt = o.lastPrompt }
    if (!tailModel && text.includes('"assistant"') && text.includes('"model"')) {
      const o = parse(text)
      // <synthetic> 是 Claude Code 自己补的消息（如报错），不算模型
      if (o?.type === 'assistant' && typeof o.message?.model === 'string' && o.message.model && o.message.model !== '<synthetic>') tailModel = o.message.model
    }
    if (needSession() && (text.includes('"gitBranch"') || text.includes('"cwd"') || text.includes('"user"'))) {
      const o = parse(text)
      if (o) {
        if (!tailBranch && typeof o.gitBranch === 'string' && o.gitBranch) tailBranch = o.gitBranch
        if (!tailCwd && typeof o.cwd === 'string' && o.cwd) tailCwd = o.cwd
        if (!tailEntrypoint && typeof o.entrypoint === 'string') tailEntrypoint = o.entrypoint
        if (!tailPrompt) { const m = toMessage(o); if (m && m.kind === 'ask') tailPrompt = m.text }
      }
    }
    return !(aiTitle && lastPrompt && tailModel && !needSession())
  })
  cwd = cwd || tailCwd
  entrypoint = entrypoint || tailEntrypoint

  const anyPrompt = firstPrompt || tailPrompt
  if (!anyPrompt && !lastPrompt) return null
  const titleSource = aiTitle || anyPrompt
  return {
    projectId,
    sessionId: path.basename(file, '.jsonl'),
    title: titleSource ? oneLine(titleSource).slice(0, aiTitle ? undefined : TITLE_MAX) : null,
    preview: lastPrompt ? oneLine(lastPrompt) : null,
    projectPath: cwd,
    projectName: cwd ? path.basename(cwd) : decodeProjectName(projectId),
    parentDir: cwd ? tildify(path.dirname(cwd)) : null,
    branch: tailBranch || branch,
    modifiedAt: stat.mtime.toISOString(),
    auto: entrypoint === 'sdk-cli',
    model: tailModel,
  }
}

/** Identity is rechecked on every listing; no body bytes or credential data enter the index. */
function metadataIdentity(stat) {
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs])
}

async function indexedSessionMeta(root, projectId, file) {
  const stat = await fsp.stat(file)
  const identity = metadataIdentity(stat)
  const key = JSON.stringify([root, projectId, file])
  const prior = metadataIndex.get(key)
  if (prior?.identity === identity && (prior.pending || Date.now() < prior.expires)) {
    return structuredClone(await (prior.pending || Promise.resolve(prior.value)))
  }
  const entry = { identity, pending: null, value: null, expires: 0 }
  metadataIndex.delete(key)
  metadataIndex.set(key, entry)
  while (metadataIndex.size > META_LIMIT) metadataIndex.delete(metadataIndex.keys().next().value)
  entry.pending = readSessionMeta(projectId, file, stat).then(async value => {
    const after = await fsp.stat(file)
    if (metadataIndex.get(key) === entry) {
      if (identity === metadataIdentity(after)) {
        entry.value = value
        entry.expires = Date.now() + META_MAX_AGE_MS
      } else metadataIndex.delete(key)
    }
    return value
  }).catch(error => {
    if (metadataIndex.get(key) === entry) metadataIndex.delete(key)
    throw error
  }).finally(() => { entry.pending = null })
  return structuredClone(await entry.pending)
}

/**
 * 跨项目的最近对话
 * @param {{projectsDir?: string}} [options]
 * @returns {Promise<{projectsDirExists: boolean, sessions: Array<object>}>} 按修改时间倒序
 */
async function listRecent(options = {}) {
  const { signal } = options
  if (signal?.aborted) throw cancelledError()
  const sessions = []
  const seenRoots = new Set()
  for (const { root, source } of sourceRoots(options)) {
    let realRoot
    let entries
    try {
      realRoot = await fsp.realpath(root)
      if (seenRoots.has(realRoot)) continue
      entries = await fsp.readdir(realRoot, { withFileTypes: true })
      seenRoots.add(realRoot)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error(`没有权限读取 ${tildify(root)}`)
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      let files
      try {
        files = await fsp.readdir(path.join(realRoot, entry.name))
      } catch {
        continue
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue
        if (signal?.aborted) throw cancelledError()
        try {
          const file = await confinedFile(realRoot, entry.name, name.slice(0, -6))
          const meta = await indexedSessionMeta(realRoot, entry.name, file)
          if (signal?.aborted) throw cancelledError()
          if (meta) meta.sessionId = name.slice(0, -6)
          if (meta) sessions.push(source ? { ...meta, projectId: `codepal:${entry.name}`, source, auto: true } : meta)
        } catch (error) {
          if (error.code === 'CANCELLED') throw error
          // A damaged or escaped file cannot hide other valid conversations.
        }
      }
    }
  }
  if (signal?.aborted) throw cancelledError()
  // Expiry cleanup is request-driven; no watcher or timer remains after leaving the page.
  for (const [key, entry] of metadataIndex) {
    if (!entry.pending && Date.now() >= entry.expires) metadataIndex.delete(key)
  }
  sessions.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0))
  return { projectsDirExists: seenRoots.size > 0, sessions }
}

// 单页上限：条数封顶 + 字节预算（行原文长度）。超了先停，剩下的由页面「加载更早」接着读（B2-4）
const MAX_PAGE_LIMIT = 500
const PAGE_BYTE_BUDGET = 8 * 1024 * 1024

function cancelledError() {
  return Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' })
}

function sessionFile(root, projectId, sessionId) {
  if (!SAFE_ID.test(String(projectId)) || !SAFE_ID.test(String(sessionId))) throw new Error('INVALID_ID')
  return path.join(root, projectId, `${sessionId}.jsonl`)
}

/**
 * 从尾部（或 before 偏移处）倒着读一页消息
 * @param {string} projectId - 编码后的项目目录名
 * @param {string} sessionId - 对话 id
 * @param {{limit?: number, before?: number, projectsDir?: string}} [options]
 * @returns {Promise<{messages: Array<object>, hasMore: boolean, cursor: number}>} messages 按时间正序，cursor 传给下一页的 before
 */
async function readSessionPage(projectId, sessionId, options = {}) {
  const { limit = 200, before } = options
  const file = await resolveSessionFile(options, projectId, sessionId)
  await fsp.access(file)
  const pageLimit = Math.min(Math.max(1, Math.floor(Number(limit)) || 200), MAX_PAGE_LIMIT)
  const collected = []
  let bytes = 0
  const { earliestOffset } = await scanBackward(file, { before }, (text, offset) => {
    // 预算按实际字节、按扫过的每一行计（被过滤的工具输出等也要计入，否则会为凑一页扫完整个文件）
    bytes += Buffer.byteLength(text, 'utf8')
    const m = toMessage(parse(text))
    if (m) collected.push({ offset, ...m })
    if (collected.length >= pageLimit) return false
    // 至少带回一条消息；一直没有消息时，扫到预算的 4 倍也先停（hasMore 仍为真，游标接着往前）
    if (bytes >= PAGE_BYTE_BUDGET && (collected.length > 0 || bytes >= PAGE_BYTE_BUDGET * 4)) return false
    return true
  })
  const cursor = earliestOffset ?? 0
  return { messages: collected.reverse(), hasMore: cursor > 0, cursor }
}

/**
 * 在当前范围里搜对话正文（提问与回答的文字）
 * @param {string} keyword - 关键词
 * @param {{projectPath?: string|null, includeAuto?: boolean, maxResults?: number, projectsDir?: string, signal?: AbortSignal}} [options]
 *   signal：被取消（同一窗口发起了新搜索）就停止扫描，抛 code=CANCELLED
 * @returns {Promise<Array<{projectId: string, sessionId: string, snippet: string, offset: number}>>}
 */
async function searchSessions(keyword, options = {}) {
  const { projectPath = null, includeAuto = false, maxResults = 50, signal } = options
  if (signal?.aborted) throw cancelledError()
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return []
  const { sessions } = await listRecent(options)
  const scope = sessions.filter((s) => (includeAuto || !s.auto) && (!projectPath || s.projectPath === projectPath))
  const results = []
  // 关键词没有大小写之分（中文、数字、符号）时省掉每行转小写；非 ASCII 的大小写字母（Ä / É）也要走转小写
  const caseless = kw.toLowerCase() === kw.toUpperCase()
  const lineHas = caseless ? (text) => text.includes(kw) : (text) => text.toLowerCase().includes(kw)
  for (const s of scope) {
    if (signal?.aborted) throw cancelledError()
    if (results.length >= maxResults) break
    let hit = null
    try {
      await scanForward(await resolveSessionFile(options, s.projectId, s.sessionId), (text, offset) => {
        if (signal?.aborted) return false
        if (!lineHas(text)) return true
        if (text.includes('"media_type"') && text.includes('"data"')) return true // 跳过图片等大块编码
        const m = toMessage(parse(text))
        if (!m || !m.text) return true
        const idx = m.text.toLowerCase().indexOf(kw)
        if (idx < 0) return true
        const start = Math.max(0, idx - SNIPPET_SIDE)
        const end = Math.min(m.text.length, idx + kw.length + SNIPPET_SIDE)
        const snippet = (start > 0 ? '...' : '') + m.text.slice(start, end).replace(/\s*\n\s*/g, ' ') + (end < m.text.length ? '...' : '')
        hit = { projectId: s.projectId, sessionId: s.sessionId, snippet, offset }
        return false
      })
    } catch {
      continue
    }
    if (signal?.aborted) throw cancelledError()
    if (hit) results.push(hit)
  }
  return results
}

module.exports = { listRecent, readSessionPage, searchSessions, getProjectsDir, toMessage, isSystemTagMessage }
