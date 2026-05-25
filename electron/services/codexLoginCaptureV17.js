/**
 * V1.7 新账号登录闭环（US-02 业务规则）
 *
 * 流程：
 *   1. 用户点"新增账号" → 调 beginLogin()
 *   2. 创建 accounts/anon-<ts>/.codex/ 目录（5 个 symlinks，不含 auth.json）
 *   3. spawn codex 注入 CODEX_HOME=anon-<ts>，让用户在 codex CLI 内 OAuth 登录
 *   4. chokidar 监听 anon-<ts>/.codex/auth.json 出现
 *   5. 出现后 emit 'auth-captured' 事件，等用户输入账户名
 *   6. 用户输入 → 调 finalizeLogin(name)
 *   7. atomic rename anon-<ts> → name；可选暖 .system；更新 active.json
 *
 * 异常：
 *   - 5 分钟内 auth.json 未出现 → 自动清理 anon → emit 'login-timeout'
 *   - codex 子进程崩溃 → 同上
 *   - finalizeLogin 时名字非法/重复 → 不动 anon、提示重输
 *
 * @module electron/services/codexLoginCaptureV17
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const accountService = require('./codexAccountService')
const codexAccountBuilder = require('./codexAccountBuilder')
const codexProcessLauncher = require('./codexProcessLauncher')

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

class CodexLoginCaptureV17 extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.logger = opts.logger ?? console
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
    this.now = opts.now ?? (() => Date.now())
    // 测试注入：替换 chokidar 监听（不依赖 chokidar）
    this.watchFn = opts.watchFn ?? null
    // 测试注入：替换 spawn codex
    this.spawnFn = opts.spawnFn ?? null
    this._sessions = new Map() // sessionId → { anonName, watcher, timer, child, codexHome, captured }
  }

  /**
   * 开始新账号登录
   * V1.7 P1-6 修复：同时只允许一个 inflight 登录会话（避免连点产生多个 anon-* 残留 + 多个 codex 子进程）
   *
   * @returns {Promise<{ ok?: boolean, code?: string, sessionId?: string, anonName?: string, codexHome?: string }>}
   */
  async beginLogin() {
    // 已有 inflight session → 拒绝
    if (this._sessions.size > 0) {
      const existing = this._sessions.keys().next().value
      this.logger.warn?.(`[login-capture] begin-rejected reason=in-progress existingSession=${existing}`)
      return { ok: false, code: 'LOGIN_IN_PROGRESS', existingSessionId: existing }
    }
    const sessionId = `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const anonName = `anon-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    this.logger.info?.(`[login-capture] begin session=${sessionId} anonName=${anonName}`)

    // 创建 anon 目录 + symlinks（不暖 .system，因为 auth 还没就位）
    const built = await codexAccountBuilder.buildAccountDir(anonName, {
      auth: { tokens: {}, last_refresh: null }, // 占位 auth；spawn login 后会被 codex 覆盖
    })
    const codexHome = built.dir
    const authPath = path.join(codexHome, 'auth.json')

    // V1.7 P0-3 修复：删占位 → 启动 watcher（让 watcher 触发时读 auth 内容验真伪）
    // 删占位放前面：chokidar `ignoreInitial: false` 启动扫描时若文件不存在就不会误 emit add
    try { await fsp.unlink(authPath) } catch {}
    // 启动 chokidar 监听 + 含内容校验（_onAuthCaptured 内只在 tokens 非空时 emit）
    const watcher = this._installWatcher(authPath, sessionId)

    // 启动 codex login 子进程
    const child = await this._spawnCodexLogin(codexHome, sessionId)

    // 5 分钟超时
    const timer = setTimeout(() => {
      this.logger.warn?.(`[login-capture] login ${sessionId} timed out`)
      this._abortSession(sessionId, 'login-timeout')
    }, this.timeoutMs)

    this._sessions.set(sessionId, { anonName, watcher, timer, child, codexHome, captured: false })
    return { ok: true, sessionId, anonName, codexHome }
  }

  /**
   * 用户确认账号名 → atomic rename anon-* → name
   *
   * @param {string} sessionId
   * @param {string} desiredName
   * @returns {Promise<
   *   | { ok: true, name: string, dir: string }
   *   | { ok: false, code: 'INVALID_SESSION' | 'INVALID_NAME' | 'NAME_EXISTS' | 'AUTH_MISSING' | 'RENAME_FAILED', error?: string }
   * >}
   */
  async finalizeLogin(sessionId, desiredName) {
    this.logger.info?.(`[login-capture] finalize-begin session=${sessionId} desiredName=${desiredName}`)
    const session = this._sessions.get(sessionId)
    if (!session) {
      this.logger.warn?.(`[login-capture] finalize-invalid-session session=${sessionId}`)
      return { ok: false, code: 'INVALID_SESSION' }
    }

    const I = accountService.__INTERNAL__
    const SAFE_NAME_REGEX = I.SAFE_NAME_REGEX
    if (typeof desiredName !== 'string' || !SAFE_NAME_REGEX.test(desiredName)) {
      this.logger.warn?.(`[login-capture] finalize-invalid-name session=${sessionId} name=${desiredName}`)
      return { ok: false, code: 'INVALID_NAME' }
    }

    // 检查同名是否已存在（含 anon-* 但不含本次 session）
    const targetHome = I.getAccountHomeDir(desiredName)
    if (fs.existsSync(targetHome)) {
      this.logger.warn?.(`[login-capture] finalize-name-exists session=${sessionId} name=${desiredName}`)
      return { ok: false, code: 'NAME_EXISTS' }
    }

    // 检查 auth.json 已就位
    const anonHome = I.getAccountHomeDir(session.anonName)
    const authPath = path.join(anonHome, 'auth.json')
    if (!fs.existsSync(authPath)) {
      this.logger.warn?.(`[login-capture] finalize-auth-missing session=${sessionId} anonName=${session.anonName}`)
      return { ok: false, code: 'AUTH_MISSING' }
    }

    // atomic rename
    const anonAccountDir = path.dirname(anonHome) // accounts/anon-xxx/
    const targetAccountDir = path.dirname(targetHome) // accounts/desiredName/
    try {
      await fsp.rename(anonAccountDir, targetAccountDir)
    } catch (err) {
      this.logger.warn?.(`[login-capture] finalize-rename-failed session=${sessionId} message=${err?.message}`)
      return { ok: false, code: 'RENAME_FAILED', error: err.message }
    }

    // V1.7 P0-4 修复：await 暖 .system 完成再设 active——避免与用户立即"启动 Codex"撞 install_system_skills
    // 但留 best-effort（warm 失败不阻塞 active 切换；spawn timeout 兜底 10s）
    try {
      await codexAccountBuilder.warmAccountSystem(desiredName, { timeoutMs: 10000, logger: this.logger })
    } catch (err) {
      this.logger.warn?.(`[login-capture] warm .system after finalize failed (continuing): ${err.message}`)
    }

    // 设为 active
    await accountService.writeActiveJsonV17({ currentAccount: desiredName })

    // 清理 session
    this._cleanupSession(sessionId, /* preserveDir= */ true)

    this.logger.info?.(`[login-capture] finalize-done session=${sessionId} name=${desiredName}`)
    this.emit('login-finalized', { sessionId, name: desiredName })
    return { ok: true, name: desiredName, dir: targetHome }
  }

  /**
   * 用户主动取消登录（关闭弹层等）
   */
  async cancelLogin(sessionId) {
    this.logger.info?.(`[login-capture] cancel session=${sessionId}`)
    return this._abortSession(sessionId, 'user-cancelled')
  }

  // ---------- 内部 ----------

  async _spawnCodexLogin(codexHome, sessionId) {
    // 直接通过 launcher 启动（含 CODEX_HOME 注入）
    // 但 launcher 默认走 active.json，这里需要绕过——直接 spawn 并传 codexHome
    const spawnFn = this.spawnFn ?? require('node:child_process').spawn
    const child = spawnFn('codex', ['login'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: 'ignore',
      detached: false,
    })
    child.on?.('exit', (code) => {
      const session = this._sessions.get(sessionId)
      if (!session) return
      this.logger.info?.(`[login-capture] codex login exit ${code} (session=${sessionId})`)
      // V1.7 P1-7 修复：子进程退出但 auth.json 还没被 watcher 捕获 → 用户 Ctrl+C 或 OAuth 取消，立刻清理
      // 不等 5 分钟超时
      if (!session.captured && code !== 0) {
        this._abortSession(sessionId, 'codex-exited-without-auth')
      }
    })
    child.on?.('error', (err) => {
      this.logger.warn?.(`[login-capture] codex login spawn error: ${err.message}`)
      this._abortSession(sessionId, 'spawn-error', err.message)
    })
    return child
  }

  _installWatcher(authPath, sessionId) {
    if (this.watchFn) {
      // 测试注入路径
      return this.watchFn(authPath, () => this._onAuthCaptured(sessionId, authPath))
    }
    // 默认走 chokidar；如果没装也降级为 fs.watch
    let chokidar
    try { chokidar = require('chokidar') } catch { chokidar = null }
    if (chokidar) {
      const watcher = chokidar.watch(authPath, { ignoreInitial: false, persistent: true })
      watcher.on('add', () => this._onAuthCaptured(sessionId, authPath))
      return watcher
    }
    // fallback：fs.watch on parent dir
    const dir = path.dirname(authPath)
    const watcher = fs.watch(dir, (event, filename) => {
      if (filename === 'auth.json' && fs.existsSync(authPath)) {
        this._onAuthCaptured(sessionId, authPath)
      }
    })
    return watcher
  }

  _onAuthCaptured(sessionId, authPath) {
    const session = this._sessions.get(sessionId)
    if (!session || session.captured) return
    // V1.7 P0-3 进一步保险：验 auth.json 真的含 access_token（非占位/半写入）才认为捕获
    // 读盘失败/字段缺失 → 等待下次事件（chokidar 会持续监听 add/change）
    try {
      const buf = fs.readFileSync(authPath, 'utf8')
      const data = JSON.parse(buf)
      if (!data?.tokens?.access_token) {
        this.logger.info?.(`[login-capture] ${sessionId} auth.json appeared but tokens incomplete, keep waiting`)
        return
      }
    } catch {
      // 读不到 / parse 失败 → 还在写入过程中，等下一次事件
      return
    }
    session.captured = true
    this.logger.info?.(`[login-capture] auth captured for ${sessionId}`)
    this.emit('auth-captured', { sessionId, anonName: session.anonName, authPath })
  }

  async _abortSession(sessionId, reason, errorMsg) {
    const session = this._sessions.get(sessionId)
    if (!session) return { ok: false, code: 'INVALID_SESSION' }
    this.logger.info?.(`[login-capture] abort session=${sessionId} reason=${reason}${errorMsg ? ` error=${errorMsg}` : ''}`)
    this._cleanupSession(sessionId, /* preserveDir= */ false)
    this.emit('login-aborted', { sessionId, reason, error: errorMsg })
    return { ok: true, reason }
  }

  _cleanupSession(sessionId, preserveDir) {
    const session = this._sessions.get(sessionId)
    if (!session) return
    if (session.timer) clearTimeout(session.timer)
    if (session.watcher) {
      if (typeof session.watcher.close === 'function') {
        Promise.resolve(session.watcher.close()).catch(() => {})
      } else if (typeof session.watcher.close === 'undefined' && typeof session.watcher.removeAllListeners === 'function') {
        session.watcher.removeAllListeners()
      }
    }
    if (session.child && typeof session.child.kill === 'function') {
      try { session.child.kill('SIGTERM') } catch {}
    }
    if (!preserveDir) {
      const I = accountService.__INTERNAL__
      const home = I.getAccountHomeDir(session.anonName)
      const accountDir = path.dirname(home)
      fsp.rm(accountDir, { recursive: true, force: true }).catch(() => {})
    }
    this._sessions.delete(sessionId)
  }
}

module.exports = {
  CodexLoginCaptureV17,
  DEFAULT_LOGIN_TIMEOUT_MS,
}
