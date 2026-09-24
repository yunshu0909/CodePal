/**
 * 隐藏 MCP 下线后的一次性清理：移除旧版本写进用户配置的 provider_registry
 *
 * 负责：
 * - ~/.codex/config.toml：经 Codex 配置负责人（同一把锁、保格式）删掉 [mcp_servers.provider_registry] 及其子表
 * - ~/.claude.json：删掉 mcpServers.provider_registry；只有整份 JSON 能无损重写时才改（Claude Code 自己频繁写这个文件）；
 *   是软链接时改真实文件、保留链接
 * - 改之前先把原文可靠地备份到 *.codepal-mcp-cleanup-<时间>.bak，备份失败就不改
 * - 只动确认属于 CodePal 的条目：args 里指向 …/mcp/provider_registry_mcp.js；同名但指向别处的不动
 * - 两处都到达终态（已删 / 不存在 / 不属于我们）后记为完成，只跑一次；冲突或出错下次启动再试
 *
 * 背景：MCP 管理页早已隐藏，旧版本每次启动仍补写该条目，每个 Claude / Codex 会话都在加载它（架构优化路线 2）。
 *
 * @module electron/services/legacyMcpCleanup
 */

const fs = require('fs/promises')
const path = require('path')
const { removeTable } = require('./tomlSafeEdit')
const { withConfigLock, commitConfigUnlocked, finalizeBackup } = require('./codexConfigOwner')

const STORE_KEY = 'migrations.legacyProviderRegistryCleanup'
const SCRIPT_PATTERN = /[\\/]mcp[\\/]provider_registry_mcp\.js$/

/**
 * 条目是否属于 CodePal（由旧版本内置安装写入）
 * @param {object} entry - MCP 配置项
 * @returns {boolean}
 */
function isOwnedEntry(entry) {
  return Boolean(entry) && Array.isArray(entry.args) && entry.args.some((arg) => typeof arg === 'string' && SCRIPT_PATTERN.test(arg))
}

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

/**
 * 清理 Codex 配置里的条目
 * @param {string} homeDir
 * @returns {Promise<'removed'|'absent'|'not-owned'|'conflict'|'unsupported'|'error'>}
 */
async function cleanupCodex(homeDir, suffix) {
  const configPath = path.join(homeDir, '.codex', 'config.toml')
  let status = 'absent'
  try {
    await withConfigLock(async () => {
      const committed = await commitConfigUnlocked(configPath, (text) => {
        const result = removeTable(text, ['mcp_servers', 'provider_registry'], {
          match: isOwnedEntry,
          invalidCode: 'CODEX_CONFIG_INVALID',
          unsupportedCode: 'CODEX_CONFIG_UNSUPPORTED',
        })
        status = !result.found ? 'absent' : result.matched ? 'removed' : 'not-owned'
        return result
      }, {}, { durableBackupPath: (target) => `${target}.codepal-mcp-cleanup-${suffix}.bak` })
      await finalizeBackup(committed)
    })
    return status
  } catch (error) {
    if (error.code === 'CODEX_CONFIG_CONFLICT') return 'conflict'
    if (error.code === 'CODEX_CONFIG_UNSUPPORTED' || error.code === 'CODEX_CONFIG_INVALID') return 'unsupported'
    return 'error'
  }
}

/**
 * 读 ~/.claude.json 当前状态：是软链接（dotfiles）就跟到真实文件，链接本身保留；悬空链接无法判断意图
 * @param {string} filePath
 * @returns {Promise<{exists: boolean, link: string|null, target: string, text: string, ino: number|null, mode: number}>}
 */
async function snapshotJson(filePath) {
  let link = null
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) link = await fs.readlink(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, link: null, target: filePath, text: '', ino: null, mode: 0o600 }
    throw error
  }
  let target = filePath
  if (link !== null) {
    try { target = await fs.realpath(filePath) } catch (error) {
      if (error.code === 'ENOENT') throw codedError('DANGLING_LINK')
      throw error
    }
  }
  const stat = await fs.stat(target)
  return { exists: true, link, target, text: await fs.readFile(target, 'utf8'), ino: stat.ino, mode: stat.mode & 0o777 }
}

/**
 * 写临时文件（独占创建、设权限），出错自清
 * @returns {Promise<string>}
 */
async function writeTemp(target, text, mode) {
  const tempPath = `${target}.codepal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fs.writeFile(tempPath, text, { mode, flag: 'wx' })
    await fs.chmod(tempPath, mode)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
  return tempPath
}

/**
 * 清理 ~/.claude.json 里的条目（一次尝试）
 * @param {string} filePath
 * @param {object} deps - beforeClaudeJsonCommit 仅测试用
 * @returns {Promise<'removed'|'absent'|'not-owned'|'skipped-format'>}
 * @throws {Error} code=CONFLICT 提交前被外部改过
 */
async function cleanupClaudeJsonOnce(filePath, deps, suffix) {
  let before
  try { before = await snapshotJson(filePath) } catch (error) {
    if (error.code === 'DANGLING_LINK') return 'skipped-format'
    throw error
  }
  if (!before.exists) return 'absent'
  let doc
  try { doc = JSON.parse(before.text) } catch { return 'skipped-format' }
  const servers = doc?.mcpServers
  if (!servers || typeof servers !== 'object' || !Object.prototype.hasOwnProperty.call(servers, 'provider_registry')) return 'absent'
  if (!isOwnedEntry(servers.provider_registry)) return 'not-owned'
  // 只有「整份重新序列化 == 原文」时才改，保证除了这一项其余字节不变
  const trailing = before.text.endsWith('\n') ? '\n' : ''
  if (JSON.stringify(doc, null, 2) + trailing !== before.text) return 'skipped-format'
  delete servers.provider_registry
  const next = JSON.stringify(doc, null, 2) + trailing

  // 先把备份落稳（带时间戳，不覆盖任何旧备份）；失败直接放弃，文件还没动
  const backupPath = `${before.target}.codepal-mcp-cleanup-${suffix}.bak`
  const backupTemp = await writeTemp(backupPath, before.text, before.mode)
  try {
    await fs.rename(backupTemp, backupPath)
  } catch (error) {
    await fs.rm(backupTemp, { force: true }).catch(() => {})
    throw codedError('BACKUP_FAILED')
  }
  let newTemp = null
  try {
    newTemp = await writeTemp(before.target, next, before.mode)
    if (deps.beforeClaudeJsonCommit) await deps.beforeClaudeJsonCommit(filePath)
    const now = await snapshotJson(filePath)
    const same = now.exists && now.link === before.link && now.target === before.target && now.text === before.text && now.ino === before.ino
    if (!same) throw codedError('CONFLICT')
    await fs.rename(newTemp, before.target)
    newTemp = null
    return 'removed'
  } catch (error) {
    if (newTemp) await fs.rm(newTemp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 清理 ~/.claude.json（冲突时短暂重试：Claude Code 运行中也会写这个文件）
 * @returns {Promise<'removed'|'absent'|'not-owned'|'skipped-format'|'conflict'|'error'>}
 */
async function cleanupClaudeJson(homeDir, deps = {}, suffix) {
  const filePath = path.join(homeDir, '.claude.json')
  const attempts = deps.maxAttempts || 3
  for (let i = 0; i < attempts; i++) {
    try {
      return await cleanupClaudeJsonOnce(filePath, deps, suffix)
    } catch (error) {
      if (error.code !== 'CONFLICT') return 'error'
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  return 'conflict'
}

const TERMINAL = new Set(['removed', 'absent', 'not-owned'])

/**
 * 执行一次性清理
 * @param {{homeDir: string, store: {get: Function, set: Function}}} params
 * @param {object} [deps] - 仅测试用
 * @returns {Promise<object>} 各处结果；done=true 表示以后不再运行
 */
async function runLegacyProviderRegistryCleanup({ homeDir, store }, deps = {}) {
  if (store.get(STORE_KEY)?.done) return { skipped: 'already-done' }
  // 备份文件名带时间戳：迁移可能重试多次，每次的原文都要留着，不互相覆盖
  const suffix = deps.backupSuffix ? deps.backupSuffix() : new Date().toISOString().replace(/[:.]/g, '-')
  const codex = await cleanupCodex(homeDir, suffix)
  const claude = await cleanupClaudeJson(homeDir, deps, suffix)
  const done = TERMINAL.has(codex) && TERMINAL.has(claude)
  const result = { codex, claude, done, at: new Date().toISOString() }
  store.set(STORE_KEY, result)
  return result
}

module.exports = { runLegacyProviderRegistryCleanup, isOwnedEntry }
