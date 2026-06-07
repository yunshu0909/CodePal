/**
 * V1.6 → V1.7 数据迁移器
 *
 * 核心承诺：
 * 1. **永不删用户数据**：任一步失败 → 保留 staging + 旧 ~/.codex-switcher/ + 旧 ~/.codex/auth.json 原封不动 + 写 migration-failed.log
 * 2. **原子切换**：两次 atomic rename（旧 switcher → legacy-backup + staging → switcher）后才搬 quarantine
 * 3. **覆盖匹配 slot**：live ~/.codex/auth.json 含最新 refresh_token；若与某 slot 同 account_id，则用 live 完整覆盖该 slot 的 auth.json（防止"迁移完当前账号反而拿旧票死号"）
 *
 * 流程（设计稿 §3.2）：
 *   Step 1  确认需要迁移（active.json 不存在）
 *   Step 2  创建 staging dir
 *   Step 3  复制 ~/.codex/ 非 auth 内容到 staging/shared/.codex/
 *   Step 4  读 V1.6 副本列表 + 处理重名（按 mtime 较新者保留，旧者后缀 -dedup-<ts>）
 *   Step 5  对每个副本：在 staging 上下文调用 buildAccountDir（不暖 .system，最后再统一暖）
 *   Step 6  读 live ~/.codex/auth.json，按 account_id 匹配 slot：
 *           命中 → 用 live 完整内容覆盖 staging/accounts/X/.codex/auth.json，设为 active
 *           未命中（live 有效） → 新建 imported-from-legacy 槽位，设为 active
 *           live 不存在/损坏 → currentAccount=null（全新用户场景）
 *   Step 7  写 staging/active.json
 *   Step 8  validateStaging（必建 symlink 可解析 + auth.json JSON 合法）
 *   Step 9  两次 atomic rename
 *   Step 10 quarantine：把 ~/.codex/auth.json 搬到 ~/.codex.legacy-backup-<ts>/auth.json
 *   Step 11 写 migration.log
 *
 * @module electron/services/codexMigrator
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const accountService = require('./codexAccountService')
const codexAccountBuilder = require('./codexAccountBuilder')
const { decodeJwtPayload } = require('./codexJwtUtils')

// 用 fs/promises 而不是 fs.renameSync —— 让测试可以 vi.spyOn(require('node:fs/promises'), 'rename')

/**
 * 是否需要迁移（V1.7 首次启动）
 * @returns {boolean}
 */
function shouldMigrate() {
  const I = accountService.__INTERNAL__
  return !fs.existsSync(I.getActiveJsonFile())
}

/**
 * 跑迁移
 *
 * @param {{
 *   now?: number,
 *   logger?: { warn?: Function, info?: Function, error?: Function },
 * }} [opts]
 * @returns {Promise<
 *   | { ok: true, stagingPath: string, switcherPath: string, accounts: string[], active: string | null }
 *   | { ok: false, stage: string, error: { code?: string, message: string } }
 * >}
 */
async function runMigration(opts = {}) {
  const I = accountService.__INTERNAL__
  const logger = opts.logger ?? console
  const now = opts.now ?? Date.now()
  const ts = String(now)

  const fakeHomeDir = I.getFakeHomeDir()
  const legacySwitcherPath = I.getStoreDir() // ~/.codex-switcher 或 env override
  const legacyCodexDir = I.getCodexDir() // ~/.codex
  const legacyAuthFile = I.getAuthFile() // ~/.codex/auth.json
  const stagingPath = `${legacySwitcherPath}.v1.7-staging-${ts}`
  const switcherBackupPath = `${legacySwitcherPath}.legacy-backup-${ts}`
  const codexBackupPath = path.join(fakeHomeDir, `.codex.legacy-backup-${ts}`)

  let stage = 'init'
  const audit = { accounts: [], dedup: [], notes: [] }

  try {
    stage = 'shouldMigrate'
    if (!shouldMigrate()) {
      return { ok: false, stage, error: { code: 'ALREADY_MIGRATED', message: 'active.json exists; migration already done' } }
    }

    // ─── Step 2: staging dir ───
    stage = 'staging-mkdir'
    await fsp.mkdir(stagingPath, { recursive: true })
    const stagingSharedDir = path.join(stagingPath, 'shared', '.codex')
    const stagingAccountsDir = path.join(stagingPath, 'accounts')
    await fsp.mkdir(stagingSharedDir, { recursive: true })
    await fsp.mkdir(stagingAccountsDir, { recursive: true })

    // ─── Step 3: 复制 ~/.codex/ 非 auth 内容 ───
    stage = 'copy-shared'
    if (fs.existsSync(legacyCodexDir)) {
      await copyNonAuthAssets(legacyCodexDir, stagingSharedDir, logger)
    }

    // ─── Step 4: 读 V1.6 副本列表 + dedup ───
    stage = 'read-slots'
    const legacyAccountsDir = path.join(legacySwitcherPath, 'accounts')
    const slots = await readLegacySlots(legacyAccountsDir, audit, logger, ts)

    // ─── Step 5: 在 staging 上下文 build 每个 account ───
    stage = 'build-accounts'
    for (const slot of slots) {
      const accountHome = path.join(stagingAccountsDir, slot.name, '.codex')
      await codexAccountBuilder.buildAccountDir(slot.name, {
        auth: slot.auth,
        accountHome,
        sharedDir: stagingSharedDir,
      })
      audit.accounts.push(slot.name)
    }

    // ─── Step 6: 读 live auth.json，匹配 slot ───
    stage = 'live-auth-match'
    let active = null
    let liveAuth = null
    if (fs.existsSync(legacyAuthFile)) {
      try {
        liveAuth = JSON.parse(await fsp.readFile(legacyAuthFile, 'utf8'))
      } catch (err) {
        logger.warn?.(`[codexMigrator] live auth.json 解析失败，跳过激活账号识别: ${err.message}`)
        audit.notes.push('live-auth-corrupt')
      }
    }
    if (liveAuth) {
      const liveAccountId = liveAuth?.tokens?.account_id
      const matchedSlot = liveAccountId ? slots.find((s) => s.auth?.tokens?.account_id === liveAccountId) : null
      if (matchedSlot) {
        // V1.7 P1-3 修复：取 iat 较新的一份写入 staging slot，防止用旧 live 覆盖更新的 slot
        const liveIat = safeIatFromAuth(liveAuth)
        const slotIat = safeIatFromAuth(matchedSlot.auth)
        const winner = (slotIat ?? 0) > (liveIat ?? 0) ? matchedSlot.auth : liveAuth
        const winnerSource = winner === liveAuth ? 'live' : 'slot'
        const targetAuthPath = path.join(stagingAccountsDir, matchedSlot.name, '.codex', 'auth.json')
        await fsp.writeFile(targetAuthPath, JSON.stringify(winner, null, 2), { encoding: 'utf8', mode: 0o600 })
        active = matchedSlot.name
        audit.notes.push(`live-match-slot:${matchedSlot.name}:winner=${winnerSource}:liveIat=${liveIat ?? 'null'}:slotIat=${slotIat ?? 'null'}`)
      } else {
        const importedName = 'imported-from-legacy'
        const importedHome = path.join(stagingAccountsDir, importedName, '.codex')
        await codexAccountBuilder.buildAccountDir(importedName, {
          auth: liveAuth,
          accountHome: importedHome,
          sharedDir: stagingSharedDir,
        })
        audit.accounts.push(importedName)
        active = importedName
        audit.notes.push('live-imported-as-new-slot')
      }
    } else if (slots.length > 0) {
      // 没 live auth，但有副本 → currentAccount=null，让用户手动激活（设计稿 §3.2 异常处理）
      active = null
      audit.notes.push('no-live-auth-multiple-slots')
    } else {
      active = null
      audit.notes.push('fresh-install')
    }

    // ─── Step 7: 写 active.json ───
    stage = 'write-active'
    await fsp.writeFile(
      path.join(stagingPath, 'active.json'),
      JSON.stringify({
        currentAccount: active,
        version: 'v1.7',
        migratedAt: new Date(now).toISOString(),
      }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    )

    // ─── Step 8: validateStaging ───
    stage = 'validate-staging'
    const validation = await validateStaging(stagingPath)
    if (!validation.ok) {
      // 不删 staging（永不删）
      await writeFailedLog(legacySwitcherPath, stage, validation, audit, logger)
      return { ok: false, stage, error: { code: 'VALIDATION_FAILED', message: `broken: ${validation.brokenLink ?? validation.reason}` } }
    }

    // ─── Step 9: 两次 atomic rename + EXDEV cp 兜底 ───
    // (a) 旧 switcher → switcher-backup
    stage = 'rename-old-switcher'
    if (fs.existsSync(legacySwitcherPath)) {
      await fsp.rename(legacySwitcherPath, switcherBackupPath)
    }
    // (b) staging → switcher
    // V1.7 P1-4：EXDEV（跨盘）兜底——同盘 rename 失败则降级为 cp + rm；
    // cp 失败再尝试回滚 backup 到 origin（保证用户视角不丢账号）
    stage = 'rename-staging-to-switcher'
    try {
      await fsp.rename(stagingPath, legacySwitcherPath)
    } catch (err) {
      if (err.code === 'EXDEV') {
        try {
          await fsp.cp(stagingPath, legacySwitcherPath, { recursive: true, dereference: false, preserveTimestamps: true })
          await fsp.rm(stagingPath, { recursive: true, force: true })
          audit.notes.push('rename-staging-fallback-cp-due-to-EXDEV')
        } catch (cpErr) {
          // 兜底也失败 → 把 backup rename 回 origin，保用户数据视角
          await rollbackBackup(legacySwitcherPath, switcherBackupPath, audit, logger)
          throw cpErr
        }
      } else {
        // 非 EXDEV → 把 backup rename 回 origin
        await rollbackBackup(legacySwitcherPath, switcherBackupPath, audit, logger)
        throw err
      }
    }

    // ─── Step 10: quarantine ~/.codex/auth.json ───
    stage = 'quarantine-live-auth'
    if (fs.existsSync(legacyAuthFile)) {
      await fsp.mkdir(codexBackupPath, { recursive: true })
      await fsp.rename(legacyAuthFile, path.join(codexBackupPath, 'auth.json'))
    }

    // ─── Step 11: 写 migration.log ───
    stage = 'write-log'
    await fsp.writeFile(
      path.join(legacySwitcherPath, 'migration.log'),
      JSON.stringify(
        {
          ok: true,
          startedAt: new Date(now).toISOString(),
          finishedAt: new Date().toISOString(),
          accounts: audit.accounts,
          active,
          dedup: audit.dedup,
          notes: audit.notes,
          legacyBackups: {
            switcher: switcherBackupPath,
            codex: codexBackupPath,
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    return {
      ok: true,
      stagingPath: legacySwitcherPath,
      switcherPath: legacySwitcherPath,
      accounts: audit.accounts,
      active,
    }
  } catch (err) {
    // 永不删：写 migration-failed.log，保留 staging
    await writeFailedLog(legacySwitcherPath, stage, { error: err }, audit, logger)
    return {
      ok: false,
      stage,
      error: { code: err.code ?? 'UNKNOWN', message: err.message },
    }
  }
}

/**
 * 校验 staging 完整性
 *
 * 规则：
 * - 必建 symlink（skills / sessions / logs）每个账号都必须存在且 lstat 为 symlink 且 readlink 可解析（指向 staging/shared/.codex 内的目录）
 * - 可选 symlink（config.toml / mcp_config.json）允许缺失
 * - 每个 auth.json 必须 JSON.parse 成功且含 tokens.refresh_token
 * - active.json 必须 JSON.parse 成功且 currentAccount 指向已存在的账号或为 null
 *
 * @param {string} stagingPath
 * @returns {Promise<
 *   | { ok: true }
 *   | { ok: false, brokenLink?: string, reason?: string }
 * >}
 */
async function validateStaging(stagingPath) {
  const stagingAccountsDir = path.join(stagingPath, 'accounts')
  const stagingShared = path.join(stagingPath, 'shared', '.codex')
  if (!fs.existsSync(stagingShared)) return { ok: false, reason: 'shared-missing' }

  const mandatory = ['skills', 'sessions', 'logs']

  let entries
  try { entries = await fsp.readdir(stagingAccountsDir, { withFileTypes: true }) } catch {
    entries = []
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const home = path.join(stagingAccountsDir, ent.name, '.codex')
    // auth.json
    let authObj
    try { authObj = JSON.parse(await fsp.readFile(path.join(home, 'auth.json'), 'utf8')) } catch {
      return { ok: false, brokenLink: path.join(home, 'auth.json'), reason: 'auth-corrupt' }
    }
    if (!authObj?.tokens?.refresh_token) {
      return { ok: false, brokenLink: path.join(home, 'auth.json'), reason: 'auth-missing-refresh-token' }
    }
    // 必建 symlinks
    for (const name of mandatory) {
      const linkPath = path.join(home, name)
      let lst
      try { lst = await fsp.lstat(linkPath) } catch { return { ok: false, brokenLink: linkPath, reason: 'symlink-missing' } }
      if (!lst.isSymbolicLink()) return { ok: false, brokenLink: linkPath, reason: 'not-a-symlink' }
      try { await fsp.stat(linkPath) } catch { return { ok: false, brokenLink: linkPath, reason: 'symlink-dangling' } }
    }
  }

  // active.json
  const activePath = path.join(stagingPath, 'active.json')
  let active
  try { active = JSON.parse(await fsp.readFile(activePath, 'utf8')) } catch {
    return { ok: false, reason: 'active-json-corrupt' }
  }
  if (active.currentAccount !== null && active.currentAccount !== undefined) {
    const accountHome = path.join(stagingAccountsDir, active.currentAccount, '.codex')
    if (!fs.existsSync(accountHome)) {
      return { ok: false, reason: `active-references-nonexistent:${active.currentAccount}` }
    }
  }

  return { ok: true }
}

// V1.7 P1-8 黑名单：auth.json 及其衍生（tmp / recovery）+ codepal 内部簿记
const COPY_BLACKLIST_PATTERNS = [
  /^auth\.json$/,
  /^auth\.json\.tmp-/,
  /^auth\.json\.recovery-/,
  /^\.codepal-/, // 任何 CodePal 自己写的内部 marker
]

function isCopyBlacklisted(name) {
  return COPY_BLACKLIST_PATTERNS.some((re) => re.test(name))
}

async function copyNonAuthAssets(srcDir, dstDir, logger) {
  let entries
  try { entries = await fsp.readdir(srcDir, { withFileTypes: true }) } catch { return }
  await fsp.mkdir(dstDir, { recursive: true })
  for (const ent of entries) {
    if (isCopyBlacklisted(ent.name)) continue
    const src = path.join(srcDir, ent.name)
    const dst = path.join(dstDir, ent.name)
    try {
      if (ent.isDirectory()) {
        await fsp.cp(src, dst, { recursive: true, dereference: false })
      } else if (ent.isFile()) {
        await fsp.copyFile(src, dst)
      } else if (ent.isSymbolicLink()) {
        const t = await fsp.readlink(src)
        await fsp.symlink(t, dst)
      }
    } catch (err) {
      logger.warn?.(`[codexMigrator] copy ${ent.name} 失败：${err.message}`)
    }
  }
}

async function readLegacySlots(legacyAccountsDir, audit, logger, ts) {
  if (!fs.existsSync(legacyAccountsDir)) return []
  const entries = await fsp.readdir(legacyAccountsDir, { withFileTypes: true })
  // 第一遍：读所有 *.json
  const raw = []
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue
    const slotName = ent.name.replace(/\.json$/, '')
    const fullPath = path.join(legacyAccountsDir, ent.name)
    try {
      const buf = await fsp.readFile(fullPath, 'utf8')
      const auth = JSON.parse(buf)
      const stat = await fsp.stat(fullPath)
      raw.push({ name: slotName, auth, mtimeMs: stat.mtimeMs })
    } catch (err) {
      logger.warn?.(`[codexMigrator] slot ${slotName} 解析失败，跳过：${err.message}`)
    }
  }
  // 按 account_id dedup：同 account_id 多份 → mtime 较新者保留，旧者重命名（写入 audit）
  const byId = new Map()
  for (const slot of raw) {
    const id = slot.auth?.tokens?.account_id
    if (!id) {
      byId.set(`__noid__${slot.name}`, slot)
      continue
    }
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, slot)
    } else if (slot.mtimeMs > existing.mtimeMs) {
      audit.dedup.push({ kept: slot.name, demoted: existing.name, accountId: id })
      existing.name = `${existing.name}-dedup-${ts}`
      byId.set(id, slot)
      // existing 仍然要被 migrate（保留账号不丢），只是改个名（"demoted"）
      byId.set(`__demoted__${existing.name}`, existing)
    } else {
      audit.dedup.push({ kept: existing.name, demoted: slot.name, accountId: id })
      slot.name = `${slot.name}-dedup-${ts}`
      byId.set(`__demoted__${slot.name}`, slot)
    }
  }
  return Array.from(byId.values())
}

async function rollbackBackup(legacySwitcherPath, switcherBackupPath, audit, logger) {
  if (!fs.existsSync(switcherBackupPath)) return
  try {
    await fsp.rename(switcherBackupPath, legacySwitcherPath)
    audit.notes.push('rollback-backup-restored')
  } catch (err) {
    logger.error?.(`[codexMigrator] 回滚 backup 失败，用户数据仍在 ${switcherBackupPath}：${err.message}`)
    audit.notes.push(`rollback-failed:${err.code || err.message}`)
  }
}

function safeIatFromAuth(auth) {
  const accessToken = auth?.tokens?.access_token
  if (typeof accessToken !== 'string') return null
  try {
    const payload = decodeJwtPayload(accessToken)
    return typeof payload.iat === 'number' ? payload.iat : null
  } catch { return null }
}

async function writeFailedLog(switcherDir, stage, info, audit, logger) {
  try {
    // 旧 switcher 可能不存在（fresh install）；尝试写到 fake home
    let logDir = switcherDir
    if (!fs.existsSync(switcherDir)) {
      const I = accountService.__INTERNAL__
      logDir = I.getFakeHomeDir()
    }
    await fsp.mkdir(logDir, { recursive: true })
    const failedLog = path.join(logDir, 'migration-failed.log')
    const payload = {
      ok: false,
      stage,
      timestamp: new Date().toISOString(),
      audit,
      error: info?.error ? {
        code: info.error.code,
        message: info.error.message,
        stack: info.error.stack,
      } : null,
      validation: info?.brokenLink || info?.reason ? { brokenLink: info.brokenLink, reason: info.reason } : null,
    }
    await fsp.writeFile(failedLog, JSON.stringify(payload, null, 2), 'utf8')
  } catch (err) {
    logger.error?.(`[codexMigrator] failed to write migration-failed.log: ${err.message}`)
  }
}

/**
 * 把 accounts/ 顶层遗留的 V1.6 单文件账号（<name>.json）升级到 V1.7 目录格式（<name>/.codex/auth.json）
 *
 * 触发原因：V1.7 listSavedAccountsV17 只扫目录，旧 .json 单文件账号会"隐身" → UI 看不到、用户以为账号丢了。
 *
 * @param {{ logger?: object, now?: number }} [opts]
 * @returns {Promise<{ upgraded: string[], conflicts: { name: string, reason: string }[] }>}
 */
async function upgradeV16ResidueAccounts(opts = {}) {
  const I = accountService.__INTERNAL__
  const logger = opts.logger ?? console
  const now = opts.now ?? Date.now()
  const accountsDir = I.getAccountsDir()
  const upgraded = []
  const conflicts = []

  if (!fs.existsSync(accountsDir)) return { upgraded, conflicts }

  let entries
  try {
    entries = await fsp.readdir(accountsDir, { withFileTypes: true })
  } catch (err) {
    logger.warn?.(`[codexMigrator] residue scan failed: ${err.message}`)
    return { upgraded, conflicts }
  }

  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (ent.name.startsWith('.')) continue
    if (!ent.name.endsWith('.json')) continue
    const name = ent.name.slice(0, -5)
    if (!name) continue

    const jsonPath = path.join(accountsDir, ent.name)
    const dirPath = path.join(accountsDir, name)
    const targetCodexDir = I.getAccountHomeDir(name)
    const targetAuthFile = path.join(targetCodexDir, 'auth.json')

    if (fs.existsSync(dirPath)) {
      const conflictName = `${ent.name}.conflict-${now}`
      try {
        await fsp.rename(jsonPath, path.join(accountsDir, conflictName))
        logger.warn?.(`[codexMigrator] residue conflict: ${ent.name} → ${conflictName} (dir exists)`)
        conflicts.push({ name, reason: 'directory-already-exists' })
      } catch (err) {
        logger.warn?.(`[codexMigrator] residue conflict isolation failed: ${ent.name}: ${err.message}`)
        conflicts.push({ name, reason: `isolation-failed: ${err.message}` })
      }
      continue
    }

    try {
      await fsp.mkdir(targetCodexDir, { recursive: true })
      await fsp.rename(jsonPath, targetAuthFile)
      logger.info?.(`[codexMigrator] residue upgraded: ${ent.name} → ${name}/.codex/auth.json`)
      upgraded.push(name)
    } catch (err) {
      logger.warn?.(`[codexMigrator] residue upgrade failed: ${ent.name}: ${err.message}`)
      conflicts.push({ name, reason: `upgrade-failed: ${err.message}` })
    }
  }

  return { upgraded, conflicts }
}

module.exports = {
  shouldMigrate,
  runMigration,
  validateStaging,
  upgradeV16ResidueAccounts,
  // 供测试 hook
  __INTERNAL__: {
    readLegacySlots,
    copyNonAuthAssets,
  },
}
