/**
 * Codex 账户管理服务
 *
 * 负责：
 * - 读取 ~/.codex/auth.json 与 ~/.codex-switcher/accounts/*.json
 * - 匹配当前激活账户（按 tokens.account_id 比对）
 * - 保存 / 切换 / 重命名 / 删除账户槽位
 * - 自动交互 Codex.app：pgrep 检测 → osascript quit → swap auth.json → open -a Codex
 * - 切换前把当前 auth.json 同步回原激活槽（保 refresh_token 最新）
 *
 * 与 bash 脚本 codex-switch 的目录与命名完全兼容。
 *
 * @module electron/services/codexAccountService
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const childProcess = require('child_process')

const {
  extractEmail,
  extractPlan,
  extractAccountId,
  isRefreshTokenLikelyDead,
} = require('./codexJwtUtils')

// V1.6.2: 懒加载避免和 codexTokenRefresher 形成循环依赖
// （refresher 的 sweepAllSlots 也要用本模块的 __INTERNAL__）
let _refresher = null
function getRefresher() {
  if (!_refresher) _refresher = require('./codexTokenRefresher')
  return _refresher
}
const refresher = {
  ensureFreshCodexToken(...args) {
    return getRefresher().ensureFreshCodexToken(...args)
  },
}

// ---------- 常量 ----------

// 可注入：测试中用 __setHomeDir 替换，生产走 os.homedir()
let _homeDir = os.homedir()

// execFile 可注入：测试中 mock，生产走原生
let _execFile = childProcess.execFile

// 账户名白名单：字母/数字/下划线/点/连字符，1-64 字符
const SAFE_NAME_REGEX = /^[A-Za-z0-9._-]{1,64}$/

// pgrep 超时（毫秒）—— 只用于"Codex 是否在跑"检测
const PGREP_TIMEOUT_MS = 2000

// ---------- 路径工具 ----------

function getCodexDir() { return path.join(_homeDir, '.codex') }
function getAuthFile() { return path.join(getCodexDir(), 'auth.json') }
function getConfigTomlFile() { return path.join(getCodexDir(), 'config.toml') }
function getStoreDir() { return path.join(_homeDir, '.codex-switcher') }
function getAccountsDir() { return path.join(getStoreDir(), 'accounts') }
function getBackupsDir() { return path.join(getStoreDir(), 'backups') }
function getCurrentFile() { return path.join(getStoreDir(), 'current') }
function accountPath(name) { return path.join(getAccountsDir(), `${name}.json`) }

// ---------- 内部工具 ----------

/**
 * 确保存储目录结构存在且权限正确
 */
async function ensureStore() {
  await fsp.mkdir(getAccountsDir(), { recursive: true })
  await fsp.mkdir(getBackupsDir(), { recursive: true })
  // 权限失败静默忽略（例如非 Unix 文件系统）
  try { await fsp.chmod(getStoreDir(), 0o700) } catch {}
  try { await fsp.chmod(getAccountsDir(), 0o700) } catch {}
  try { await fsp.chmod(getBackupsDir(), 0o700) } catch {}
}

/**
 * 原子写文件（mktemp + rename）
 * @param {string} src - 源路径
 * @param {string} dst - 目标路径
 */
async function atomicCopy(src, dst) {
  const buf = await fsp.readFile(src)
  const tmp = `${dst}.tmp-${crypto.randomBytes(6).toString('hex')}`
  await fsp.writeFile(tmp, buf, { mode: 0o600 })
  await fsp.rename(tmp, dst)
}

/**
 * 算文件 sha256（用于 hash 对比）
 * @param {string} filePath
 * @returns {Promise<string>} 64 字符 hex，文件不存在返回空串
 */
async function hashFile(filePath) {
  try {
    const buf = await fsp.readFile(filePath)
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch {
    return ''
  }
}

/**
 * 异步读 JSON，失败返回 null
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
 * 读 current 文件（内容就是一个账户名），不存在返回空串
 */
async function readCurrentName() {
  try {
    const raw = await fsp.readFile(getCurrentFile(), 'utf-8')
    return raw.trim()
  } catch {
    return ''
  }
}

async function writeCurrentName(name) {
  await fsp.writeFile(getCurrentFile(), `${name}\n`, { mode: 0o600 })
}

/**
 * 用 execFile 调用系统命令
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

// ---------- 导出函数 ----------

/**
 * 读取当前 ~/.codex/auth.json
 *
 * @returns {Promise<{exists: boolean, raw?: object, accountId?: string, email?: string, plan?: string}>}
 */
async function readCurrentAuth() {
  const authFile = getAuthFile()
  if (!fs.existsSync(authFile)) {
    return { exists: false }
  }
  const parsed = await readJsonSafe(authFile)
  if (!parsed) {
    return { exists: true, raw: null, accountId: '', email: '(invalid-json)', plan: 'unknown' }
  }
  return {
    exists: true,
    raw: parsed,
    accountId: extractAccountId(parsed),
    email: extractEmail(parsed),
    plan: extractPlan(parsed),
  }
}

/**
 * 检测 Codex 凭证存储模式
 *
 * 读 ~/.codex/config.toml 查找 cli_auth_credentials_store 字段。
 * 不做完整 TOML 解析，只正则匹配 key = value 形式。
 *
 * @returns {Promise<{mode: 'file'|'keyring'|'auto'|'unknown'}>}
 */
async function detectStorageMode() {
  const tomlPath = getConfigTomlFile()
  if (!fs.existsSync(tomlPath)) {
    // 没有 config.toml → Codex 默认用 file 模式
    return { mode: 'file' }
  }
  const raw = await fsp.readFile(tomlPath, 'utf-8').catch(() => '')
  const match = raw.match(/cli_auth_credentials_store\s*=\s*"([^"]+)"/)
  if (!match) return { mode: 'file' }
  const value = String(match[1]).toLowerCase().trim()
  if (value === 'keyring' || value === 'file' || value === 'auto') {
    return { mode: value }
  }
  return { mode: 'unknown' }
}

/**
 * 列出所有已保存账户
 *
 * 执行步骤：
 *   1. 扫描 accounts 目录下所有 .json 文件
 *   2. 每个文件解析 email / plan / account_id
 *   3. 检测 JWT 是否失效（推断 refresh_token 过期）
 *   4. 返回数组 + 当前激活账户名
 *
 * @returns {Promise<{accounts: Array, activeName: string, hasUnsavedActive: boolean, unsavedActive: object|null}>}
 */
async function listSavedAccounts() {
  await ensureStore()
  const dir = getAccountsDir()
  let entries
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return { accounts: [], activeName: '', hasUnsavedActive: false, unsavedActive: null }
  }

  const current = await readCurrentAuth()
  const currentHash = current.exists ? await hashFile(getAuthFile()) : ''

  const accounts = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const name = entry.replace(/\.json$/, '')
    if (!SAFE_NAME_REGEX.test(name)) continue

    const filePath = path.join(dir, entry)
    const parsed = await readJsonSafe(filePath)
    if (!parsed) {
      // 损坏文件：仍列出但标 failed
      accounts.push({
        name,
        email: '(parse-failed)',
        plan: 'unknown',
        accountId: '',
        expired: true,
        lastSwitchAt: null,
      })
      continue
    }

    const stat = await fsp.stat(filePath).catch(() => null)
    const mtimeMs = stat ? stat.mtimeMs : null
    // V1.6.2 修复 B3：优先读独立字段；缺失时回退 mtime（兼容 V1.5.0 旧槽位）
    const lastSwitchAt = (typeof parsed.__codepal_last_switch_at === 'number')
      ? parsed.__codepal_last_switch_at
      : mtimeMs
    accounts.push({
      name,
      email: extractEmail(parsed),
      plan: extractPlan(parsed),
      accountId: extractAccountId(parsed),
      // V1.6.2: 把 mtime 传进去做 last_refresh 缺失时的兜底
      expired: isRefreshTokenLikelyDead(parsed, undefined, mtimeMs),
      lastSwitchAt,
    })
  }

  // 匹配激活账户：按 account_id 优先，兜底按 hash
  let activeName = ''
  if (current.exists && current.accountId) {
    const byId = accounts.find((a) => a.accountId && a.accountId === current.accountId)
    if (byId) activeName = byId.name
  }
  if (!activeName && current.exists && currentHash) {
    for (const a of accounts) {
      const h = await hashFile(accountPath(a.name))
      if (h === currentHash) {
        activeName = a.name
        break
      }
    }
  }

  // 如果 auth.json 存在但未归属 → 报 hasUnsavedActive（用于 UI 展示"未保存账户"卡）
  const hasUnsavedActive = current.exists && !activeName
  const unsavedActive = hasUnsavedActive
    ? { email: current.email, plan: current.plan, accountId: current.accountId }
    : null

  // 排序：未保存的不进 accounts 数组（由 UI 单独渲染）；已保存的按激活 > 最近使用 > 字母序
  accounts.sort((a, b) => {
    if (a.name === activeName) return -1
    if (b.name === activeName) return 1
    if (a.lastSwitchAt && b.lastSwitchAt) return b.lastSwitchAt - a.lastSwitchAt
    if (a.lastSwitchAt) return -1
    if (b.lastSwitchAt) return 1
    return a.name.localeCompare(b.name)
  })

  return { accounts, activeName, hasUnsavedActive, unsavedActive }
}

/**
 * 保存当前 auth.json 为新账户槽位
 *
 * @param {string} name
 * @returns {Promise<{success: boolean, account?: object, error?: string}>}
 */
async function saveAccount(name) {
  if (!SAFE_NAME_REGEX.test(name)) {
    return { success: false, error: 'INVALID_NAME' }
  }
  await ensureStore()
  const dst = accountPath(name)
  if (fs.existsSync(dst)) {
    return { success: false, error: 'NAME_EXISTS' }
  }
  const authFile = getAuthFile()
  if (!fs.existsSync(authFile)) {
    return { success: false, error: 'AUTH_JSON_NOT_FOUND' }
  }
  await atomicCopy(authFile, dst)
  await writeCurrentName(name)

  const parsed = await readJsonSafe(dst)
  return {
    success: true,
    account: {
      name,
      email: extractEmail(parsed),
      plan: extractPlan(parsed),
      accountId: extractAccountId(parsed),
      expired: false,
      lastSwitchAt: Date.now(),
    },
  }
}

/**
 * 重命名已保存账户
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function renameAccount(oldName, newName) {
  if (!SAFE_NAME_REGEX.test(oldName) || !SAFE_NAME_REGEX.test(newName)) {
    return { success: false, error: 'INVALID_NAME' }
  }
  if (oldName === newName) {
    return { success: true }
  }
  const src = accountPath(oldName)
  const dst = accountPath(newName)
  if (!fs.existsSync(src)) return { success: false, error: 'ACCOUNT_NOT_FOUND' }
  if (fs.existsSync(dst)) return { success: false, error: 'NAME_EXISTS' }
  await fsp.rename(src, dst)

  // 若 current 指向旧名，同步更新
  const cur = await readCurrentName()
  if (cur === oldName) await writeCurrentName(newName)
  return { success: true }
}

/**
 * 删除账户（先留冷备份）
 * @returns {Promise<{success: boolean, backupPath?: string, error?: string}>}
 */
async function deleteAccount(name) {
  if (!SAFE_NAME_REGEX.test(name)) {
    return { success: false, error: 'INVALID_NAME' }
  }
  const src = accountPath(name)
  if (!fs.existsSync(src)) return { success: false, error: 'ACCOUNT_NOT_FOUND' }

  await ensureStore()
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = path.join(getBackupsDir(), `rm-${name}-${ts}.json`)
  await fsp.copyFile(src, backup)
  try { await fsp.chmod(backup, 0o600) } catch {}
  await fsp.unlink(src)

  // 若 current 指向被删的账户 → 清空 current
  const cur = await readCurrentName()
  if (cur === name) await writeCurrentName('')
  return { success: true, backupPath: backup }
}

/**
 * 切换到目标账户
 *
 * 策略（V1.5.0 最终版）：**只做凭证交换，不碰 Codex.app**。
 *   - 不调 osascript quit（避免中间态：用户在 Codex 里点"取消保存"会让切换卡住）
 *   - 不 open -a Codex（用户可能正在写东西，不想被打断）
 *   - 只检测 Codex 当前是否在跑，用于 UI 反馈文案（"请重启"还是"下次启动生效"）
 *
 * 执行步骤：
 *   1. 合法性校验
 *   2. 同步当前 auth.json 回原激活槽（保 refresh_token 最新）
 *   3. 幂等检查：目标已是当前激活 → noop
 *   4. 检测 Codex 是否在跑（仅用于 UI 反馈）
 *   5. 原子 swap target.json → auth.json
 *   6. 写 current 文件
 *
 * @param {string} targetName
 * @returns {Promise<{success: boolean, codexWasRunning: boolean, noop?: boolean, error?: string}>}
 */
async function switchAccount(targetName) {
  if (!SAFE_NAME_REGEX.test(targetName)) {
    return { success: false, codexWasRunning: false, error: 'INVALID_NAME' }
  }
  const target = accountPath(targetName)
  if (!fs.existsSync(target)) {
    return { success: false, codexWasRunning: false, error: 'ACCOUNT_NOT_FOUND' }
  }

  // V1.6.2: 同步失败必须显式拦截，不许偷偷丢当前账户的 refresh_token（Bug A）
  const syncResult = await syncCurrentToActiveSlot()
  if (!syncResult.ok) {
    return {
      success: false,
      codexWasRunning: false,
      error: 'SYNC_BEFORE_SWITCH_FAILED',
      hint: `保存当前账户凭证到本地槽位失败：${syncResult.reason}。切换已取消以避免 token 丢失。`,
    }
  }

  // V1.6.2: lazy refresh 目标槽位（Bug B），保证切过去立刻可用
  // 失败原因分两类：
  //   - needsRelogin（4xx invalid_grant）→ 直接拒绝切换并提示重登
  //   - 网络/5xx → 不阻塞切换，让 Codex 自己尝试 refresh
  try {
    const refreshResult = await refresher.ensureFreshCodexToken({
      filePath: target,
      thresholdSec: 5 * 60,
    })
    if (!refreshResult.success && refreshResult.needsRelogin) {
      return {
        success: false,
        codexWasRunning: false,
        error: 'TARGET_NEEDS_RELOGIN',
        hint: `账户 ${targetName} 的授权已过期，请重新登录此账户`,
      }
    }
  } catch (err) {
    // refresh 出现意外异常不阻塞切换
    console.warn('[switch-account] lazy refresh exception, proceed anyway:', err?.message || err)
  }

  const currentHash = await hashFile(getAuthFile())
  const targetHash = await hashFile(target)
  if (currentHash && currentHash === targetHash) {
    await writeCurrentName(targetName)
    return { success: true, codexWasRunning: false, noop: true }
  }

  // 只是"看一眼"Codex 状态用于反馈文案，不做任何操作
  const codexWasRunning = await isCodexRunning()

  try {
    await fsp.mkdir(getCodexDir(), { recursive: true })
    await atomicCopy(target, getAuthFile())
    await writeCurrentName(targetName)
    // V1.6.2 修复 B3：独立记录"上次切入时间"，不让 sweep 续 token 时的 mtime 污染 UI
    await stampLastSwitch(target)
  } catch (err) {
    return {
      success: false,
      codexWasRunning,
      error: `AUTH_WRITE_FAILED:${err.message || 'unknown'}`,
    }
  }

  return { success: true, codexWasRunning }
}

/**
 * V1.6.2 修复 B3：在 slot 文件加 `__codepal_last_switch_at` 字段记录"上次切入时间"
 *
 * 不让后台 sweep / lazy refresh 写入新 token 时的 mtime 跳动污染 UI 显示。
 * refresher 在 atomicWriteJson 时也会保留这个字段（合并 tokens 但不动它）。
 *
 * @param {string} slotPath - 槽位文件路径
 */
async function stampLastSwitch(slotPath) {
  try {
    const auth = await readJsonSafe(slotPath)
    if (!auth) return
    auth.__codepal_last_switch_at = Date.now()
    const tmp = `${slotPath}.tmp-${crypto.randomBytes(6).toString('hex')}`
    await fsp.writeFile(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 })
    await fsp.rename(tmp, slotPath)
  } catch (err) {
    // 不影响主流程，只是 UI 时间显示可能用 mtime 兜底
    console.warn('[codex-account] stampLastSwitch failed:', err?.message || err)
  }
}

/**
 * 把当前 auth.json 同步回原激活槽（保 refresh_token 最新）
 *
 * 规则：current 文件记录的"上次激活账户"存在，且其 account_id 与当前 auth.json 一致
 *       → 把当前 auth.json 覆盖回该槽位
 * 否则：跳过（未归属情况由上层决定如何处理）
 *
 * V1.6.2 修复 Bug A：所有异常路径返回 `{ok: false, reason}`，不再静默吞错。
 * 调用方必须根据返回值决定是否继续 swap，避免丢失当前账户的最新 refresh_token。
 *
 * @returns {Promise<{ok: boolean, reason: string}>}
 *   - `ok=true`: 同步成功 / 无需同步（无 auth.json / 无槽位 / hash 一致）
 *   - `ok=false`: 应该同步但失败了（磁盘/权限/锁等），调用方应中止 swap
 */
async function syncCurrentToActiveSlot() {
  try {
    if (!fs.existsSync(getAuthFile())) return { ok: true, reason: 'no-auth-file' }
    const current = await readCurrentAuth()
    if (!current.accountId) return { ok: true, reason: 'no-account-id' }

    const lastName = await readCurrentName()
    if (!lastName || !SAFE_NAME_REGEX.test(lastName)) return { ok: true, reason: 'no-current-name' }

    const slot = accountPath(lastName)
    if (!fs.existsSync(slot)) return { ok: true, reason: 'slot-not-exists' }

    const slotParsed = await readJsonSafe(slot)
    if (!slotParsed) return { ok: true, reason: 'slot-parse-failed' }
    const slotAid = extractAccountId(slotParsed)
    if (!slotAid || slotAid !== current.accountId) {
      // 不同账户：不该同步（避免污染别的槽位）
      return { ok: true, reason: 'account-mismatch' }
    }

    // 同账户：判断是否需要同步
    const curHash = await hashFile(getAuthFile())
    const slotHash = await hashFile(slot)
    if (curHash === slotHash) return { ok: true, reason: 'already-synced' }

    // 真正需要同步——这是唯一能失败的关键路径
    await atomicCopy(getAuthFile(), slot)
    return { ok: true, reason: 'synced' }
  } catch (err) {
    return { ok: false, reason: err?.message || 'unknown-error' }
  }
}

/**
 * 检测 Codex.app 是否在运行（仅用于 UI 反馈文案）
 * @returns {Promise<boolean>}
 */
async function isCodexRunning() {
  const { code } = await execFilePromise('pgrep', ['-x', 'Codex'], { timeout: PGREP_TIMEOUT_MS })
  return code === 0
}

/**
 * 打开 Codex.app（供"重新登录失效账户"场景使用，切换账户不调它）
 */
async function openCodex() {
  const { code, stderr } = await execFilePromise('open', ['-a', 'Codex'], { timeout: 3000 })
  return { success: code === 0, error: code !== 0 ? stderr : undefined }
}

/**
 * 根据 email 生成默认账户名
 *
 * 规则：取 `@` 前的部分，小写，非 [A-Za-z0-9._-] 的字符替换为 `_`
 *      与已有账户重名时自增 `-2`、`-3`
 *
 * @param {string} email
 * @param {string[]} existingNames
 * @returns {string}
 */
function emailToDefaultName(email, existingNames = []) {
  if (!email || typeof email !== 'string') return pickFallbackName(existingNames)
  const at = email.indexOf('@')
  const local = at > 0 ? email.slice(0, at) : email
  let base = local.toLowerCase().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)
  if (!base) base = 'account'

  const set = new Set(existingNames)
  if (!set.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!set.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

function pickFallbackName(existingNames) {
  const set = new Set(existingNames)
  for (let i = 1; i < 1000; i++) {
    const n = `account-${i}`
    if (!set.has(n)) return n
  }
  return `account-${Date.now()}`
}

// ---------- 导出 ----------

module.exports = {
  // 读
  readCurrentAuth,
  listSavedAccounts,
  detectStorageMode,
  // 写
  saveAccount,
  renameAccount,
  deleteAccount,
  switchAccount,
  // 工具
  emailToDefaultName,
  openCodex,
  // 供测试和 watcher 使用
  __INTERNAL__: {
    SAFE_NAME_REGEX,
    PGREP_TIMEOUT_MS,
    getAuthFile,
    getAccountsDir,
    getBackupsDir,
    getCurrentFile,
    getConfigTomlFile,
    accountPath,
    ensureStore,
    atomicCopy,
    hashFile,
    isCodexRunning,
    syncCurrentToActiveSlot,
    // V1.6.2: 暴露本模块 require 的 refresher 实例（同 codexAuthWatcher 同款做法）
    getLinkedRefresher() { return getRefresher() },
    __setHomeDir(dir) { _homeDir = dir },
    __resetHomeDir() { _homeDir = os.homedir() },
    __setExecFile(fn) { _execFile = fn },
    __resetExecFile() { _execFile = childProcess.execFile },
  },
}
