/**
 * Codex Token 主动续签服务（V1.7）
 *
 * V1.6 → V1.7 主要变化：
 * - 接受 accountName 参数（不再用 filePath / live ~/.codex/auth.json）
 * - 返回结构含 classification（Permanent/Transient）+ reason（4+1 类）
 * - Transient 失败：1s/2s/4s 三次退避（不再是 1× 1s 重试）
 * - 失败 3 次后写 state.json paused（不再是隐式失败）
 * - Permanent 失败：写 state.json invalid + permanentReason
 * - pendingTokenCache：atomic write 失败时把新 refresh_token 留内存，下次刷新时优先用
 * - mtime 防撞车：sweep 时若文件 < 60s 内被修改则跳过
 * - sweepAllSlotsV17 跳过 active 账号（基于 active.json.currentAccount）
 *
 * 接口契约（PRD US-06 业务规则）：
 *   ensureFreshCodexTokenV17({ accountName, force })
 *     → { ok: true, refreshed?: boolean }
 *     → { ok: false, classification: 'Permanent', reason: 'Expired'|'Exhausted'|'Revoked'|'Other' }
 *     → { ok: false, classification: 'Transient', reason: 'ServerError'|'Network', retries: 3 }
 *
 * 依据：
 * - 设计稿 §4 保活调度、§5 错误分类、§6 refresh_token rotation 防护
 * - PRD US-05 / US-06 / US-07
 *
 * @module electron/services/codexTokenRefresherV17
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const accountService = require('./codexAccountService')
const { decodeJwtPayload } = require('./codexJwtUtils')
const { classify } = require('./codexErrorClassifier')

// ---------- 常量 ----------

const TOKEN_URL = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE
  || 'https://auth.openai.com/oauth/token'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OAUTH_SCOPE = 'openid profile email offline_access'
const REQUEST_TIMEOUT_MS = 30_000

// Transient 重试退避（设计稿 §5.1 + K2）
const TRANSIENT_BACKOFFS_MS = [1000, 2000, 4000]

// sweep 时 mtime 防撞车窗口（设计稿 §4.4）
const MTIME_GUARD_MS = 60_000

// 单账号 24h 内 force refresh 最多 3 次（设计稿 §4.4 + US-05 异常）
const MAX_FORCE_PER_24H = 3
const FORCE_WINDOW_MS = 24 * 3600 * 1000

// ---------- 模块状态 ----------

let _userAgent = 'CodePal/v1.7 (+codex-token-refresher)'
let _fetch = typeof fetch === 'function' ? fetch : null
let _now = () => Date.now()

// 同账号并发去重：key=accountName（不再含 force 维度）
//
// 原因（V1.7 P0-2 修复）：若 inflight key 含 force 维度，force=true 已在用旧 refresh_token
// 调 OpenAI，非 force 调用进来 inflight 不命中、又用同一旧 refresh_token 发请求；
// OpenAI 收到第二次相同 refresh_token → 返 refresh_token_reused → Permanent.Exhausted →
// 活账号被错误写成 invalid。所以并发刷必须串行到 per-name。
//
// 副作用：用户点"强制刷"时如有非 force sweep 在跑，会复用 sweep 的结果而非真正 force——
// 这是可接受的代价；若 force 结果确需独立，调用方先等 inflight.get(name) 后再发 force。
const inflight = new Map()

// 写盘失败兜底：accountName → 新 tokens（含 refresh_token）
const pendingTokenCache = new Map()

// 单账号 24h 内 force refresh 次数累计（time -> count）
const forceHistory = new Map()  // accountName → Array<number(timestamp)>

// ---------- 配置注入 ----------

function setUserAgent(version) {
  _userAgent = `CodePal/${version} (+codex-token-refresher)`
}

function __setFetch(fn) { _fetch = fn }
function __resetFetch() { _fetch = typeof fetch === 'function' ? fetch : null }
function __setNow(fn) { _now = fn }
function __resetNow() { _now = () => Date.now() }
function __clearCaches() {
  inflight.clear()
  pendingTokenCache.clear()
  forceHistory.clear()
}

// ---------- 内部工具 ----------

async function atomicWriteJson(filePath, obj) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, filePath)
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

function get24hForceCount(accountName, now) {
  const arr = forceHistory.get(accountName) ?? []
  const window = now - FORCE_WINDOW_MS
  const recent = arr.filter((t) => t >= window)
  forceHistory.set(accountName, recent)
  return recent.length
}

function record24hForce(accountName, now) {
  const arr = forceHistory.get(accountName) ?? []
  arr.push(now)
  forceHistory.set(accountName, arr.filter((t) => t >= now - FORCE_WINDOW_MS))
}

/**
 * 调 OpenAI refresh endpoint（单次，不重试）
 *
 * @param {string} refreshToken
 * @returns {Promise<{ httpStatus: number, body: string, data: object | null, networkError?: string }>}
 */
async function callRefreshEndpoint(refreshToken) {
  if (!_fetch) throw new Error('fetch is not available (Node 18+ required)')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const resp = await _fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': _userAgent,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: OAUTH_SCOPE,
      }),
      signal: ctrl.signal,
    })
    const text = await resp.text()
    let data = null
    if (resp.ok) {
      try { data = JSON.parse(text) } catch { /* server returned non-JSON 200 */ }
    }
    return { httpStatus: resp.status, body: text, data }
  } catch (err) {
    return { httpStatus: 0, body: '', data: null, networkError: err.message }
  } finally {
    clearTimeout(timer)
  }
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 调 refresh 端点 + Transient 1s/2s/4s 退避（最多 3 次重试 = 共 4 次调用）
 *
 * @param {string} refreshToken
 * @param {{ onAttempt?: (n: number, delayMs: number) => void }} [opts]
 * @returns {Promise<
 *   | { ok: true, data: object, attempts: number }
 *   | { ok: false, classification: 'Permanent' | 'Transient', reason: string, code?: string | null, http?: number, attempts: number, lastBody?: string }
 * >}
 */
async function callRefreshWithBackoff(refreshToken, opts = {}) {
  let attempt = 0
  let lastClass = null
  while (true) {
    attempt += 1
    const resp = await callRefreshEndpoint(refreshToken)
    if (resp.data && resp.httpStatus >= 200 && resp.httpStatus < 300) {
      return { ok: true, data: resp.data, attempts: attempt }
    }
    const cls = classify(resp.httpStatus, resp.body)
    lastClass = { ...cls, attempts: attempt, lastBody: resp.body?.slice?.(0, 500) }
    if (cls.classification === 'Permanent') {
      return { ok: false, ...lastClass }
    }
    // Transient
    if (attempt > TRANSIENT_BACKOFFS_MS.length) {
      return { ok: false, ...lastClass }
    }
    const backoff = TRANSIENT_BACKOFFS_MS[attempt - 1]
    opts.onAttempt?.(attempt, backoff)
    await delay(backoff)
  }
}

// ---------- 公共 API ----------

/**
 * 刷新指定账号的 token（V1.7）
 *
 * @param {{
 *   accountName: string,
 *   force?: boolean,
 *   logger?: object,
 *   onAttempt?: (n: number, delayMs: number) => void,
 *   bypassRateLimit?: boolean, // sweep 内部调用时传 true，避免 sweep 一次性刷 N 个账号被 24h 限频拦
 * }} opts
 * @returns {Promise<
 *   | { ok: true, refreshed: boolean, accountName: string }
 *   | { ok: false, accountName: string, classification: 'Permanent' | 'Transient', reason: string, code?: string | null, http?: number, attempts?: number, error?: string }
 * >}
 */
async function ensureFreshCodexTokenV17(opts = {}) {
  const { accountName, force = false, logger = console, onAttempt } = opts
  const startTs = _now()
  if (typeof accountName !== 'string' || !accountName) {
    logger.warn?.(`[refresher-v17] no-account-name`)
    return { ok: false, accountName: '', classification: 'Permanent', reason: 'Other', error: 'NO_ACCOUNT_NAME' }
  }
  const I = accountService.__INTERNAL__
  const home = I.getAccountHomeDir(accountName)
  const authFile = path.join(home, 'auth.json')

  if (!fs.existsSync(authFile)) {
    logger.warn?.(`[refresher-v17] auth-missing account=${accountName}`)
    return { ok: false, accountName, classification: 'Permanent', reason: 'Other', error: 'AUTH_FILE_MISSING' }
  }

  // 24h force 限频（sweep 内部调用可旁路：sweep 自有 mtime + keepalive 守门，
  // 不应被单账号 24h 限频拦截批量刷新；详见 V1.7 P1-2 修复）
  const now = _now()
  if (force && !opts.bypassRateLimit) {
    if (get24hForceCount(accountName, now) >= MAX_FORCE_PER_24H) {
      logger.warn?.(`[refresher-v17] rate-limited account=${accountName} window=24h max=${MAX_FORCE_PER_24H}`)
      return { ok: false, accountName, classification: 'Transient', reason: 'RateLimited', error: 'FORCE_24H_LIMIT' }
    }
  }

  logger.info?.(`[refresher-v17] begin account=${accountName} force=${force} bypassRateLimit=${!!opts.bypassRateLimit}`)

  const auth = await readJsonSafe(authFile)
  if (!auth) {
    return { ok: false, accountName, classification: 'Permanent', reason: 'Other', error: 'AUTH_FILE_CORRUPT' }
  }

  // pendingTokenCache 优先：磁盘上可能是旧的，内存里的是上次成功响应但写盘失败的
  const cached = pendingTokenCache.get(accountName)
  const refreshToken = cached?.refresh_token || auth?.tokens?.refresh_token
  if (!refreshToken) {
    return { ok: false, accountName, classification: 'Permanent', reason: 'Other', error: 'NO_REFRESH_TOKEN' }
  }

  // 非 force 模式：access_token 还很新就直接 ok（设计稿 §7.3 6h 窗口）
  if (!force) {
    const accessToken = cached?.access_token || auth?.tokens?.access_token
    if (accessToken && !isAccessTokenStale(accessToken)) {
      return { ok: true, refreshed: false, accountName }
    }
  }

  // inflight 去重（V1.7 P0-2：per-name，不再含 force 维度）
  const inflightKey = accountName
  if (inflight.has(inflightKey)) return inflight.get(inflightKey)

  const task = (async () => {
    try {
      if (force && !opts.bypassRateLimit) record24hForce(accountName, now)

      const result = await callRefreshWithBackoff(refreshToken, { onAttempt })
      if (!result.ok) {
        // 写 state.json + log
        if (result.classification === 'Permanent') {
          logger.warn?.(`[refresher-v17] permanent account=${accountName} reason=${result.reason} code=${result.code} attempts=${result.attempts}`)
          await persistState(accountName, { status: 'invalid', permanentReason: result.reason }).catch(() => {})
        } else {
          logger.warn?.(`[refresher-v17] transient-paused account=${accountName} reason=${result.reason} attempts=${result.attempts}`)
          await persistState(accountName, { status: 'paused' }).catch(() => {})
        }
        return { ok: false, accountName, ...result }
      }

      // 200 OK → 持久化
      const next = {
        OPENAI_API_KEY: auth.OPENAI_API_KEY ?? null,
        tokens: {
          id_token: result.data.id_token || auth?.tokens?.id_token,
          access_token: result.data.access_token || auth?.tokens?.access_token,
          refresh_token: result.data.refresh_token || refreshToken,
          account_id: auth?.tokens?.account_id || '',
        },
        last_refresh: new Date(now).toISOString(),
      }
      // 立刻写 .recovery-<ts> 兜底（V1.7 沿用 V1.6.2 设计）
      const recoveryPath = `${authFile}.recovery-${now}`
      try {
        await fsp.writeFile(
          recoveryPath,
          JSON.stringify({ accountName, response: result.data, timestamp: new Date(now).toISOString() }, null, 2),
          { encoding: 'utf8', mode: 0o600 },
        )
      } catch (err) {
        logger.warn?.(`[codexTokenRefresherV17] .recovery 写盘失败：${err.message}（继续 atomic write）`)
      }

      try {
        await atomicWriteJson(authFile, next)
        // 写盘成功 → 清 cache + 清 .recovery + 标 active
        pendingTokenCache.delete(accountName)
        await fsp.unlink(recoveryPath).catch(() => {})
        await persistState(accountName, { status: 'active', lastForceRefreshAt: now }).catch(() => {})
        logger.info?.(`[refresher-v17] done account=${accountName} refreshed=true attempts=${result.attempts} elapsedMs=${_now() - startTs}`)
        return { ok: true, refreshed: true, accountName }
      } catch (err) {
        // 写盘失败 → 把新 refresh_token 留内存
        pendingTokenCache.set(accountName, next.tokens)
        logger.error?.(`[refresher-v17] persist-failed account=${accountName} message=${err?.message} cached=true`)
        return {
          ok: false,
          accountName,
          classification: 'Transient',
          reason: 'PersistFailed',
          error: err.message,
        }
      }
    } finally {
      inflight.delete(inflightKey)
    }
  })()

  inflight.set(inflightKey, task)
  return task
}

/**
 * 判断 access_token 距今 iat 是否已超过保活窗口（默认 6h）
 */
function isAccessTokenStale(accessToken, freshSeconds = 6 * 3600) {
  try {
    const payload = decodeJwtPayload(accessToken)
    if (typeof payload.iat !== 'number') return true
    const nowSec = Math.floor(_now() / 1000)
    return (nowSec - payload.iat) > freshSeconds
  } catch {
    return true
  }
}

async function persistState(accountName, state) {
  await accountService.writeAccountStateV17(accountName, state)
}

/**
 * 遍历所有 inactive 账号、对超阈值的执行 force refresh
 *
 * @param {{
 *   activeAccountName?: string,             // 不传则读 active.json
 *   keepaliveMs?: number,                   // 默认 7d
 *   mtimeGuardMs?: number,                  // 默认 60s
 *   logger?: object,
 * }} [opts]
 * @returns {Promise<{
 *   active: string | null,
 *   processed: Array<{ accountName: string, action: 'refreshed' | 'permanent' | 'transient' | 'skipped-mtime' | 'skipped-active' | 'skipped-not-due' | 'error', reason?: string }>
 * }>}
 */
async function sweepAllSlotsV17(opts = {}) {
  const I = accountService.__INTERNAL__
  const accountsDir = I.getAccountsDir()
  const logger = opts.logger ?? console
  const sweepStart = _now()
  if (!fs.existsSync(accountsDir)) {
    logger.info?.(`[sweep-v17] start-skip reason=accounts-dir-missing`)
    return { active: null, processed: [] }
  }
  const active = opts.activeAccountName ?? (await accountService.readActiveJsonV17())?.currentAccount ?? null
  const keepaliveMs = opts.keepaliveMs ?? 7 * 24 * 3600 * 1000
  const mtimeGuard = opts.mtimeGuardMs ?? MTIME_GUARD_MS
  const now = _now()
  logger.info?.(`[sweep-v17] start active=${active} keepaliveMs=${keepaliveMs} mtimeGuardMs=${mtimeGuard}`)

  const entries = await fsp.readdir(accountsDir, { withFileTypes: true })
  // V1.7 P0-2 修复：anon-* 是未完成登录的临时目录，不应被 keepalive 刷新
  // （避免消耗 refresh 次数 + forceHistory 累积 + 影响 anon mtime）
  const accountEntries = entries.filter((e) => e.isDirectory() && !e.name.startsWith('anon-'))
  // V1.7 P1-1：双判据 fail-closed 跳过 active：
  //   判据 1：active.json.currentAccount === name
  //   判据 2：accounts/{active}/.codex/auth.json.account_id === accounts/{name}/.codex/auth.json.account_id
  //   只要其中一个判定"是 active"就跳过——防止 active.json 与 auth.json 失同步时误刷
  let activeAccountId = null
  if (active) {
    const activeAuth = await readJsonSafe(path.join(I.getAccountHomeDir(active), 'auth.json'))
    activeAccountId = activeAuth?.tokens?.account_id ?? null
  }
  const processed = []
  for (const ent of accountEntries) {
    const name = ent.name
    if (name === active) {
      processed.push({ accountName: name, action: 'skipped-active' })
      continue
    }
    const authFile = path.join(I.getAccountHomeDir(name), 'auth.json')
    if (!fs.existsSync(authFile)) {
      processed.push({ accountName: name, action: 'error', reason: 'AUTH_MISSING' })
      continue
    }
    // 双判据兜底：accountId 匹配活账号 → 同样跳过
    if (activeAccountId) {
      const candidateAuth = await readJsonSafe(authFile)
      if (candidateAuth?.tokens?.account_id === activeAccountId) {
        processed.push({ accountName: name, action: 'skipped-active', reason: 'account-id-match' })
        continue
      }
    }
    // mtime 防撞车
    let stat
    try { stat = await fsp.stat(authFile) } catch (err) {
      processed.push({ accountName: name, action: 'error', reason: err.code || 'STAT' })
      continue
    }
    if (now - stat.mtimeMs < mtimeGuard) {
      processed.push({ accountName: name, action: 'skipped-mtime' })
      continue
    }
    // 看 iat / lastForceRefreshAt（决定是否到期，设计稿 §4.2）
    const auth = await readJsonSafe(authFile)
    const iat = auth?.tokens?.access_token ? safeIat(auth.tokens.access_token) : null
    const lastForceMs = (await accountService.readAccountStateV17(name))?.lastForceRefreshAt
    // baseline 取"最近一次有效铸票时刻"——iat 或 lastForceRefreshAt 较新者；二者都缺则视为立刻到期
    const baseline = Math.max(iat ? iat * 1000 : 0, lastForceMs ?? 0)
    // baseline === 0 → 从未刷过，立刻刷（"立刻到期"语义，P1-9）
    if (baseline > 0 && now - baseline < keepaliveMs) {
      processed.push({ accountName: name, action: 'skipped-not-due' })
      continue
    }
    const result = await ensureFreshCodexTokenV17({
      accountName: name, force: true, logger: opts.logger, bypassRateLimit: true,
    })
    if (result.ok) {
      processed.push({ accountName: name, action: 'refreshed' })
    } else if (result.classification === 'Permanent') {
      processed.push({ accountName: name, action: 'permanent', reason: result.reason })
    } else {
      processed.push({ accountName: name, action: 'transient', reason: result.reason })
    }
  }
  const summary = processed.reduce((m, p) => { m[p.action] = (m[p.action] ?? 0) + 1; return m }, {})
  logger.info?.(`[sweep-v17] done active=${active} total=${processed.length} elapsedMs=${_now() - sweepStart} summary=${JSON.stringify(summary)}`)
  return { active, processed }
}

function safeIat(jwt) {
  try {
    const payload = decodeJwtPayload(jwt)
    return typeof payload.iat === 'number' ? payload.iat : null
  } catch { return null }
}

/**
 * 算下次 keepalive 时刻（账号级），返回 null 表示不需要
 */
function nextKeepaliveAt(accountName, state, auth, now, keepaliveMs = 7 * 24 * 3600 * 1000) {
  const iatSec = auth?.tokens?.access_token ? safeIat(auth.tokens.access_token) : null
  const baseline = Math.max(iatSec ? iatSec * 1000 : 0, state?.lastForceRefreshAt ?? 0)
  if (baseline === 0) return now // 立刻刷
  return baseline + keepaliveMs
}

/**
 * 启动时崩溃恢复：扫所有 account 目录下的 .recovery-<ts> 文件，按时间窗口 重放
 *
 * @param {{ maxAgeMs?: number, logger?: object }} [opts]
 * @returns {Promise<Array<{ accountName: string, action: 'restored' | 'expired' | 'skipped', recoveryPath: string }>>}
 */
async function recoverFromCrashV17(opts = {}) {
  const I = accountService.__INTERNAL__
  const accountsDir = I.getAccountsDir()
  if (!fs.existsSync(accountsDir)) return []
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000 // 10 分钟（K7）
  const now = _now()
  const logger = opts.logger ?? console
  const report = []
  const accounts = await fsp.readdir(accountsDir, { withFileTypes: true })
  for (const acc of accounts) {
    if (!acc.isDirectory()) continue
    const home = I.getAccountHomeDir(acc.name)
    let entries
    try { entries = await fsp.readdir(home) } catch { continue }
    for (const file of entries) {
      if (!file.startsWith('auth.json.recovery-')) continue
      const recoveryPath = path.join(home, file)
      const tsMatch = file.match(/auth\.json\.recovery-(\d+)/)
      const ts = tsMatch ? Number(tsMatch[1]) : 0
      if (!ts || now - ts > maxAgeMs) {
        // 过期 → 删除（K7：10 分钟外认为陈旧）
        await fsp.unlink(recoveryPath).catch(() => {})
        report.push({ accountName: acc.name, action: 'expired', recoveryPath })
        continue
      }
      // 在窗口内 → 把 response 合并到 auth.json
      try {
        const recovery = JSON.parse(await fsp.readFile(recoveryPath, 'utf8'))
        const auth = (await readJsonSafe(path.join(home, 'auth.json'))) ?? { tokens: {} }
        const resp = recovery.response || {}
        const next = {
          OPENAI_API_KEY: auth.OPENAI_API_KEY ?? null,
          tokens: {
            id_token: resp.id_token || auth?.tokens?.id_token,
            access_token: resp.access_token || auth?.tokens?.access_token,
            refresh_token: resp.refresh_token || auth?.tokens?.refresh_token,
            account_id: auth?.tokens?.account_id || '',
          },
          last_refresh: new Date(ts).toISOString(),
        }
        await atomicWriteJson(path.join(home, 'auth.json'), next)
        await fsp.unlink(recoveryPath).catch(() => {})
        report.push({ accountName: acc.name, action: 'restored', recoveryPath })
      } catch (err) {
        logger.warn?.(`[codexTokenRefresherV17] recovery 重放失败 ${acc.name}: ${err.message}`)
        report.push({ accountName: acc.name, action: 'skipped', recoveryPath })
      }
    }
  }
  return report
}

module.exports = {
  ensureFreshCodexTokenV17,
  sweepAllSlotsV17,
  recoverFromCrashV17,
  nextKeepaliveAt,
  setUserAgent,
  TOKEN_URL,
  CLIENT_ID,
  // 供测试
  __INTERNAL__: {
    pendingTokenCache,
    inflight,
    forceHistory,
    __setFetch,
    __resetFetch,
    __setNow,
    __resetNow,
    __clearCaches,
    classify,
    callRefreshWithBackoff,
    callRefreshEndpoint,
    safeIat,
    isAccessTokenStale,
  },
}
