/**
 * Transcript 定位服务
 *
 * 负责：
 * - 解析 Claude Code / Codex 的日志根目录
 * - 生成可移植的 POSIX relative path
 * - 在聚合扫描阶段按 session ID 修复失效路径
 * - 在详情阶段仅用 fs.access 判断日志是否仍可用
 *
 * @module electron/services/transcriptLocatorService
 */

const fs = require('fs/promises')
const path = require('path')

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

/**
 * 获取指定工具的 transcript 根目录。
 * @param {'claude'|'codex'} tool - AI 工具
 * @param {object} options - 定位选项
 * @param {string} options.homeDir - 用户主目录
 * @param {NodeJS.ProcessEnv|object} [options.env] - 环境变量
 * @returns {string}
 */
function getTranscriptRoot(tool, { homeDir, env = process.env }) {
  if (tool === 'claude') {
    return path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'projects')
  }
  if (tool === 'codex') {
    return path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'sessions')
  }
  throw new Error(`UNSUPPORTED_TRANSCRIPT_TOOL:${tool}`)
}

/**
 * 将绝对 transcript 路径转换为 POSIX relative path。
 * @param {string} root - transcript 根目录
 * @param {string} filePath - transcript 绝对路径
 * @returns {string}
 */
function toTranscriptRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

/**
 * 从 rollout / agent 文件名提取可用的 session ID。
 * @param {string} filePath - transcript 路径
 * @returns {string}
 */
function fallbackSessionIdFromPath(filePath) {
  const base = path.basename(filePath, path.extname(filePath))
  const uuid = base.match(UUID_RE)
  if (uuid) return uuid[0]
  if (base.startsWith('agent-')) return base.slice('agent-'.length)
  return base
}

/**
 * 解析 ledger 中的 relative path，阻止路径逃逸出 transcript root。
 * @param {string} root - transcript 根目录
 * @param {string} relativePath - ledger relative path
 * @returns {string|null}
 */
function resolveRelativeTranscriptPath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return null
  const resolved = path.resolve(root, ...relativePath.split('/'))
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}

/**
 * 详情查询只检查记录的 relative path，不扫描目录、不读取 transcript。
 * @param {object} invocation - invocation record
 * @param {object} options - 定位选项
 * @param {string} options.homeDir - 用户主目录
 * @param {NodeJS.ProcessEnv|object} [options.env] - 环境变量
 * @param {Function} [options.accessFn] - 可注入的 fs.access
 * @returns {Promise<'available'|'missing'>}
 */
async function getInvocationSourceAvailability(
  invocation,
  { homeDir, env = process.env, accessFn = fs.access }
) {
  try {
    const root = getTranscriptRoot(invocation.tool, { homeDir, env })
    const target = resolveRelativeTranscriptPath(root, invocation.session?.relativePath)
    if (!target) return 'missing'
    await accessFn(target)
    return 'available'
  } catch {
    return 'missing'
  }
}

/**
 * 从已枚举的 transcript 文件中按 session ID 唯一匹配。
 * 该函数只允许聚合扫描阶段调用；详情弹窗不得用它触发目录扫描。
 * @param {string} sessionId - canonical session ID
 * @param {string[]} filePaths - 聚合扫描已经枚举的文件
 * @returns {string|null}
 */
function findUniqueTranscriptBySessionId(sessionId, filePaths) {
  if (!sessionId || !Array.isArray(filePaths)) return null
  const matches = filePaths.filter((filePath) => {
    const base = path.basename(filePath)
    return base.includes(sessionId) || fallbackSessionIdFromPath(filePath) === sessionId
  })
  return matches.length === 1 ? matches[0] : null
}

module.exports = {
  getTranscriptRoot,
  toTranscriptRelativePath,
  fallbackSessionIdFromPath,
  resolveRelativeTranscriptPath,
  getInvocationSourceAvailability,
  findUniqueTranscriptBySessionId,
}
