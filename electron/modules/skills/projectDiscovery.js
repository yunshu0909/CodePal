/**
 * 找用过的项目
 *
 * 负责：
 * - 从 Claude Code 登记的项目列表（~/.claude.json 的 projects）和 Codex 会话记录第一行的工作目录
 *   （~/.codex/sessions/**\/*.jsonl）收集打开过的目录；会话只读第一行，不读对话内容
 * - 家目录和临时目录（家目录以外的系统临时目录）不算项目；只留真有 .claude/skills、.agents/skills、
 *   .codex/skills 的；skills 目录读不了的写原因（定稿状态清单 F1、B2）
 * - 不用配置；只读，不写任何东西
 *
 * @module electron/modules/skills/projectDiscovery
 */

const fs = require('fs/promises')
const os = require('os')
const path = require('path')

const PROJECT_ROOTS = Object.freeze([
  { toolId: 'claude-code', relative: ['.claude', 'skills'] },
  { toolId: 'codex', relative: ['.agents', 'skills'] },
  { toolId: 'codex', relative: ['.codex', 'skills'] },
])
const FIRST_LINE_LIMIT = 64 * 1024
const MAX_SESSION_DEPTH = 6

// 会话文件第一行的缓存：路径 → { mtimeMs, cwd }，没变的文件不重复读
const sessionCache = new Map()

function mapCode(error) {
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'PERMISSION_DENIED'
  if (error?.code === 'ENOENT') return 'NOT_FOUND'
  return 'READ_FAILED'
}

function displayPath(absolutePath, homeDir) {
  if (absolutePath === homeDir) return '~'
  return absolutePath.startsWith(`${homeDir}${path.sep}`) ? `~${absolutePath.slice(homeDir.length)}` : absolutePath
}

const isUnder = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`)

async function tempRoots(deps) {
  const roots = new Set(['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'])
  const tmp = deps.tmpdir ? deps.tmpdir() : os.tmpdir()
  roots.add(tmp)
  try { roots.add(await fs.realpath(tmp)) } catch { /* 读不出就只用原路径 */ }
  return [...roots]
}

async function readClaudeProjects(homeDir, deps) {
  try {
    const text = await (deps.readFileFn || fs.readFile)(path.join(homeDir, '.claude.json'), 'utf8')
    const projects = JSON.parse(text)?.projects
    return projects && typeof projects === 'object' ? Object.keys(projects) : []
  } catch {
    return []
  }
}

/** 只读一个文件的第一行（最多 64KB），不读后面的内容 */
async function readFirstLine(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(FIRST_LINE_LIMIT)
    const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_LIMIT, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const end = text.indexOf('\n')
    return end >= 0 ? text.slice(0, end) : text
  } finally {
    await handle.close()
  }
}

async function sessionCwd(filePath) {
  let stat
  try { stat = await fs.stat(filePath) } catch { return null }
  const cached = sessionCache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.cwd
  let cwd = null
  try {
    const first = JSON.parse(await readFirstLine(filePath))
    const value = first?.payload?.cwd ?? first?.cwd
    cwd = typeof value === 'string' && path.isAbsolute(value) ? value : null
  } catch {
    cwd = null
  }
  sessionCache.set(filePath, { mtimeMs: stat.mtimeMs, cwd })
  return cwd
}

async function readCodexSessionDirs(homeDir) {
  const found = []
  async function walk(dir, depth) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < MAX_SESSION_DEPTH) await walk(absolute, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const cwd = await sessionCwd(absolute)
        if (cwd) found.push(cwd)
      }
    }
  }
  await walk(path.join(homeDir, '.codex', 'sessions'), 0)
  return found
}

/**
 * 找用过、并且真有 Skill 目录的项目
 * @param {object} params
 * @param {string} params.homeDir
 * @param {object} [deps] - readFileFn / tmpdir 可注入
 * @returns {Promise<{scanned: number, projects: Array<{name: string, path: string, displayPath: string, roots: Array<{toolId: string, root: string}>, error: string|null}>}>}
 *   scanned 是去重后看过的目录数（含后来被排除的）
 */
async function discoverProjects({ homeDir }, deps = {}) {
  const recorded = [...await readClaudeProjects(homeDir, deps), ...await readCodexSessionDirs(homeDir)]
  const distinct = [...new Set(recorded.filter((item) => typeof item === 'string' && path.isAbsolute(item)).map((item) => path.resolve(item)))]
  const temps = await tempRoots(deps)
  const projects = []
  for (const projectPath of distinct) {
    if (projectPath === homeDir) continue
    if (!isUnder(projectPath, homeDir) && temps.some((root) => isUnder(projectPath, root))) continue
    let stat
    try { stat = await fs.stat(projectPath) } catch { continue }
    if (!stat.isDirectory()) continue
    const roots = []
    let error = null
    for (const spec of PROJECT_ROOTS) {
      const root = path.join(projectPath, ...spec.relative)
      let rootStat
      try { rootStat = await fs.stat(root) } catch { continue }
      if (!rootStat.isDirectory()) continue
      try {
        await fs.readdir(root)
      } catch (readError) {
        error = error || mapCode(readError)
      }
      roots.push({ toolId: spec.toolId, root })
    }
    if (roots.length === 0) continue
    projects.push({ name: path.basename(projectPath), path: projectPath, displayPath: displayPath(projectPath, homeDir), roots, error })
  }
  projects.sort((left, right) => left.displayPath.localeCompare(right.displayPath))
  return { scanned: distinct.length, projects }
}

module.exports = { discoverProjects }
