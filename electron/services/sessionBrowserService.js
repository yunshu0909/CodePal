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
const { readHeadLines, scanBackward, scanForward } = require('./sessionFileReader')

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024
const TITLE_MAX = 80
const TARGET_MAX = 60
const SNIPPET_SIDE = 40
const SAFE_ID = /^[a-zA-Z0-9_-]+$/

/**
 * 当前数据目录：参数 > 环境变量 > ~/.claude/projects（每次调用时取，便于测试切换）
 * @param {string} [override] - 调用方传入的目录
 * @returns {string}
 */
function getProjectsDir(override) {
  return override || process.env.CODEPAL_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
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
  return t.startsWith('<local-command-')
    || t.startsWith('<command-name>')
    || t.startsWith('<command-message>')
    || t.startsWith('<command-args>')
    || t.startsWith('<system-reminder>')
    || t.startsWith('Base directory for this skill:')
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
 * @returns {Promise<object|null>} 一句真实提问都没有时返回 null
 */
async function readSessionMeta(projectId, file) {
  const stat = await fsp.stat(file)
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
  const needSession = () => !tailBranch || !tailPrompt || (!cwd && !tailCwd) || (!entrypoint && !tailEntrypoint)
  await scanBackward(file, { maxBytes: TAIL_BYTES }, (text) => {
    // 粗筛：只解析可能有用的行，避免尾部大段工具输出拖慢
    if (!aiTitle && text.includes('"ai-title"')) { const o = parse(text); if (o?.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle }
    if (!lastPrompt && text.includes('"last-prompt"')) { const o = parse(text); if (o?.type === 'last-prompt' && o.lastPrompt) lastPrompt = o.lastPrompt }
    if (needSession() && (text.includes('"gitBranch"') || text.includes('"cwd"') || text.includes('"user"'))) {
      const o = parse(text)
      if (o) {
        if (!tailBranch && typeof o.gitBranch === 'string' && o.gitBranch) tailBranch = o.gitBranch
        if (!tailCwd && typeof o.cwd === 'string' && o.cwd) tailCwd = o.cwd
        if (!tailEntrypoint && typeof o.entrypoint === 'string') tailEntrypoint = o.entrypoint
        if (!tailPrompt) { const m = toMessage(o); if (m && m.kind === 'ask') tailPrompt = m.text }
      }
    }
    return !(aiTitle && lastPrompt && !needSession())
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
  }
}

/**
 * 跨项目的最近对话
 * @param {{projectsDir?: string}} [options]
 * @returns {Promise<{projectsDirExists: boolean, sessions: Array<object>}>} 按修改时间倒序
 */
async function listRecent({ projectsDir } = {}) {
  const root = getProjectsDir(projectsDir)
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return { projectsDirExists: false, sessions: [] }
    // 页面直接显示这句原因：权限问题写成人话，别把系统报错原样甩出去
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error(`没有权限读取 ${tildify(root)}`)
    throw error
  }
  const sessions = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    let files
    try {
      files = await fsp.readdir(path.join(root, entry.name))
    } catch {
      continue // 单个项目目录读不了不影响别的
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const meta = await readSessionMeta(entry.name, path.join(root, entry.name, name))
        if (meta) sessions.push(meta)
      } catch {
        // 单个文件坏了跳过
      }
    }
  }
  sessions.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0))
  return { projectsDirExists: true, sessions }
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
async function readSessionPage(projectId, sessionId, { limit = 200, before, projectsDir } = {}) {
  const file = sessionFile(getProjectsDir(projectsDir), projectId, sessionId)
  await fsp.access(file)
  const collected = []
  const { earliestOffset } = await scanBackward(file, { before }, (text, offset) => {
    const m = toMessage(parse(text))
    if (m) collected.push({ offset, ...m })
    return collected.length < limit
  })
  const cursor = earliestOffset ?? 0
  return { messages: collected.reverse(), hasMore: cursor > 0, cursor }
}

/**
 * 在当前范围里搜对话正文（提问与回答的文字）
 * @param {string} keyword - 关键词
 * @param {{projectPath?: string|null, includeAuto?: boolean, maxResults?: number, projectsDir?: string}} [options]
 * @returns {Promise<Array<{projectId: string, sessionId: string, snippet: string, offset: number}>>}
 */
async function searchSessions(keyword, { projectPath = null, includeAuto = false, maxResults = 50, projectsDir } = {}) {
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return []
  const root = getProjectsDir(projectsDir)
  const { sessions } = await listRecent({ projectsDir: root })
  const scope = sessions.filter((s) => (includeAuto || !s.auto) && (!projectPath || s.projectPath === projectPath))
  const results = []
  // 关键词没有大小写之分（中文、数字、符号）时省掉每行转小写；非 ASCII 的大小写字母（Ä / É）也要走转小写
  const caseless = kw.toLowerCase() === kw.toUpperCase()
  const lineHas = caseless ? (text) => text.includes(kw) : (text) => text.toLowerCase().includes(kw)
  for (const s of scope) {
    if (results.length >= maxResults) break
    let hit = null
    try {
      await scanForward(path.join(root, s.projectId, `${s.sessionId}.jsonl`), (text, offset) => {
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
    if (hit) results.push(hit)
  }
  return results
}

module.exports = { listRecent, readSessionPage, searchSessions, getProjectsDir, toMessage, isSystemTagMessage }
