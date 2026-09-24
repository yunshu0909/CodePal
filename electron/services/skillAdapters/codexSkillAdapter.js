/**
 * Codex Skill adapter
 *
 * 读取官方个人目录、兼容目录、skills.config 与受保护的 system 来源；
 * 写入只落官方个人目录和 Codex 官方配置，不改缓存目录。
 * config.toml 按 TOML 语义读取；写入只改目标 Skill 的 enabled 那一段文字（tomlSafeEdit），
 * 提交前后复验文件没被外部改过；「启用」的改配置 → 部署 → 撤回在同一把锁里，撤回只动确认属于自己的那一份。
 *
 * @module electron/services/skillAdapters/codexSkillAdapter
 */

const fs = require('fs/promises')
const path = require('path')
const {
  scanSkillRoot,
  deployManagedSkill,
  removeToolCopies,
  expandHome,
} = require('../skillControlService')
const { parseToml, setArrayTableBoolean } = require('../tomlSafeEdit')

const SKILL_TABLE = ['skills', 'config']

/**
 * 按 TOML 语义读出 [[skills.config]]
 * @param {string} tomlText - config.toml 原文
 * @returns {Array<{path: string, enabled: boolean}>} 缺省 enabled 视为启用
 * @throws {Error} code=CODEX_CONFIG_INVALID 原文不是合法 TOML
 */
function parseSkillConfig(tomlText) {
  const doc = parseToml(tomlText, 'CODEX_CONFIG_INVALID')
  const entries = doc?.skills?.config
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry) => entry && typeof entry.path === 'string')
    .map((entry) => ({ path: entry.path, enabled: entry.enabled !== false }))
}

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

async function readText(filePath) {
  try { return await fs.readFile(filePath, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

function flattenScan(scan, origin, mutable, extra = {}) {
  return [...scan.skills.values()].map((skill) => ({ ...skill, origin, mutable, ...extra }))
}

/** 发现 Codex 独立 Skill；Plugin 子 Skill 由 Plugin 控制中心单独管理。 */
async function discoverCodexSkills({ homeDir }, deps = {}) {
  const officialRoot = path.join(homeDir, '.agents', 'skills')
  const legacyRoot = path.join(homeDir, '.codex', 'skills')
  const systemRoot = path.join(legacyRoot, '.system')
  const [official, legacy, system] = await Promise.all([
    scanSkillRoot(officialRoot, deps),
    scanSkillRoot(legacyRoot, deps),
    scanSkillRoot(systemRoot, deps),
  ])
  const errors = []
  for (const [origin, scan] of [['user', official], ['legacy', legacy], ['system', system]]) {
    if (!scan.available) errors.push({ origin, code: scan.error })
  }
  const configPath = path.join(homeDir, '.codex', 'config.toml')
  let configRecords = []
  try { configRecords = parseSkillConfig(await readText(configPath)) } catch (error) {
    errors.push({ origin: 'config', code: error.code === 'EACCES' ? 'PERMISSION_DENIED' : 'READ_FAILED' })
  }
  const configByPath = new Map(configRecords.map((item) => [path.resolve(expandHome(item.path, homeDir)), item.enabled]))
  const sources = [
    ...flattenScan(official, 'user', true),
    ...flattenScan(legacy, 'legacy', true).filter((item) => item.name !== '.system'),
    ...flattenScan(system, 'system', false),
  ]
  for (const source of sources) {
    if (configByPath.has(path.resolve(source.absolutePath))) source.configEnabled = configByPath.get(path.resolve(source.absolutePath))
  }
  return { toolId: 'codex', sources, errors }
}

/**
 * 算出「把某个 Skill 的 enabled 设成目标值」后的 config.toml 全文（纯函数，不写盘）
 * @returns {{text: string, changed: boolean}}
 * @throws {Error} CODEX_CONFIG_INVALID / CODEX_CONFIG_UNSUPPORTED —— 做不到安全编辑就拒绝，不整份重写
 */
function planSkillEnabled(text, skillPath, enabled, homeDir) {
  return setArrayTableBoolean(text, {
    tablePath: SKILL_TABLE,
    match: (entry) => typeof entry?.path === 'string' && path.resolve(expandHome(entry.path, homeDir)) === path.resolve(skillPath),
    field: 'enabled',
    value: enabled,
    newEntry: { path: skillPath, enabled },
    invalidCode: 'CODEX_CONFIG_INVALID',
    unsupportedCode: 'CODEX_CONFIG_UNSUPPORTED',
  })
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
 * @returns {Promise<{changed: boolean, before: object, text?: string, ino?: number, backupTemp?: string|null}>}
 */
async function commitConfigUnlocked(configPath, plan, deps = {}) {
  const before = await snapshotConfig(configPath)
  const { text, changed } = plan(before.text)
  if (!changed) return { changed: false, before, backupTemp: null }
  if (deps.beforeConfigCommit) await deps.beforeConfigCommit(configPath)
  await assertUnchanged(before)
  await fs.mkdir(path.dirname(before.target), { recursive: true })
  const backupTemp = before.exists ? await writeTemp(`${before.target}.codepal.bak`, before.text, before.mode) : null
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

/** 执行 Codex 个人来源写操作。 */
async function applyCodexCommand(params, deps = {}) {
  const officialPath = path.join(params.homeDir, '.agents', 'skills', params.skillName)
  const legacyPath = path.join(params.homeDir, '.codex', 'skills', params.skillName)
  const configPath = path.join(params.homeDir, '.codex', 'config.toml')
  if (params.action === 'enable') {
    // 先改配置再部署目录：配置改不了就在动目录之前拒绝；部署失败只需把配置恢复成原文，
    // 不用删除或恢复任何目录（部署会替换原有目录，事后无法可靠还原）。
    // 重新部署目录并不会覆盖原生 enabled=false；用户明确“启用”时必须同步恢复配置。
    const deploy = deps.deployFn || deployManagedSkill
    return withConfigLock(async () => {
      const committed = await commitConfigUnlocked(configPath, (text) => planSkillEnabled(text, officialPath, true, params.homeDir), deps)
      let deployed
      try {
        deployed = await deploy({ repoPath: params.repoPath, targetPath: officialPath, skillName: params.skillName }, deps)
      } catch (error) {
        await discardBackup(committed)
        if (committed.changed) await restoreConfigUnlocked(committed, deps)
        throw error
      }
      await finalizeBackup(committed, deps)
      return deployed
    })
  }
  if (params.action === 'remove-tool') return removeToolCopies([officialPath, legacyPath], deps)
  if (params.action === 'set-enabled' || params.action === 'disable') {
    const enabled = params.action === 'disable' ? false : Boolean(params.enabled)
    const configuredPath = params.source?.absolutePath || officialPath
    await withConfigLock(async () => {
      const committed = await commitConfigUnlocked(configPath, (text) => planSkillEnabled(text, configuredPath, enabled, params.homeDir), deps)
      await finalizeBackup(committed, deps)
    })
    return { success: true, enabled, state: enabled ? 'synced' : 'disabled' }
  }
  throw Object.assign(new Error('ACTION_NOT_SUPPORTED'), { code: 'ACTION_NOT_SUPPORTED' })
}

module.exports = { parseSkillConfig, discoverCodexSkills, applyCodexCommand }
