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
const { withConfigLock, commitConfigUnlocked, restoreConfigUnlocked, finalizeBackup, discardBackup } = require('../codexConfigOwner')

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
