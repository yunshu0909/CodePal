/**
 * Symlink 完整性检查与自愈（V1.7）
 *
 * 负责：
 * - 启动时遍历所有 account 目录、检查 5 个 symlink 是否完整
 * - 缺失（文件不存在）→ 直接重建
 * - 是普通文件（被某次写入破坏成实文件）→ 备份到 .conflict-backup 后重建 symlink，记录冲突警告
 * - 是 symlink 但 target 不可解析 → 重建
 *
 * 依据：
 * - 设计稿 §10.2 symlink 完整性检查
 * - PRD US-08 验收场景 3 自愈
 *
 * @module electron/services/codexSymlinkIntegrity
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const accountService = require('./codexAccountService')

const SYMLINK_RULES = [
  { name: 'config.toml', kind: 'optional' },
  { name: 'skills', kind: 'mandatory' },
  { name: 'sessions', kind: 'mandatory' },
  { name: 'logs', kind: 'mandatory' },
  { name: 'mcp_config.json', kind: 'optional' },
]

/**
 * 检查一个账户目录的 symlink 完整性，按需自愈
 *
 * @param {string} accountName
 * @param {{ logger?: { warn?: Function, info?: Function } }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   repaired: string[],
 *   conflict: string[],
 *   skipped: string[],
 *   error?: string
 * }>}
 */
async function verifyAccountIntegrity(accountName, opts = {}) {
  const I = accountService.__INTERNAL__
  const home = I.getAccountHomeDir(accountName)
  const sharedDir = I.getSharedCodexDir()
  const logger = opts.logger ?? console

  if (!fs.existsSync(home)) {
    return { ok: false, repaired: [], conflict: [], skipped: [], error: 'ACCOUNT_DIR_MISSING' }
  }

  const repaired = []
  const conflict = []
  const skipped = []

  for (const rule of SYMLINK_RULES) {
    const linkPath = path.join(home, rule.name)
    const sharedTarget = path.join(sharedDir, rule.name)
    const relTarget = path.posix.join('..', '..', '..', 'shared', '.codex', rule.name)

    let lst
    try { lst = fs.lstatSync(linkPath) } catch (err) {
      if (err.code !== 'ENOENT') {
        return { ok: false, repaired, conflict, skipped, error: `LSTAT_FAILED:${rule.name}:${err.code}` }
      }
      lst = null
    }

    // case 1: 路径不存在
    if (lst === null) {
      if (rule.kind === 'optional' && !fs.existsSync(sharedTarget)) {
        skipped.push(rule.name)
        continue
      }
      // 必建（哪怕 shared 不存在也要先 mkdir 再建）
      if (!fs.existsSync(sharedTarget)) {
        if (rule.kind === 'mandatory') {
          await fsp.mkdir(sharedTarget, { recursive: true })
        }
      }
      await fsp.symlink(relTarget, linkPath)
      repaired.push(rule.name)
      continue
    }

    // case 2: 已经是 symlink
    if (lst.isSymbolicLink()) {
      // 验证可解析
      try {
        await fsp.stat(linkPath)
        skipped.push(rule.name) // 完好
        continue
      } catch {
        // dangling symlink，重建
        if (rule.kind === 'mandatory' && !fs.existsSync(sharedTarget)) {
          await fsp.mkdir(sharedTarget, { recursive: true })
        }
        await fsp.unlink(linkPath)
        if (rule.kind === 'optional' && !fs.existsSync(sharedTarget)) {
          // 可选项：target 也不存在 → 让它继续缺，不强制
          skipped.push(rule.name)
          continue
        }
        await fsp.symlink(relTarget, linkPath)
        repaired.push(rule.name)
        continue
      }
    }

    // case 3: 是普通文件 / 目录（被破坏了 symlink）
    const ts = Date.now()
    const conflictBackup = path.join(home, `${rule.name}.conflict-backup-${ts}-${crypto.randomBytes(3).toString('hex')}`)
    try {
      await fsp.rename(linkPath, conflictBackup)
    } catch (err) {
      return { ok: false, repaired, conflict, skipped, error: `BACKUP_FAILED:${rule.name}:${err.code || err.message}` }
    }
    logger.warn?.(
      `[codexSymlinkIntegrity] account ${accountName} 的 ${rule.name} 是普通文件，备份到 ${path.basename(conflictBackup)} 后重建 symlink`,
    )
    if (rule.kind === 'mandatory' && !fs.existsSync(sharedTarget)) {
      await fsp.mkdir(sharedTarget, { recursive: true })
    }
    if (rule.kind === 'optional' && !fs.existsSync(sharedTarget)) {
      // 可选项被破坏成文件，shared 又不存在；恢复策略：
      // 把 conflict-backup 的内容拷回 shared 作为 canonical，再建 symlink
      try {
        await fsp.copyFile(conflictBackup, sharedTarget)
      } catch (err) {
        // V1.7 P1-5 修复：copyFile 失败 → 把 conflict-backup 搬回 linkPath，恢复用户数据
        try {
          await fsp.rename(conflictBackup, linkPath)
        } catch (rollbackErr) {
          logger.warn?.(
            `[codexSymlinkIntegrity] 致命：copyFile + rollback 双失败，用户数据停留在 ${conflictBackup}（copyFile=${err.message}, rollback=${rollbackErr.message}）`,
          )
        }
        return { ok: false, repaired, conflict, skipped, error: `RESTORE_FAILED:${rule.name}:${err.code || err.message}` }
      }
    }
    try {
      await fsp.symlink(relTarget, linkPath)
    } catch (linkErr) {
      // symlink 也失败 → 把 conflict-backup 搬回（如果 copyFile 已 succeed 不影响 shared，回滚是好的）
      try { await fsp.rename(conflictBackup, linkPath) } catch {}
      return { ok: false, repaired, conflict, skipped, error: `SYMLINK_RECREATE_FAILED:${rule.name}:${linkErr.code || linkErr.message}` }
    }
    repaired.push(rule.name)
    conflict.push(rule.name)
  }

  return { ok: true, repaired, conflict, skipped }
}

/**
 * 启动时跑一遍所有账户
 *
 * @param {{ logger?: object }} [opts]
 * @returns {Promise<Record<string, ReturnType<verifyAccountIntegrity>>>}
 */
async function verifyAllAccounts(opts = {}) {
  const I = accountService.__INTERNAL__
  const accountsDir = I.getAccountsDir()
  if (!fs.existsSync(accountsDir)) return {}
  const entries = await fsp.readdir(accountsDir, { withFileTypes: true })
  const report = {}
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    report[ent.name] = await verifyAccountIntegrity(ent.name, opts)
  }
  return report
}

module.exports = {
  verifyAccountIntegrity,
  verifyAllAccounts,
  SYMLINK_RULES,
}
