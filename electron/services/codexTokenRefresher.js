/**
 * Codex Token 主动续签服务（V1.6.2）
 *
 * 解决 V1.5.0 Bug B：被切到一边躺着的账户副本永远不被续签 token，
 * 导致用户切回去时 access_token / refresh_token 都已过期。
 *
 * 负责：
 * - 调 OpenAI 官方 codex CLI 同款 endpoint 主动续签（auth.openai.com/oauth/token）
 * - 切换前 lazy refresh 目标槽位
 * - 后台定时 sweep 所有非激活槽位（24h 间隔，7d 阈值）
 * - 跳过当前激活槽（避免和 Codex 自己的 refresh 撞车）
 * - .recovery-<ts> 备份保护：拿到 response 后崩溃也能恢复
 * - 同账户并发去重（inflight Map）
 * - 4xx invalid_grant → needsRelogin（不重试，引导用户重登）
 * - 5xx / 网络错误 → 1 秒退避后重试 1 次
 *
 * 关键决策（详见 PRD-Skill-Manager-V1.6.2-Codex凭证保活.md）：
 * - Content-Type: application/json （跟官方 codex CLI 对齐）
 * - User-Agent: CodePal/<version> （诚实标识，不伪装 codex-cli）
 * - client_id: 来自 openai/codex 仓库源码常量（公开，30+ 第三方项目通用）
 * - endpoint 支持 CODEX_REFRESH_TOKEN_URL_OVERRIDE 环境变量自救
 *
 * @module electron/services/codexTokenRefresher
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const accountService = require('./codexAccountService')
const {
  decodeJwtPayload,
  isTokenExpired,
  extractAccountId,
} = require('./codexJwtUtils')

// ---------- 常量 ----------

// OpenAI 官方 codex CLI OAuth refresh endpoint
// 来源：https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs
// 支持环境变量覆盖（与官方 codex CLI 同款机制）
const TOKEN_URL = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE
  || 'https://auth.openai.com/oauth/token'

// OpenAI 官方 codex CLI 公开 client_id（不是 secret）
// 来源：openai/codex codex-rs/login/src/auth/manager.rs，自 2025-03 未变
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

// OAuth scope（与 wannanbigpig/codex-accounts-manager 对齐）
const OAUTH_SCOPE = 'openid profile email offline_access'

// 切换前 lazy refresh：access_token 距过期 5 分钟内就刷
const LAZY_THRESHOLD_SEC = 5 * 60

// 后台 sweep：access_token 距过期 7 天内就刷
const SWEEP_THRESHOLD_SEC = 7 * 86400

// HTTP 请求超时
const REQUEST_TIMEOUT_MS = 30_000

// 5xx 重试退避
const RETRY_BACKOFF_MS = 1000

// 默认 User-Agent（registerCodexAccountHandlers 启动时通过 setUserAgent 传 app.getVersion()）
let _userAgent = 'CodePal/unknown (+codex-token-refresher)'

// 同账户并发去重：accountId -> Promise<RefreshResult>
const inflight = new Map()

// 测试注入：mock fetch / 文件路径
let _fetch = (typeof fetch === 'function') ? fetch : null
let _now = () => Date.now()

// ---------- 配置注入 ----------

/**
 * 设置 User-Agent（registerCodexAccountHandlers 启动时调一次）
 * @param {string} version - 应用版本（如 '1.6.2'）
 */
function setUserAgent(version) {
  _userAgent = `CodePal/${version} (+codex-token-refresher)`
}

// ---------- 内部工具 ----------

/**
 * 原子写 JSON 文件（tmp + rename）
 */
async function atomicWriteJson(filePath, obj) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf-8', mode: 0o600 })
  await fsp.rename(tmp, filePath)
}

/**
 * 读 JSON 文件，失败返回 null
 */
async function readJsonSafe(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 解析 access_token 的 exp（unix 秒），失败返回 0
 */
function getAccessTokenExpSec(accessToken) {
  if (!accessToken) return 0
  try {
    const payload = decodeJwtPayload(accessToken)
    return typeof payload.exp === 'number' ? payload.exp : 0
  } catch {
    return 0
  }
}

/**
 * 调 OpenAI OAuth refresh endpoint
 * @param {string} refreshToken
 * @returns {Promise<{ok: true, data: object} | {ok: false, status: number, body: string, needsRelogin: boolean}>}
 */
async function callRefreshEndpoint(refreshToken) {
  if (!_fetch) {
    throw new Error('fetch is not available (Node 18+ required)')
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const resp = await _fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
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
    if (!resp.ok) {
      // 4xx 通常是 invalid_grant（refresh_token 自己也过期了）
      const needsRelogin = (resp.status >= 400 && resp.status < 500)
        || /invalid_grant/i.test(text)
      return { ok: false, status: resp.status, body: text.slice(0, 500), needsRelogin }
    }
    let data
    try {
      data = JSON.parse(text)
    } catch (err) {
      return { ok: false, status: resp.status, body: text.slice(0, 500), needsRelogin: false }
    }
    return { ok: true, data }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 调用 refresh endpoint，5xx/网络错误重试 1 次
 * @returns {Promise<{ok: true, data: object} | {ok: false, status: number, body: string, needsRelogin: boolean}>}
 */
async function callRefreshWithRetry(refreshToken) {
  let firstError
  try {
    const result = await callRefreshEndpoint(refreshToken)
    if (result.ok) return result
    // 4xx 不重试
    if (result.status >= 400 && result.status < 500) return result
    firstError = result
  } catch (err) {
    firstError = { ok: false, status: 0, body: err?.message || 'network-error', needsRelogin: false }
  }
  // 5xx / 网络错误：等 1 秒重试一次
  await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
  try {
    return await callRefreshEndpoint(refreshToken)
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: `retry failed: ${err?.message || 'unknown'} (first: ${firstError?.body || 'unknown'})`,
      needsRelogin: false,
    }
  }
}

/**
 * 获取当前激活槽位的 account_id
 *
 * V1.6.2 修复 B2：不再只读 `~/.codex-switcher/current` 文件（CodePal 自己的簿记），
 * 改为读 ~/.codex/auth.json 的真实 account_id。这样即使用户用外部工具切账户、
 * 或 Codex.app 内部刷新了 token 但 current 文件没同步，sweeper 也能正确识别"现在
 * 实际在用哪个账户"，避免对它发起 refresh 撞车。
 *
 * @returns {Promise<{accountId: string, fallbackName: string}>}
 *   - accountId: 真实激活账户 ID（首要判据）
 *   - fallbackName: current 文件里的名字（兜底）
 */
async function getActiveAccountInfo() {
  let accountId = ''
  try {
    const auth = await readJsonSafe(accountService.__INTERNAL__.getAuthFile())
    if (auth) accountId = extractAccountId(auth) || ''
  } catch {}

  let fallbackName = ''
  try {
    const currentFile = path.join(accountService.__INTERNAL__.getAccountsDir(), '..', 'current')
    const raw = await fsp.readFile(currentFile, 'utf-8')
    fallbackName = raw.trim()
  } catch {}

  return { accountId, fallbackName }
}

// ---------- 导出函数 ----------

/**
 * 续签指定 auth.json 文件中的 token
 *
 * 执行步骤：
 *   1. 读 auth.json
 *   2. 检查 access_token 是否需刷（force / 距过期 < threshold）
 *   3. 同 accountId 并发去重（inflight Map）
 *   4. 调 OpenAI refresh endpoint（含 1 次重试）
 *   5. 拿到 response 立刻写 .recovery-<ts> 备份
 *   6. atomic write 槽位文件
 *   7. 删 .recovery
 *
 * @param {object} opts
 * @param {string} opts.filePath - 目标 auth.json 路径（live 或 slot）
 * @param {boolean} [opts.force=false] - 强制刷新（不看过期时间）
 * @param {number} [opts.thresholdSec=300] - 提前多久刷新（秒，默认 5 分钟）
 * @returns {Promise<{success: boolean, refreshed: boolean, needsRelogin?: boolean, error?: string, accountId?: string}>}
 */
async function ensureFreshCodexToken(opts = {}) {
  const { filePath, force = false, thresholdSec = LAZY_THRESHOLD_SEC } = opts
  if (!filePath) return { success: false, refreshed: false, error: 'NO_FILE_PATH' }

  const auth = await readJsonSafe(filePath)
  if (!auth) return { success: false, refreshed: false, error: 'AUTH_FILE_NOT_FOUND' }

  const tokens = auth.tokens || {}
  const accountId = tokens.account_id || extractAccountId(auth) || `path:${filePath}`

  // 不需要刷
  if (!force) {
    const expSec = getAccessTokenExpSec(tokens.access_token)
    const nowSec = Math.floor(_now() / 1000)
    if (expSec > 0 && expSec - nowSec > thresholdSec) {
      return { success: true, refreshed: false, accountId }
    }
  }

  if (!tokens.refresh_token) {
    return { success: false, refreshed: false, needsRelogin: true, error: 'NO_REFRESH_TOKEN', accountId }
  }

  // V1.6.2 修复 C3：inflight key 加 force 维度，避免用户点"强制刷"却拿到 sweeper 的非 force 缓存结果
  const inflightKey = `${accountId}:${force ? 'force' : 'normal'}`

  // 并发去重
  if (inflight.has(inflightKey)) {
    return inflight.get(inflightKey)
  }

  const task = (async () => {
    try {
      const result = await callRefreshWithRetry(tokens.refresh_token)
      if (!result.ok) {
        return {
          success: false,
          refreshed: false,
          needsRelogin: result.needsRelogin,
          error: `REFRESH_FAILED:${result.status}:${result.body}`,
          accountId,
        }
      }

      const respData = result.data
      // 立刻写 .recovery 备份（防止后续步骤崩溃丢失新 refresh_token）
      const recoveryPath = `${filePath}.recovery-${_now()}`
      await fsp.writeFile(
        recoveryPath,
        JSON.stringify({ filePath, response: respData, timestamp: new Date().toISOString() }, null, 2),
        { encoding: 'utf-8', mode: 0o600 }
      )

      // 合并新 tokens 到原 auth 对象
      const next = {
        OPENAI_API_KEY: auth.OPENAI_API_KEY ?? null,
        tokens: {
          id_token: respData.id_token || tokens.id_token,
          access_token: respData.access_token || tokens.access_token,
          // OpenAI 可能返回新 refresh_token；不返回则沿用旧值
          refresh_token: respData.refresh_token || tokens.refresh_token,
          account_id: tokens.account_id
            || extractAccountId({ tokens: { id_token: respData.id_token, access_token: respData.access_token } })
            || '',
        },
        last_refresh: new Date().toISOString(),
      }
      // V1.6.2 修复 B3：保留独立的"上次切入"时间戳，refresh 不动它
      if (typeof auth.__codepal_last_switch_at === 'number') {
        next.__codepal_last_switch_at = auth.__codepal_last_switch_at
      }

      await atomicWriteJson(filePath, next)
      // atomic write 成功才删 .recovery
      await fsp.unlink(recoveryPath).catch(() => {})

      return { success: true, refreshed: true, accountId }
    } finally {
      inflight.delete(inflightKey)
    }
  })()

  inflight.set(inflightKey, task)
  return task
}

/**
 * 后台 sweep：遍历所有非激活槽位，给即将过期的账户续期
 *
 * 跳过当前激活槽（让 Codex 自己刷，避免双写竞争）。
 * 串行执行（一次只刷一个，避免 OpenAI 限流）。
 *
 * @param {object} [opts]
 * @param {number} [opts.thresholdSec=604800] - 提前多久刷（秒，默认 7 天）
 * @returns {Promise<{total: number, refreshed: number, failed: number, skipped: number, needsRelogin: number}>}
 */
async function sweepAllSlots(opts = {}) {
  const { thresholdSec = SWEEP_THRESHOLD_SEC } = opts
  const accountsDir = accountService.__INTERNAL__.getAccountsDir()

  let entries
  try {
    entries = await fsp.readdir(accountsDir)
  } catch {
    return { total: 0, refreshed: 0, failed: 0, skipped: 0, needsRelogin: 0 }
  }

  // V1.6.2 修复 B2：双保险判 active —— 读真实 auth.json 的 accountId（首要），
  // 配合 current 文件名（兜底）。如果两者都拿不到 → fail-closed，整轮跳过避免撞车
  const active = await getActiveAccountInfo()
  if (!active.accountId && !active.fallbackName) {
    console.warn('[token-sweeper] cannot determine active account, skip this round (fail-closed)')
    return { total: 0, refreshed: 0, failed: 0, skipped: 0, needsRelogin: 0 }
  }

  const stats = { total: 0, refreshed: 0, failed: 0, skipped: 0, needsRelogin: 0 }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    if (entry.includes('.recovery-') || entry.includes('.tmp-')) continue
    const name = entry.replace(/\.json$/, '')
    if (!accountService.__INTERNAL__.SAFE_NAME_REGEX.test(name)) continue
    stats.total += 1

    // V1.6.2 修复 B2：跳过激活槽——任一判据匹配都算激活
    const slotPath = path.join(accountsDir, entry)
    if (name === active.fallbackName) {
      stats.skipped += 1
      continue
    }
    if (active.accountId) {
      // 读 slot 看 accountId 是否等于真实激活 accountId
      const slotAuth = await readJsonSafe(slotPath)
      if (slotAuth && extractAccountId(slotAuth) === active.accountId) {
        stats.skipped += 1
        continue
      }
    }

    try {
      const result = await ensureFreshCodexToken({ filePath: slotPath, thresholdSec })
      if (result.success && result.refreshed) {
        stats.refreshed += 1
        console.log(`[token-sweeper] ${name}: refreshed`)
      } else if (result.success) {
        stats.skipped += 1
      } else if (result.needsRelogin) {
        stats.needsRelogin += 1
        console.warn(`[token-sweeper] ${name}: needs relogin (${result.error})`)
      } else {
        stats.failed += 1
        console.warn(`[token-sweeper] ${name}: failed (${result.error})`)
      }
    } catch (err) {
      stats.failed += 1
      console.warn(`[token-sweeper] ${name}: exception`, err?.message || err)
    }
  }

  return stats
}

/**
 * 启动时扫 .recovery-* 文件做崩溃恢复
 *
 * 场景：sweeper 拿到 OpenAI response 后写了 .recovery 备份，
 * 但在 atomic write 槽位文件之前进程崩溃 → response 里的新 refresh_token 还在 .recovery 里。
 *
 * 启动时把 .recovery 的内容应用到对应槽位，然后删除 .recovery。
 *
 * @returns {Promise<{recovered: number, failed: number}>}
 */
async function recoverFromCrash() {
  const accountsDir = accountService.__INTERNAL__.getAccountsDir()

  let entries
  try {
    entries = await fsp.readdir(accountsDir)
  } catch {
    return { recovered: 0, failed: 0, tmpCleaned: 0 }
  }

  let recovered = 0
  let failed = 0
  let tmpCleaned = 0

  // V1.6.2 修复 C2：清理被 SIGKILL 残留的 .tmp-* 文件（mtime > 5 分钟）
  // 避免 atomicCopy/atomicWriteJson 在写一半被杀的垃圾累积
  const TMP_STALE_MS = 5 * 60 * 1000
  const now = _now()
  for (const entry of entries) {
    if (!entry.includes('.tmp-')) continue
    const tmpPath = path.join(accountsDir, entry)
    try {
      const stat = await fsp.stat(tmpPath)
      if (now - stat.mtimeMs > TMP_STALE_MS) {
        await fsp.unlink(tmpPath)
        tmpCleaned += 1
      }
    } catch {
      // 文件可能正在被另一个进程使用，忽略
    }
  }

  for (const entry of entries) {
    if (!entry.includes('.recovery-')) continue
    const recoveryPath = path.join(accountsDir, entry)
    const recoveryData = await readJsonSafe(recoveryPath)
    if (!recoveryData || !recoveryData.filePath || !recoveryData.response) {
      // 损坏的 recovery 文件直接删
      await fsp.unlink(recoveryPath).catch(() => {})
      failed += 1
      continue
    }

    const targetPath = recoveryData.filePath
    try {
      const auth = (await readJsonSafe(targetPath)) || { OPENAI_API_KEY: null, tokens: {} }
      const respData = recoveryData.response
      const oldTokens = auth.tokens || {}
      const next = {
        OPENAI_API_KEY: auth.OPENAI_API_KEY ?? null,
        tokens: {
          id_token: respData.id_token || oldTokens.id_token,
          access_token: respData.access_token || oldTokens.access_token,
          refresh_token: respData.refresh_token || oldTokens.refresh_token,
          account_id: oldTokens.account_id
            || extractAccountId({ tokens: { id_token: respData.id_token, access_token: respData.access_token } })
            || '',
        },
        last_refresh: recoveryData.timestamp || new Date().toISOString(),
      }
      // V1.6.2 修复 B3：恢复时也保留 __codepal_last_switch_at
      if (typeof auth.__codepal_last_switch_at === 'number') {
        next.__codepal_last_switch_at = auth.__codepal_last_switch_at
      }
      await atomicWriteJson(targetPath, next)
      await fsp.unlink(recoveryPath).catch(() => {})
      recovered += 1
      console.log(`[token-recovery] restored ${path.basename(targetPath)}`)
    } catch (err) {
      console.warn(`[token-recovery] failed for ${entry}`, err?.message || err)
      failed += 1
    }
  }

  return { recovered, failed, tmpCleaned }
}

// ---------- 导出 ----------

module.exports = {
  ensureFreshCodexToken,
  sweepAllSlots,
  recoverFromCrash,
  setUserAgent,
  // 供测试用
  __INTERNAL__: {
    TOKEN_URL,
    CLIENT_ID,
    LAZY_THRESHOLD_SEC,
    SWEEP_THRESHOLD_SEC,
    REQUEST_TIMEOUT_MS,
    RETRY_BACKOFF_MS,
    callRefreshEndpoint,
    callRefreshWithRetry,
    getActiveAccountInfo,
    atomicWriteJson,
    inflight,
    // 暴露本模块 require 的 accountService 实例（ESM import / CJS require 缓存可能分离，
    // 测试要拿同一份才能注入 tmpHome，参考 codexAuthWatcher.js 同款做法）
    getLinkedAccountService() { return accountService },
    __setFetch(fn) { _fetch = fn },
    __resetFetch() { _fetch = (typeof fetch === 'function') ? fetch : null },
    __setNow(fn) { _now = fn },
    __resetNow() { _now = () => Date.now() },
  },
}
