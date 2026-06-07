/**
 * 账户目录构建器（V1.7）
 *
 * 负责：
 * - 在 ~/.codex-switcher/accounts/{name}/.codex/ 下创建独立 auth.json
 * - 按"必建/可选"规则建 5 个 symlink 指向 shared/.codex/*
 *   · 必建（目录型 skills / sessions / logs）：shared 缺失则 mkdir 空目录后再建
 *   · 可选（文件型 config.toml / mcp_config.json）：shared 不存在则不建（不强制创建空文件）
 * - 首次创建时调一次 `codex --version` 暖 .system（避免后续多账号"首次"撞 install_system_skills 竞态）
 *
 * 依据：
 * - 设计稿 §1.1（目录结构 + symlink 路径）
 * - 设计稿 §10.1（暖 .system）
 * - PRD US-01 步骤 5（必建/可选）
 *
 * symlink 路径恒为相对：`../../../shared/.codex/<name>`
 * （accounts/{name}/.codex/ 距 switcher 根 3 级深）
 *
 * @module electron/services/codexAccountBuilder
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

const accountService = require('./codexAccountService')

const MANDATORY_DIRS = ['skills', 'sessions', 'logs']
const OPTIONAL_FILES = ['config.toml', 'mcp_config.json']

/**
 * 创建账户目录 + symlinks，可选暖 .system
 *
 * @param {string} name - 账户名（合法性校验由调用方负责，本函数不再校验）
 * @param {{
 *   auth: object,                       // auth.json 内容（必填）
 *   state?: object,                     // state.json 内容（可选，默认不写）
 *   warmSystem?: boolean,               // 是否 spawn codex --version 暖 .system，默认 true
 *   spawnTimeoutMs?: number,            // 暖 .system 的超时，默认 10000
 *   logger?: { warn?: Function, info?: Function },
 * }} opts
 * @returns {Promise<{
 *   ok: true,
 *   dir: string,
 *   symlinks: Array<{ name: string, kind: 'mandatory'|'optional', created: boolean, target: string | null }>,
 *   warmed: { attempted: boolean, ok?: boolean, code?: number | null, error?: string }
 * }>}
 */
async function createAccount(name, opts) {
  const result = await buildAccountDir(name, opts)
  let warmed = { attempted: false }
  if (opts.warmSystem !== false) {
    warmed = await warmAccountSystem(name, { timeoutMs: opts.spawnTimeoutMs, logger: opts.logger })
  }
  return { ...result, warmed }
}

/**
 * 仅建目录 + auth.json + symlinks（不暖 .system）
 * 供迁移器批量构建用，避免每个账号 spawn 一次 codex
 */
async function buildAccountDir(name, opts) {
  if (!opts || !opts.auth || typeof opts.auth !== 'object') {
    throw new Error('codexAccountBuilder.buildAccountDir: opts.auth required')
  }
  const I = accountService.__INTERNAL__
  // 支持 override：迁移器把 staging 路径传进来（不走 env CODEX_SWITCHER_HOME）
  const accountHome = opts.accountHome ?? I.getAccountHomeDir(name)
  const sharedDir = opts.sharedDir ?? I.getSharedCodexDir()

  await fsp.mkdir(accountHome, { recursive: true })
  await fsp.writeFile(
    path.join(accountHome, 'auth.json'),
    JSON.stringify(opts.auth, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )
  if (opts.state) {
    await fsp.writeFile(
      path.join(accountHome, 'state.json'),
      JSON.stringify(opts.state, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    )
  }

  const symlinks = []

  // 必建：skills / sessions / logs
  for (const name of MANDATORY_DIRS) {
    const targetAbs = path.join(sharedDir, name)
    if (!fs.existsSync(targetAbs)) {
      await fsp.mkdir(targetAbs, { recursive: true })
    }
    const linkPath = path.join(accountHome, name)
    const relTarget = path.posix.join('..', '..', '..', 'shared', '.codex', name)
    const created = await safeSymlink(relTarget, linkPath)
    symlinks.push({ name, kind: 'mandatory', created, target: relTarget })
  }

  // 可选：config.toml / mcp_config.json
  for (const name of OPTIONAL_FILES) {
    const targetAbs = path.join(sharedDir, name)
    if (!fs.existsSync(targetAbs)) {
      symlinks.push({ name, kind: 'optional', created: false, target: null })
      continue
    }
    const linkPath = path.join(accountHome, name)
    const relTarget = path.posix.join('..', '..', '..', 'shared', '.codex', name)
    const created = await safeSymlink(relTarget, linkPath)
    symlinks.push({ name, kind: 'optional', created, target: relTarget })
  }

  return { ok: true, dir: accountHome, symlinks }
}

/**
 * spawn codex --version 暖一次 .system（best-effort，失败不抛错）
 *
 * @param {string} name
 * @param {{ timeoutMs?: number, logger?: { warn?: Function, info?: Function } }} [opts]
 * @returns {Promise<{ attempted: true, ok: boolean, code: number | null, error?: string }>}
 */
async function warmAccountSystem(name, opts = {}) {
  const I = accountService.__INTERNAL__
  const home = I.getAccountHomeDir(name)
  const timeoutMs = opts.timeoutMs ?? 10000
  const logger = opts.logger ?? console

  return new Promise((resolve) => {
    let child
    try {
      child = spawn('codex', ['--version'], {
        env: { ...process.env, CODEX_HOME: home },
        stdio: 'ignore',
      })
    } catch (err) {
      const msg = `warm .system spawn failed: ${err.message}`
      logger.warn?.(`[codexAccountBuilder] ${msg}`)
      resolve({ attempted: true, ok: false, code: null, error: msg })
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      const msg = `warm .system timeout (>${timeoutMs}ms)`
      logger.warn?.(`[codexAccountBuilder] ${msg}`)
      resolve({ attempted: true, ok: false, code: null, error: msg })
    }, timeoutMs)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const msg = `warm .system error: ${err.message}`
      logger.warn?.(`[codexAccountBuilder] ${msg}`)
      resolve({ attempted: true, ok: false, code: null, error: msg })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ attempted: true, ok: code === 0, code })
    })
  })
}

async function safeSymlink(target, linkPath) {
  try {
    await fsp.symlink(target, linkPath)
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    // V1.7 P1-7 修复：EEXIST 不再静默返 false——读 lstat 看是否已是正确 symlink
    // - 正确 symlink 指向 target → 视为已就绪（true，幂等）
    // - 错误 target / 普通文件 → unlink 重建
    try {
      const lst = await fsp.lstat(linkPath)
      if (lst.isSymbolicLink()) {
        const existing = await fsp.readlink(linkPath)
        if (existing === target) return true
      }
      await fsp.unlink(linkPath)
      await fsp.symlink(target, linkPath)
      return true
    } catch (innerErr) {
      // 重建失败 → 不抛，返 false 让调用方知道
      return false
    }
  }
}

module.exports = {
  createAccount,
  buildAccountDir,
  warmAccountSystem,
  MANDATORY_DIRS,
  OPTIONAL_FILES,
}
