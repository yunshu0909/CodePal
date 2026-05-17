/**
 * Codex 账户管理服务
 *
 * 负责：
 * - 读取 ~/.codex/auth.json 与 ~/.codex-switcher/accounts/*.json
 * - 匹配当前激活账户（按 tokens.account_id 比对）
 * - 保存 / 切换 / 重命名 / 删除账户槽位
 * - 切换时可完整重启 Codex.app，让新 auth.json 被重新加载
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
const codexProcessService = require('./codexProcessService')

const {
  extractEmail,
  extractPlan,
  extractAccountId,
  isRefreshTokenLikelyDead,
} = require('./codexJwtUtils')

// 懒加载避免和 codexTokenRefresher 形成循环依赖。
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

// 账户名白名单：字母/数字/下划线/点/连字符，1-64 字符
const SAFE_NAME_REGEX = /^[A-Za-z0-9._-]{1,64}$/

// 进程检测超时（毫秒）—— 兼容历史测试与内部常量暴露
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
    const lastSwitchAt = (typeof parsed.__codepal_last_switch_at === 'number')
      ? parsed.__codepal_last_switch_at
      : mtimeMs
    accounts.push({
      name,
      email: extractEmail(parsed),
      plan: extractPlan(parsed),
      accountId: extractAccountId(parsed),
      // 优先信"真的试过确认死了"的标记，否则回落到启发式猜测
      expired: parsed.__codepal_needs_relogin === true
        || isRefreshTokenLikelyDead(parsed, undefined, mtimeMs),
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
 * 默认策略保持兼容：只做凭证交换，不碰 Codex.app。
 * 传入 `{ restartCodex: true }` 时走推荐路径：
 *   - 先完整退出 Codex 进程树，避免旧 app-server 用旧账号覆盖 auth.json
 *   - 再同步当前槽位、刷新目标槽位、swap auth.json
 *   - 最后重新打开 Codex，让新账号立即生效
 *
 * 执行步骤：
 *   1. 合法性校验
 *   2. 重启模式下先检测并完整退出 Codex
 *   3. 同步当前 auth.json 回原激活槽（保 refresh_token 最新）
 *   4. lazy refresh 目标槽位，失效账户直接拦截
 *   5. 幂等检查：目标已是当前激活 → noop
 *   6. 事务式写入 auth.json + current，失败时回滚
 *   7. 重启模式下重新打开 Codex
 *
 * @param {string} targetName
 * @param {{restartCodex?: boolean}} [options]
 * @returns {Promise<{success: boolean, codexWasRunning: boolean, noop?: boolean, restarted?: boolean, restartError?: string, error?: string}>}
 */
async function switchAccount(targetName, options = {}) {
  if (!SAFE_NAME_REGEX.test(targetName)) {
    return { success: false, codexWasRunning: false, error: 'INVALID_NAME' }
  }
  const target = accountPath(targetName)
  if (!fs.existsSync(target)) {
    return { success: false, codexWasRunning: false, error: 'ACCOUNT_NOT_FOUND' }
  }

  const shouldRestartCodex = Boolean(options.restartCodex)
  let codexWasRunning = false

  if (shouldRestartCodex) {
    const runningCheck = await codexProcessService.listCodexProcesses()
    if (!runningCheck.success) {
      return {
        success: false,
        codexWasRunning: false,
        error: 'CODEX_PROCESS_CHECK_FAILED',
        hint: `检测 Codex 进程失败：${runningCheck.error || 'unknown'}`,
      }
    }
    codexWasRunning = runningCheck.processes.length > 0
    if (codexWasRunning) {
      const quitResult = await codexProcessService.quitCodex()
      if (!quitResult.success) {
        return {
          success: false,
          codexWasRunning: true,
          error: 'CODEX_QUIT_FAILED',
          hint: `Codex 仍有 ${quitResult.remaining?.length || 0} 个进程未退出，切换已取消以避免旧账号覆盖新凭证。`,
        }
      }
    }
  }

  const syncResult = await syncCurrentToActiveSlot()
  if (!syncResult.ok) {
    const restartState = await reopenAfterCanceledSwitch(shouldRestartCodex, codexWasRunning)
    return {
      success: false,
      codexWasRunning,
      ...restartState,
      error: 'SYNC_BEFORE_SWITCH_FAILED',
      hint: `保存当前账户凭证到本地槽位失败：${syncResult.reason}。切换已取消以避免 token 丢失。`,
    }
  }

  // 目标就是当前激活账户时跳过强制刷新：live auth.json 里的就是能用的票，
  // syncCurrentToActiveSlot 已把它回灌到该槽位，再 force 刷只会无谓轮换活号、徒增风险。
  const liveAuth = await readCurrentAuth()
  const targetParsedForActive = await readJsonSafe(target)
  const targetAid = targetParsedForActive ? extractAccountId(targetParsedForActive) : ''
  const targetIsAlreadyActive = Boolean(liveAuth.exists && liveAuth.accountId && targetAid && liveAuth.accountId === targetAid)

  // 目标槽失效要拦截；网络/5xx 则让 Codex 自己再试 refresh。
  try {
    if (targetIsAlreadyActive) {
      // 跳过 force 刷新，走下面的 noop 短路逻辑
    } else {
    // 切换到目标账户时无条件强制刷新它的 token：
    // 槽位是冻结快照，里面的 refresh_token 可能已被 Codex 自己轮换作废
    // （单次性 token）。用 access_token 过期时间做启发式判断是看错时钟——
    // 账户死于 refresh_token 被轮换，跟 access_token 还剩几天过期无关。
    // force 刷新保证：要么 Codex 拿到切换那刻新铸的 token，要么当场暴露
    // 槽位已失效并引导用户重新登录该账户，绝不把废票静默端给 Codex。
    const refreshResult = await refresher.ensureFreshCodexToken({
      filePath: target,
      force: true,
    })
    if (!refreshResult.success && refreshResult.needsRelogin) {
      // 真的试过、确认这张票已死 → 持久化标记，让卡片立刻转"已失效"态
      await stampNeedsRelogin(target)
      const restartState = await reopenAfterCanceledSwitch(shouldRestartCodex, codexWasRunning)
      return {
        success: false,
        codexWasRunning,
        ...restartState,
        error: 'TARGET_NEEDS_RELOGIN',
        hint: `账户 ${targetName} 的授权已过期，请重新登录此账户`,
      }
    }
    }
  } catch (err) {
    // refresh 出现意外异常不阻塞切换
    console.warn('[switch-account] lazy refresh exception, proceed anyway:', err?.message || err)
  }

  const currentHash = await hashFile(getAuthFile())
  const targetHash = await hashFile(target)
  if (currentHash && currentHash === targetHash) {
    try {
      await writeCurrentName(targetName)
    } catch (err) {
      const restartState = await reopenAfterCanceledSwitch(shouldRestartCodex, codexWasRunning)
      return {
        success: false,
        codexWasRunning,
        ...restartState,
        error: `CURRENT_WRITE_FAILED:${err?.message || 'unknown'}`,
      }
    }
    if (shouldRestartCodex && codexWasRunning) {
      const openResult = await codexProcessService.openCodex()
      return {
        success: true,
        codexWasRunning,
        noop: true,
        restarted: openResult.success,
        restartError: openResult.success ? undefined : openResult.error,
      }
    }
    return { success: true, codexWasRunning, noop: true }
  }

  // 兼容旧路径：不要求重启时，只检测运行态用于 UI 提示。
  if (!shouldRestartCodex) {
    codexWasRunning = await isCodexRunning()
  }

  const swapResult = await swapAuthAndCurrent(target, targetName)
  if (!swapResult.ok) {
    const restartState = swapResult.rollbackFailed
      ? {}
      : await reopenAfterCanceledSwitch(shouldRestartCodex, codexWasRunning)
    return {
      success: false,
      codexWasRunning,
      ...restartState,
      error: `AUTH_WRITE_FAILED:${swapResult.reason || 'unknown'}`,
      hint: swapResult.rollbackFailed
        ? `写入凭证失败且回滚失败：${swapResult.rollbackErrors.join('；')}。Codex 已保持关闭，请手动检查 auth.json。`
        : undefined,
    }
  }
  await stampLastSwitch(target)

  if (shouldRestartCodex && codexWasRunning) {
    const openResult = await codexProcessService.openCodex()
    return {
      success: true,
      codexWasRunning,
      restarted: openResult.success,
      restartError: openResult.success ? undefined : openResult.error,
    }
  }

  return { success: true, codexWasRunning, restarted: false }
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
    // 成功切入 = 该号此刻可用 → 清掉可能残留的失效标记，
    // 兜住 watcher 在重登时错过同步（same-id/in-flight）导致卡片一直红的路径
    delete auth.__codepal_needs_relogin
    const tmp = `${slotPath}.tmp-${crypto.randomBytes(6).toString('hex')}`
    await fsp.writeFile(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 })
    await fsp.rename(tmp, slotPath)
  } catch (err) {
    // 不影响主流程，只是 UI 时间显示可能用 mtime 兜底
    console.warn('[codex-account] stampLastSwitch failed:', err?.message || err)
  }
}

/**
 * 在 slot 文件打 `__codepal_needs_relogin` 标记
 *
 * 场景：切换时强制刷新被 OpenAI 以 invalid_grant 打回（refresh_token 已被
 * 轮换作废）。这是"真的试过、确认死了"的事实，比 isRefreshTokenLikelyDead
 * 的启发式猜测可靠。listSavedAccounts 据此把卡片直接标红为"已失效"，不再
 * 误导用户它还能切。
 *
 * 自清除：用户在 Codex.app 重登成功后，watcher 会用全新 auth.json 覆盖整个
 * 槽位（不含此标记）；refresher 成功续签时 next 对象也不带此字段 → 标记消失。
 *
 * @param {string} slotPath - 槽位文件路径
 */
async function stampNeedsRelogin(slotPath) {
  try {
    const auth = await readJsonSafe(slotPath)
    if (!auth) return
    auth.__codepal_needs_relogin = true
    const tmp = `${slotPath}.tmp-${crypto.randomBytes(6).toString('hex')}`
    await fsp.writeFile(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 })
    await fsp.rename(tmp, slotPath)
  } catch (err) {
    // 不影响主流程，只是 UI 仍会回落到启发式 expired 判断
    console.warn('[codex-account] stampNeedsRelogin failed:', err?.message || err)
  }
}

/**
 * 给文件创建可回滚快照
 * @param {string} filePath - 文件路径
 * @returns {Promise<{exists: boolean, data: Buffer|null}>}
 */
async function snapshotFile(filePath) {
  try {
    return { exists: true, data: await fsp.readFile(filePath) }
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false, data: null }
    throw err
  }
}

/**
 * 从快照恢复文件
 * @param {string} filePath - 文件路径
 * @param {{exists: boolean, data: Buffer|null}} snapshot - 文件快照
 * @returns {Promise<void>}
 */
async function restoreFileSnapshot(filePath, snapshot) {
  if (!snapshot.exists) {
    await fsp.rm(filePath, { force: true })
    return
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, snapshot.data, { mode: 0o600 })
}

/**
 * 同步写入 auth.json 与 current 文件，失败时尽量回滚到切换前状态
 * @param {string} target - 目标账户槽位文件
 * @param {string} targetName - 目标账户名
 * @returns {Promise<{ok: boolean, reason?: string, rollbackFailed?: boolean, rollbackErrors?: string[]}>}
 */
async function swapAuthAndCurrent(target, targetName) {
  let authSnapshot
  let currentSnapshot
  try {
    authSnapshot = await snapshotFile(getAuthFile())
    currentSnapshot = await snapshotFile(getCurrentFile())
    await fsp.mkdir(getCodexDir(), { recursive: true })
    await atomicCopy(target, getAuthFile())
    await writeCurrentName(targetName)
    return { ok: true }
  } catch (err) {
    const rollbackErrors = []
    if (authSnapshot) {
      try {
        await restoreFileSnapshot(getAuthFile(), authSnapshot)
      } catch (rollbackErr) {
        rollbackErrors.push(`auth.json:${rollbackErr?.message || rollbackErr}`)
      }
    }
    if (currentSnapshot) {
      try {
        await restoreFileSnapshot(getCurrentFile(), currentSnapshot)
      } catch (rollbackErr) {
        rollbackErrors.push(`current:${rollbackErr?.message || rollbackErr}`)
      }
    }
    return {
      ok: false,
      reason: err?.message || 'unknown',
      rollbackFailed: rollbackErrors.length > 0,
      rollbackErrors,
    }
  }
}

/**
 * 重启切换中途取消时，恢复打开原本正在运行的 Codex
 * @param {boolean} shouldRestartCodex - 本次是否请求重启 Codex
 * @param {boolean} codexWasRunning - Codex 是否曾在切换前运行
 * @returns {Promise<{restarted?: boolean, restartError?: string}>}
 */
async function reopenAfterCanceledSwitch(shouldRestartCodex, codexWasRunning) {
  if (!shouldRestartCodex || !codexWasRunning) return {}
  const openResult = await codexProcessService.openCodex()
  return {
    restarted: openResult.success,
    restartError: openResult.success ? undefined : openResult.error,
  }
}

/**
 * 按 account_id 查找已保存槽位
 * @param {string} accountId - Codex account_id
 * @returns {Promise<{name: string, filePath: string}|null>}
 */
async function findAccountSlotByAccountId(accountId) {
  if (!accountId) return null
  let entries
  try {
    entries = await fsp.readdir(getAccountsDir())
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const name = entry.replace(/\.json$/, '')
    if (!SAFE_NAME_REGEX.test(name)) continue
    const filePath = accountPath(name)
    const parsed = await readJsonSafe(filePath)
    if (parsed && extractAccountId(parsed) === accountId) {
      return { name, filePath }
    }
  }
  return null
}

/**
 * 把 live auth.json 写回指定槽位
 * @param {string} slot - 槽位文件路径
 * @param {string} reason - 成功原因
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function copyCurrentAuthToSlot(slot, reason) {
  await fsp.mkdir(path.dirname(slot), { recursive: true })
  await atomicCopy(getAuthFile(), slot)
  return { ok: true, reason }
}

/**
 * 把当前 auth.json 同步回原激活槽（保 refresh_token 最新）
 *
 * 规则：current 文件记录的"上次激活账户"存在，且其 account_id 与当前 auth.json 一致
 *       → 把当前 auth.json 覆盖回该槽位
 * current 丢失 / 槽位损坏时：
 *       → 尽量按 current 名或 account_id 修复槽位；仍找不到归属则中止切换
 *
 * V1.6.2 修复 Bug A：所有异常路径返回 `{ok: false, reason}`，不再静默吞错。
 * 调用方必须根据返回值决定是否继续 swap，避免丢失当前账户的最新 refresh_token。
 *
 * @returns {Promise<{ok: boolean, reason: string}>}
 *   - `ok=true`: 同步成功 / 无需同步（无 auth.json / hash 一致 / 槽位已修复）
 *   - `ok=false`: 应该同步但失败了（磁盘/权限/锁等），调用方应中止 swap
 */
async function syncCurrentToActiveSlot() {
  try {
    if (!fs.existsSync(getAuthFile())) return { ok: true, reason: 'no-auth-file' }
    const current = await readCurrentAuth()
    if (!current.accountId) return { ok: true, reason: 'no-account-id' }

    const lastName = await readCurrentName()
    if (lastName && SAFE_NAME_REGEX.test(lastName)) {
      const slot = accountPath(lastName)
      if (!fs.existsSync(slot)) {
        return await copyCurrentAuthToSlot(slot, 'recreated-current-slot')
      }

      const slotParsed = await readJsonSafe(slot)
      if (!slotParsed) {
        return await copyCurrentAuthToSlot(slot, 'repaired-parse-failed-slot')
      }
      const slotAid = extractAccountId(slotParsed)
      if (slotAid && slotAid === current.accountId) {
        const curHash = await hashFile(getAuthFile())
        const slotHash = await hashFile(slot)
        if (curHash === slotHash) return { ok: true, reason: 'already-synced' }
        return await copyCurrentAuthToSlot(slot, 'synced')
      }
    }

    // current 文件丢失或指向了别的账户时，按 account_id 兜底，避免覆盖 live auth 的唯一副本。
    const matchedSlot = await findAccountSlotByAccountId(current.accountId)
    if (matchedSlot) {
      const curHash = await hashFile(getAuthFile())
      const slotHash = await hashFile(matchedSlot.filePath)
      if (curHash === slotHash) return { ok: true, reason: 'already-synced-by-account-id' }
      return await copyCurrentAuthToSlot(matchedSlot.filePath, 'synced-by-account-id')
    }

    return { ok: false, reason: lastName ? 'active-slot-mismatch' : 'active-slot-not-found' }
  } catch (err) {
    return { ok: false, reason: err?.message || 'unknown-error' }
  }
}

/**
 * 检测 Codex.app 是否在运行（仅用于 UI 反馈文案）
 * @returns {Promise<boolean>}
 */
async function isCodexRunning() {
  return codexProcessService.isCodexRunning()
}

/**
 * 打开 Codex.app（供"重新登录失效账户"与重启切换收尾使用）
 */
async function openCodex() {
  return codexProcessService.openCodex()
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
    __setExecFile(fn) { codexProcessService.__INTERNAL__.__setExecFile(fn) },
    __resetExecFile() { codexProcessService.__INTERNAL__.__resetExecFile() },
  },
}
