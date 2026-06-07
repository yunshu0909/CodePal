/**
 * Codex 进程管理服务
 *
 * 负责：
 * - 通过 ps 识别 Codex.app 主进程、helper、app-server 及其子进程
 * - 优雅退出 Codex，并在超时后清理残留进程
 * - 重新打开 Codex.app，让 auth.json 切换真正生效
 *
 * @module electron/services/codexProcessService
 */

const childProcess = require('child_process')

// 进程检测与退出等待的默认超时
const PS_TIMEOUT_MS = 2000
const QUIT_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 250
const FORCE_KILL_GRACE_MS = 1500
const CODEX_CONTENTS_MARKER = '/Codex.app/Contents/'
const DIRECT_CODEX_TAIL_PATTERNS = [
  /^MacOS\/Codex(?:\s|$)/,
  /^Frameworks\/Codex Helper(?: \([^)]+\))?\.app\/Contents\/MacOS\/Codex Helper(?: \([^)]+\))?(?:\s|$)/,
  /^Resources\/codex app-server(?:\s|$)/,
]

// 可注入：测试中 mock，生产走原生
let _execFile = childProcess.execFile

/**
 * 用 execFile 调用系统命令
 * @param {string} cmd - 命令名
 * @param {string[]} args - 参数列表
 * @param {object} opts - execFile 选项
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function execFilePromise(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    _execFile(cmd, args, opts, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code ?? 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      })
    })
  })
}

/**
 * 等待指定毫秒数
 * @param {number} ms - 等待时间
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 解析 ps 输出
 * @param {string} stdout - `ps -axo pid=,ppid=,command=` 输出
 * @returns {{pid: number, ppid: number, command: string}[]}
 */
function parsePsOutput(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => {
      const matched = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
      if (!matched) return null
      return {
        pid: Number(matched[1]),
        ppid: Number(matched[2]),
        command: matched[3],
      }
    })
    .filter(Boolean)
}

/**
 * 提取 Codex.app/Contents 后的命令尾部
 * @param {string} command - 进程命令行
 * @returns {string}
 */
function getCodexContentsTail(command) {
  const markerIndex = command.indexOf(CODEX_CONTENTS_MARKER)
  if (markerIndex <= 0 || !command.startsWith('/')) return ''
  const appPathPrefix = command.slice(0, markerIndex)
  // 避免把 `/usr/bin/python /Applications/Codex.app/...` 或 `--target=/Applications/...` 误判为 Codex 进程。
  if (/\s\//.test(appPathPrefix) || /=\//.test(appPathPrefix)) return ''
  return command.slice(markerIndex + CODEX_CONTENTS_MARKER.length)
}

/**
 * 判断一条命令是否属于 Codex.app 自身
 * @param {string} command - 进程命令行
 * @returns {boolean}
 */
function isDirectCodexProcess(command) {
  if (!command || command.includes('chrome_crashpad_handler')) return false
  const tail = getCodexContentsTail(command)
  return DIRECT_CODEX_TAIL_PATTERNS.some((pattern) => pattern.test(tail))
}

/**
 * 给 Codex 进程分类，便于 UI 和日志解释
 * @param {string} command - 进程命令行
 * @returns {'desktop'|'app-server'|'helper'|'tool'|'child'}
 */
function classifyCodexProcess(command) {
  if (command.includes('Codex Helper')) return 'helper'
  if (command.includes('/Contents/Resources/codex app-server')) return 'app-server'
  if (command.includes('/Contents/MacOS/Codex')) return 'desktop'
  if (command.includes('/Contents/Resources/node')) return 'tool'
  return 'child'
}

/**
 * 从完整进程表中挑出 Codex 进程树
 *
 * 先识别命令本身来自 Codex.app 的直接进程，再把它们的子孙进程纳入。
 * 这样能覆盖 `codex app-server` 拉起的 MCP 子进程，避免它们继续持有旧账户环境。
 *
 * @param {{pid: number, ppid: number, command: string}[]} rows - 全量进程表
 * @returns {{pid: number, ppid: number, command: string, role: string}[]}
 */
function selectCodexProcessTree(rows) {
  const byParent = new Map()
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row)
  }

  const selected = new Map()
  const queue = []
  for (const row of rows) {
    if (isDirectCodexProcess(row.command)) {
      selected.set(row.pid, row)
      queue.push(row)
    }
  }

  while (queue.length > 0) {
    const parent = queue.shift()
    for (const child of byParent.get(parent.pid) || []) {
      if (selected.has(child.pid)) continue
      selected.set(child.pid, child)
      queue.push(child)
    }
  }

  return Array.from(selected.values())
    .map((row) => ({ ...row, role: classifyCodexProcess(row.command) }))
    .sort((a, b) => a.pid - b.pid)
}

/**
 * 列出当前 Codex 进程树
 * @returns {Promise<{success: boolean, processes: Array, error?: string}>}
 */
async function listCodexProcesses() {
  const result = await execFilePromise(
    'ps',
    ['-axo', 'pid=,ppid=,command='],
    { timeout: PS_TIMEOUT_MS }
  )
  if (result.code !== 0) {
    return {
      success: false,
      processes: [],
      error: result.stderr || 'ps failed',
    }
  }
  return {
    success: true,
    processes: selectCodexProcessTree(parsePsOutput(result.stdout)),
  }
}

/**
 * 检测 Codex 是否仍有有效运行态
 * @returns {Promise<boolean>}
 */
async function isCodexRunning() {
  const result = await listCodexProcesses()
  return result.success && result.processes.length > 0
}

/**
 * 等待 Codex 进程树退出
 * @param {number} timeoutMs - 最大等待时间
 * @param {number} pollIntervalMs - 轮询间隔
 * @returns {Promise<{exited: boolean, processes: Array, error?: string}>}
 */
async function waitForCodexExit(timeoutMs = QUIT_TIMEOUT_MS, pollIntervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs
  let latest = { success: true, processes: [] }
  while (Date.now() <= deadline) {
    latest = await listCodexProcesses()
    if (!latest.success || latest.processes.length === 0) {
      if (!latest.success) {
        return { exited: false, processes: [], error: latest.error || 'ps failed while waiting' }
      }
      return { exited: true, processes: [] }
    }
    await delay(pollIntervalMs)
  }
  return { exited: false, processes: latest.processes || [] }
}

/**
 * 终止指定进程列表
 * @param {Array<{pid: number}>} processes - 要终止的进程
 * @param {'TERM'|'KILL'} signal - kill 信号
 * @returns {Promise<void>}
 */
async function killProcesses(processes, signal) {
  const pids = Array.from(new Set(processes.map((p) => p.pid).filter(Boolean)))
  if (pids.length === 0) return
  // 先收较新的叶子进程，减少 app-server 继续拉起 tool 的窗口期。
  pids.sort((a, b) => b - a)
  await execFilePromise('kill', [`-${signal}`, ...pids.map(String)], { timeout: 2000 })
}

/**
 * 完整退出 Codex.app
 *
 * 执行步骤：
 * 1. 读取当前 Codex 进程树
 * 2. 先用 AppleScript 优雅退出
 * 3. 超时后用 SIGTERM / SIGKILL 收尾
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000] - 优雅退出等待时间
 * @param {boolean} [options.force=true] - 是否强制清理残留进程
 * @returns {Promise<{success: boolean, wasRunning: boolean, stoppedCount: number, remaining: Array, error?: string}>}
 */
async function quitCodex(options = {}) {
  const { timeoutMs = QUIT_TIMEOUT_MS, force = true } = options
  const before = await listCodexProcesses()
  if (!before.success) {
    return { success: false, wasRunning: false, stoppedCount: 0, remaining: [], error: before.error }
  }
  if (before.processes.length === 0) {
    return { success: true, wasRunning: false, stoppedCount: 0, remaining: [] }
  }

  await execFilePromise(
    'osascript',
    ['-e', 'tell application id "com.openai.codex" to quit'],
    { timeout: 3000 }
  )

  let waitResult = await waitForCodexExit(timeoutMs)
  if (!waitResult.exited && force) {
    // 优雅退出失败时才终止残留进程，避免正在运行的 app-server 用旧账号覆盖 auth.json。
    await killProcesses(waitResult.processes, 'TERM')
    await delay(FORCE_KILL_GRACE_MS)
    waitResult = await waitForCodexExit(Math.max(timeoutMs, POLL_INTERVAL_MS), POLL_INTERVAL_MS)
    if (!waitResult.exited) {
      await killProcesses(waitResult.processes, 'KILL')
      waitResult = await waitForCodexExit(Math.max(timeoutMs, POLL_INTERVAL_MS), POLL_INTERVAL_MS)
    }
  }

  return {
    success: waitResult.exited,
    wasRunning: true,
    stoppedCount: before.processes.length,
    remaining: waitResult.processes,
    error: waitResult.exited ? undefined : (waitResult.error || 'CODEX_PROCESSES_STILL_RUNNING'),
  }
}

/**
 * 打开 Codex.app
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function openCodex() {
  const { code, stderr } = await execFilePromise('open', ['-a', 'Codex'], { timeout: 3000 })
  return { success: code === 0, error: code !== 0 ? stderr : undefined }
}

/**
 * 重启 Codex.app
 * @param {object} [options]
 * @returns {Promise<{success: boolean, wasRunning: boolean, stoppedCount: number, remaining: Array, error?: string}>}
 */
async function restartCodex(options = {}) {
  const quitResult = await quitCodex(options)
  if (!quitResult.success) return quitResult
  const openResult = await openCodex()
  return {
    ...quitResult,
    success: openResult.success,
    error: openResult.success ? undefined : openResult.error,
  }
}

module.exports = {
  listCodexProcesses,
  isCodexRunning,
  quitCodex,
  openCodex,
  restartCodex,
  __INTERNAL__: {
    PS_TIMEOUT_MS,
    QUIT_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    parsePsOutput,
    selectCodexProcessTree,
    isDirectCodexProcess,
    classifyCodexProcess,
    __setExecFile(fn) { _execFile = fn },
    __resetExecFile() { _execFile = childProcess.execFile },
  },
}
