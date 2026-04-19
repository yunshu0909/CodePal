/**
 * Session Resume 服务
 *
 * 负责：
 * - 读取 session JSONL 首 N 行，提取 cwd 字段
 * - 检测 cwd 目录是否仍存在于文件系统
 * - 通过 osascript 启动 macOS Terminal.app 自动执行 claude --resume
 *
 * @module electron/services/sessionResumeService
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const readline = require('readline')
const childProcess = require('child_process')

// 允许测试注入；生产中使用真实 execFile
let _execFile = childProcess.execFile

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

// 扫 JSONL 前 N 行找 cwd；已知 Claude Code session 格式里 cwd 最晚在第 3 行，20 行是安全冗余
const MAX_LINES_TO_SCAN = 20

// osascript 执行超时（毫秒）
const OSASCRIPT_TIMEOUT_MS = 5000

// UUID 格式（标准 Claude Code session 文件名）
const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

// 安全目录名（projectId）正则：仅允许字母数字下划线连字符
const SAFE_DIR_REGEX = /^[a-zA-Z0-9_-]+$/

/**
 * 扫 session JSONL 前 N 行，提取 cwd 字段
 *
 * 执行步骤：
 *   1. 校验 projectId / sessionId 合法，构造 jsonlPath
 *   2. 逐行读文件，最多读 MAX_LINES_TO_SCAN 行
 *   3. 解析每行 JSON，找到第一个非空的 cwd 字段即返回
 *   4. 用 fs.existsSync 检测 cwd 目录是否存在
 *
 * @param {string} projectId - 编码后的项目目录名
 * @param {string} sessionId - session UUID
 * @returns {Promise<{cwd: string|null, cwdExists: boolean}>}
 *   cwd=null 表示前 20 行都没找到 cwd 字段（session 损坏或格式非标准）
 */
async function readSessionCwd(projectId, sessionId) {
  if (!SAFE_DIR_REGEX.test(projectId) || !SAFE_DIR_REGEX.test(sessionId)) {
    throw new Error('INVALID_ID')
  }

  const jsonlPath = path.join(CLAUDE_PROJECTS_DIR, projectId, `${sessionId}.jsonl`)

  // 预检：文件不存在则直接抛错给上层
  try {
    await fsp.access(jsonlPath, fs.constants.R_OK)
  } catch {
    throw new Error('SESSION_FILE_NOT_FOUND')
  }

  let found = null
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream })
  let count = 0

  for await (const line of rl) {
    count++
    if (count > MAX_LINES_TO_SCAN) break
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj.cwd === 'string' && obj.cwd.length > 0) {
        found = obj.cwd
        break
      }
    } catch {
      // 容忍单行损坏，继续下一行
    }
  }

  rl.close()
  stream.destroy()

  if (!found) {
    return { cwd: null, cwdExists: false }
  }

  const cwdExists = fs.existsSync(found)
  return { cwd: found, cwdExists }
}

/**
 * 转义 shell 单引号字符串里的单引号
 * 策略：将 ' 替换为 '\''，即 close-quote + escaped-quote + open-quote
 * @param {string} s
 * @returns {string}
 */
function escapeSingleQuote(s) {
  return String(s).replace(/'/g, "'\\''")
}

/**
 * 转义 AppleScript 字符串里的特殊字符
 * do script 参数是双引号包裹的字符串，需转义内部的 " 和 \
 * @param {string} s
 * @returns {string}
 */
function escapeAppleScriptString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 在新 Terminal 窗口执行 cd + claude --resume
 *
 * 执行步骤：
 *   1. 校验 uuid 合法（防御性，上层也会验）
 *   2. 构造 shell 命令：cd '<cwd>' && claude --resume <uuid>
 *   3. 构造 AppleScript：tell Terminal / activate / do script "..." / end tell
 *   4. execFile 调 osascript（不走 shell）避免注入
 *
 * @param {string} cwd - 原 session 工作目录（上层已保证非空，存在性上层检测过）
 * @param {string} uuid - session UUID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function launchInNewTerminal(cwd, uuid) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { success: false, error: 'EMPTY_CWD' }
  }
  if (!UUID_REGEX.test(uuid)) {
    return { success: false, error: 'INVALID_UUID' }
  }

  // 1. shell 命令：单引号包 cwd，内部单引号做 '\'' 转义
  const shellCmd = `cd '${escapeSingleQuote(cwd)}' && claude --resume ${uuid}`

  // 2. AppleScript 的 do script 参数：转义 \ 和 "
  const appleArg = escapeAppleScriptString(shellCmd)

  // 3. execFile 不起 shell，每个 -e 参数原样传给 osascript
  const args = [
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', `do script "${appleArg}"`,
    '-e', 'end tell',
  ]

  return new Promise((resolve) => {
    _execFile('osascript', args, { timeout: OSASCRIPT_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) {
        const msg = (stderr && stderr.trim()) || err.message || 'OSASCRIPT_FAILED'
        resolve({ success: false, error: msg })
      } else {
        resolve({ success: true })
      }
    })
  })
}

module.exports = {
  readSessionCwd,
  launchInNewTerminal,
  // 供测试注入与参数化
  __INTERNAL__: {
    MAX_LINES_TO_SCAN,
    OSASCRIPT_TIMEOUT_MS,
    escapeSingleQuote,
    escapeAppleScriptString,
    CLAUDE_PROJECTS_DIR,
    __setExecFile(fn) { _execFile = fn },
    __resetExecFile() { _execFile = childProcess.execFile },
  },
}
