/**
 * Codex 配置负责人（写入网关第一步）
 *
 * 负责：
 * - ~/.codex/config.toml 的所有 CodePal 修改都在同一把锁里排队（事务：改配置 → 其他步骤 → 必要时撤回）
 * - 安全提交：拍照（含软链接指向）→ 复验 → 临时文件 → 替换前再复验 → rename；备份在事务成功后才换上
 * - 撤回只动确认属于自己的那一份（inode + 内容 + 链接），做不到就报 CODEX_ENABLE_PARTIAL
 *
 * 调用方只提供「怎么改」（plan：原文 → {text, changed}），格式安全由 tomlSafeEdit 保证。
 *
 * @module electron/services/codexConfigOwner
 */

const fs = require('fs/promises')
const path = require('path')

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

// CodePal 对 config.toml 的操作整体排队：一次「启用」的改配置 → 部署 → 必要时撤回是一个事务，
// 不会被另一次操作插进来（否则失败的那次撤回会冲掉成功的那次）
let configQueue = Promise.resolve()

/**
 * 串行执行一个针对 config.toml 的事务；内部只调用 *Unlocked 函数，避免嵌套排队自锁
 * @param {() => Promise<*>} task
 * @returns {Promise<*>}
 */
function withConfigLock(task) {
  const result = configQueue.then(task, task)
  configQueue = result.catch(() => {})
  return result
}

/**
 * 拍下配置当前状态：逻辑路径本身（是不是软链接、指向哪）+ 真实文件（是否存在、内容、权限、inode）
 * 软链接（dotfiles 管理）跟到真实文件上改，链接本身保留；悬空链接无法判断意图，直接拒绝
 * @param {string} configPath
 * @returns {Promise<{configPath: string, link: string|null, target: string, exists: boolean, text: string, mode: number, ino: number|null}>}
 */
async function snapshotConfig(configPath) {
  let link = null
  try {
    const stat = await fs.lstat(configPath)
    if (stat.isSymbolicLink()) link = await fs.readlink(configPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let target = configPath
  if (link !== null) {
    try { target = await fs.realpath(configPath) } catch (error) {
      if (error.code === 'ENOENT') throw codedError('CODEX_CONFIG_UNSUPPORTED')
      throw error
    }
  }
  try {
    const stat = await fs.stat(target)
    return { configPath, link, target, exists: true, text: await fs.readFile(target, 'utf8'), mode: stat.mode & 0o777, ino: stat.ino }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { configPath, link, target, exists: false, text: '', mode: 0o600, ino: null }
  }
}

/**
 * 确认配置和拍照时一样（链接指向 + 真实文件的内容与 inode），否则说明被外部改过
 * @param {object} expected - snapshotConfig 结果
 */
async function assertUnchanged(expected) {
  const now = await snapshotConfig(expected.configPath)
  const same = now.link === expected.link && now.target === expected.target && now.exists === expected.exists
    && now.text === expected.text && now.ino === expected.ino
  if (!same) throw codedError('CODEX_CONFIG_CONFLICT')
}

/**
 * 写一个同目录临时文件（独占创建、设好权限），返回它的路径；不会顺着已有链接写穿
 * @param {string} target
 * @param {string} text
 * @param {number} mode
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
 * 把本次准备好的备份换上（事务成功后才调用）；换不上就丢掉临时文件，旧备份保持原样
 * @param {{backupTemp: string|null, before: object}} committed
 * @param {object} deps - backupRenameFn 仅测试用
 */
async function finalizeBackup(committed, deps = {}) {
  if (!committed.backupTemp) return
  try {
    await (deps.backupRenameFn || fs.rename)(committed.backupTemp, `${committed.before.target}.codepal.bak`)
  } catch {
    await fs.rm(committed.backupTemp, { force: true }).catch(() => {})
  }
}

/** 事务失败：丢掉本次准备的备份，旧备份不动 */
async function discardBackup(committed) {
  if (committed.backupTemp) await fs.rm(committed.backupTemp, { force: true }).catch(() => {})
}

/**
 * 提交（须在锁内）：拍照 → 算 → 无变化不写 → 复验 → 准备新内容与备份的临时文件 → 替换前再复验 → rename 提交。
 * 备份此时只准备不换上：由调用方在整个事务成功后 finalizeBackup，失败时 discardBackup（旧备份保持原样）。
 * rename 成功即视为已提交，不做归属不明的「回读失败就恢复」。
 * 本次写入的 inode 在 rename 之前从临时文件上取（rename 保留 inode），撤回时据此确认文件仍是我们写的。
 * 残余局限：最后一次复验到 rename 之间仍有极短窗口，跨进程无法完全消除（同 claudeSettingsService）。
 * @param {string} configPath
 * @param {(text: string) => {text: string, changed: boolean}} plan
 * @param {object} deps - beforeConfigCommit / beforeConfigRename / renameFn / afterConfigCommit 仅测试用
 * @param {object} [options]
 * @param {(target: string) => string} [options.durableBackupPath] - 给出则在改配置之前把备份可靠地写到这个路径（失败即放弃、配置不动），
 *   不走「事务成功后才换上的滚动备份」；一次性迁移用它
 * @returns {Promise<{changed: boolean, before: object, text?: string, ino?: number, backupTemp?: string|null}>}
 */
async function commitConfigUnlocked(configPath, plan, deps = {}, options = {}) {
  const before = await snapshotConfig(configPath)
  const { text, changed } = plan(before.text)
  if (!changed) return { changed: false, before, backupTemp: null }
  // 用户把配置设成只读（chmod 444）就是不想被改：rename 能绕过权限，所以这里主动拒绝
  if (before.exists && (before.mode & 0o200) === 0) throw codedError('CODEX_CONFIG_READONLY')
  if (deps.beforeConfigCommit) await deps.beforeConfigCommit(configPath)
  await assertUnchanged(before)
  await fs.mkdir(path.dirname(before.target), { recursive: true })
  if (before.exists && options.durableBackupPath) {
    // 先把备份落稳：写临时文件 → rename 到最终路径，任何一步失败都直接放弃，配置还没动
    const durableTemp = await writeTemp(options.durableBackupPath(before.target), before.text, before.mode)
    try {
      await fs.rename(durableTemp, options.durableBackupPath(before.target))
    } catch (error) {
      await fs.rm(durableTemp, { force: true }).catch(() => {})
      throw error
    }
  }
  const backupTemp = before.exists && !options.durableBackupPath ? await writeTemp(`${before.target}.codepal.bak`, before.text, before.mode) : null
  let newTemp = null
  try {
    newTemp = await writeTemp(before.target, text, before.mode)
    const ino = (await fs.stat(newTemp)).ino
    if (deps.beforeConfigRename) await deps.beforeConfigRename(configPath)
    await assertUnchanged(before)
    await (deps.renameFn || fs.rename)(newTemp, before.target)
    newTemp = null
    if (deps.afterConfigCommit) await deps.afterConfigCommit(configPath)
    return { changed: true, before, text, ino, backupTemp }
  } catch (error) {
    if (newTemp) await fs.rm(newTemp, { force: true }).catch(() => {})
    if (backupTemp) await fs.rm(backupTemp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 撤回刚提交的配置（须在锁内）：只有文件仍是我们 rename 上去的那个（inode 相同）且内容、链接都没变时才恢复原文。
 * 没能恢复的一切情况（读不到、已被别人改过、恢复本身失败）都抛 CODEX_ENABLE_PARTIAL，
 * 页面据此只说「操作失败」，不说「已保留原状态」；别人的内容一律不覆盖。
 * @param {{before: object, text: string, ino: number}} committed
 * @param {object} deps - restoreRenameFn 仅测试用
 */
async function restoreConfigUnlocked(committed, deps = {}) {
  try {
    const now = await snapshotConfig(committed.before.configPath)
    const stillOurs = now.exists && now.ino === committed.ino && now.text === committed.text && now.link === committed.before.link
    if (!stillOurs) throw codedError('NOT_OURS')
    if (committed.before.exists) {
      const temp = await writeTemp(committed.before.target, committed.before.text, committed.before.mode)
      try {
        await assertUnchanged(now)
        await (deps.restoreRenameFn || fs.rename)(temp, committed.before.target)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {})
        throw error
      }
    } else {
      await fs.rm(committed.before.target)
    }
  } catch {
    throw codedError('CODEX_ENABLE_PARTIAL')
  }
}

/** 等排队中的 Codex 配置写入全部完成（应用退出时调用，避免写到一半被中断） */
function drainConfigQueue() {
  return configQueue
}

module.exports = {
  withConfigLock,
  drainConfigQueue,
  commitConfigUnlocked,
  restoreConfigUnlocked,
  finalizeBackup,
  discardBackup,
  snapshotConfig,
}
