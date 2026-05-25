/**
 * Codex CLI 进程启动器（V1.7）
 *
 * 负责：
 * - spawn codex CLI 时把激活账号的 home 目录作为 CODEX_HOME 注入
 * - spawn 前 fs.statSync 验证目录存在（调研 1 警告：CODEX_HOME 必须是已存在的绝对路径）
 * - active.json 不存在或 currentAccount 为空时拒绝启动
 *
 * 服务边界（PRD §1.1）：
 * - 仅当用户通过 CodePal 启动 codex 时生效；终端直接 codex / Codex.app / IDE 启动不接管
 *
 * 依据：
 * - 设计稿 §2.1 spawnCodex 实现
 * - PRD US-04 价值陈述与异常处理
 *
 * @module electron/services/codexProcessLauncher
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')

const accountService = require('./codexAccountService')

// V1.7 P1-6：错误码细分——UI 需要给"从未激活"和"激活已失效"不同文案
class ActiveAccountMissingError extends Error {
  constructor() { super('NO_ACTIVE_ACCOUNT'); this.code = 'NO_ACTIVE_ACCOUNT' }
}
// active.json 不存在（全新用户 / 未迁移）
class NoActiveAccountConfiguredError extends ActiveAccountMissingError {
  constructor() { super(); this.code = 'NO_ACTIVE_ACCOUNT_CONFIGURED' }
}
// active.json 存在但 currentAccount=null/空（用户删了最后一个账号 / 迁移未识别 active）
class ActiveAccountClearedError extends ActiveAccountMissingError {
  constructor() { super(); this.code = 'ACTIVE_ACCOUNT_CLEARED' }
}
class ActiveAccountDirCorruptError extends Error {
  constructor(accountName) {
    super(`ACTIVE_ACCOUNT_DIR_CORRUPT:${accountName}`)
    this.code = 'ACTIVE_ACCOUNT_DIR_CORRUPT'
    this.accountName = accountName
  }
}

/**
 * 读 active.json 状态
 * @returns {Promise<{ exists: boolean, currentAccount: string | null }>}
 */
async function readActiveAccountState() {
  const I = accountService.__INTERNAL__
  const activePath = I.getActiveJsonFile()
  if (!fs.existsSync(activePath)) return { exists: false, currentAccount: null }
  try {
    const data = JSON.parse(await fsp.readFile(activePath, 'utf8'))
    if (data && typeof data.currentAccount === 'string' && data.currentAccount.length > 0) {
      return { exists: true, currentAccount: data.currentAccount }
    }
    return { exists: true, currentAccount: null }
  } catch {
    return { exists: false, currentAccount: null }
  }
}

/**
 * 旧 API：只返回 currentAccount string 或 null，向后兼容已写就的测试
 */
async function readActiveAccount() {
  const st = await readActiveAccountState()
  return st.currentAccount
}

/**
 * 解析 CODEX_HOME 路径（不 spawn，可独立校验）
 *
 * @returns {Promise<{ ok: true, codexHome: string, accountName: string }>}
 * @throws {NoActiveAccountConfiguredError | ActiveAccountClearedError | ActiveAccountDirCorruptError}
 */
async function resolveCodexHome() {
  const I = accountService.__INTERNAL__
  const state = await readActiveAccountState()
  // V1.7 P1-6：细分三类错误，UI 可以给三种文案
  if (!state.exists) throw new NoActiveAccountConfiguredError()
  if (!state.currentAccount) throw new ActiveAccountClearedError()
  const active = state.currentAccount
  const home = I.getAccountHomeDir(active)
  try {
    const st = fs.statSync(home)
    if (!st.isDirectory()) throw new ActiveAccountDirCorruptError(active)
  } catch {
    throw new ActiveAccountDirCorruptError(active)
  }
  // auth.json 也必须存在（CODEX_HOME 完整性的最低要求）
  if (!fs.existsSync(path.join(home, 'auth.json'))) {
    throw new ActiveAccountDirCorruptError(active)
  }
  return { ok: true, codexHome: home, accountName: active }
}

/**
 * spawn codex 子进程 + 注入 CODEX_HOME
 *
 * @param {string[]} args - codex CLI 参数
 * @param {{
 *   stdio?: 'ignore' | 'inherit' | 'pipe',
 *   cwd?: string,
 *   extraEnv?: Record<string, string>,
 *   spawn?: typeof spawn,   // 测试注入
 * }} [opts]
 * @returns {Promise<{
 *   child: import('node:child_process').ChildProcess,
 *   codexHome: string,
 *   accountName: string
 * }>}
 */
async function spawnCodex(args = [], opts = {}) {
  const { codexHome, accountName } = await resolveCodexHome()
  const spawnFn = opts.spawn ?? spawn
  // V1.7 日志补全：spawn codex 是用户最关心的"启动 Codex"路径，需要可追溯
  console.log(`[codex-launcher] spawn account=${accountName} CODEX_HOME=${codexHome} args=${JSON.stringify(args)}`)
  const child = spawnFn('codex', args, {
    env: { ...process.env, ...(opts.extraEnv ?? {}), CODEX_HOME: codexHome },
    stdio: opts.stdio ?? 'inherit',
    cwd: opts.cwd,
  })
  child.on?.('exit', (code) => {
    console.log(`[codex-launcher] exit account=${accountName} code=${code}`)
  })
  return { child, codexHome, accountName }
}

/**
 * spawn 并等待退出，返回 stdout/code（用于 codex --version 等一次性命令）
 *
 * @param {string[]} args
 * @param {{ extraEnv?: object, spawn?: typeof spawn, captureStdout?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, accountName: string, codexHome: string }>}
 */
async function spawnCodexAwait(args, opts = {}) {
  const { codexHome, accountName } = await resolveCodexHome()
  const spawnFn = opts.spawn ?? spawn
  return new Promise((resolve, reject) => {
    const child = spawnFn('codex', args, {
      env: { ...process.env, ...(opts.extraEnv ?? {}), CODEX_HOME: codexHome },
      stdio: ['ignore', opts.captureStdout === false ? 'ignore' : 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => { if (settled) return; settled = true; resolve(result) }
    const fail = (err) => { if (settled) return; settled = true; reject(err) }
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', fail)
    child.on('close', (code) => finish({ code, stdout, stderr, accountName, codexHome }))
    if (opts.timeoutMs) {
      setTimeout(() => {
        if (settled) return
        try { child.kill('SIGKILL') } catch {}
        fail(new Error(`codex spawn timeout (>${opts.timeoutMs}ms)`))
      }, opts.timeoutMs).unref?.()
    }
  })
}

/**
 * 在新终端窗口里打开 codex（注入 CODEX_HOME）
 *
 * 用于"启动 Codex"按钮——用户需要一个可交互的 codex 界面，
 * spawn + stdio:'ignore' 会让用户感受为"按钮无反应"。
 *
 * 平台行为：
 * - macOS：osascript 让 Terminal.app 新建窗口跑 `CODEX_HOME=... codex <args>`，跑完后 exec $SHELL 保持窗口开着
 * - Linux：探测常见终端模拟器（gnome-terminal / konsole / xterm）；找不到则 fallback 到 spawn detached
 * - Windows：spawn detached cmd 启动新窗口
 *
 * @param {string[]} args
 * @param {{ execFile?: typeof execFile }} [opts]
 * @returns {Promise<{ ok: true, accountName: string, codexHome: string, platform: string, opener: string }>}
 */
async function launchCodexInTerminal(args = [], opts = {}) {
  const { codexHome, accountName } = await resolveCodexHome()
  const execFn = opts.execFile ?? execFile
  const platform = process.platform

  console.log(`[codex-launcher] terminal-launch account=${accountName} CODEX_HOME=${codexHome} args=${JSON.stringify(args)} platform=${platform}`)

  if (platform === 'darwin') {
    return new Promise((resolve, reject) => {
      // shell-escape：codexHome 路径含特殊字符时单引号包裹 + 内单引号转义
      const escapeForSh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
      const argStr = args.map(escapeForSh).join(' ')
      // 用 cd 到当前 cwd（让 codex 看到用户期望的工作目录），然后注入 CODEX_HOME
      // exec $SHELL 让窗口跑完 codex 后不立即关闭
      const cwd = process.env.HOME || ''
      const script = `do script "cd ${escapeForSh(cwd)}; export CODEX_HOME=${escapeForSh(codexHome)}; codex ${argStr}; exec $SHELL"`
      // activate 让 Terminal.app 自动到前台
      const fullScript = `tell application "Terminal" to ${script}\ntell application "Terminal" to activate`
      execFn('osascript', ['-e', fullScript], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          console.warn(`[codex-launcher] osascript failed: ${err.message} stderr=${stderr}`)
          reject(new Error(`osascript failed: ${err.message}`))
          return
        }
        resolve({ ok: true, accountName, codexHome, platform, opener: 'Terminal.app' })
      })
    })
  }

  if (platform === 'linux') {
    const candidates = [
      ['gnome-terminal', ['--', 'bash', '-c']],
      ['konsole', ['-e', 'bash', '-c']],
      ['xterm', ['-e', 'bash', '-c']],
    ]
    for (const [bin, prefix] of candidates) {
      try {
        const env = { ...process.env, CODEX_HOME: codexHome }
        const argStr = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
        const cmdString = `codex ${argStr}; exec bash`
        const child = spawn(bin, [...prefix, cmdString], { env, detached: true, stdio: 'ignore' })
        child.unref()
        return { ok: true, accountName, codexHome, platform, opener: bin }
      } catch { /* try next */ }
    }
    throw new Error('no usable terminal emulator found (tried gnome-terminal/konsole/xterm)')
  }

  if (platform === 'win32') {
    const env = { ...process.env, CODEX_HOME: codexHome }
    const argStr = args.join(' ')
    const child = spawn('cmd', ['/c', 'start', 'cmd', '/k', `codex ${argStr}`], { env, detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, accountName, codexHome, platform, opener: 'cmd' }
  }

  throw new Error(`unsupported platform: ${platform}`)
}

module.exports = {
  spawnCodex,
  spawnCodexAwait,
  launchCodexInTerminal,
  resolveCodexHome,
  readActiveAccount,
  readActiveAccountState,
  ActiveAccountMissingError,
  NoActiveAccountConfiguredError,
  ActiveAccountClearedError,
  ActiveAccountDirCorruptError,
}
