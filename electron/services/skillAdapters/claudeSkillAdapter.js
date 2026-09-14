/**
 * Claude Code Skill adapter
 *
 * 支持用户 Skill、显式项目 allowlist、旧 commands 等独立来源与
 * settings.json 的 skillOverrides 四态读取和保留式写入。
 *
 * @module electron/services/skillAdapters/claudeSkillAdapter
 */

const fs = require('fs/promises')
const path = require('path')
const {
  scanSkillRoot,
  deployManagedSkill,
  removeToolCopies,
} = require('../skillControlService')
// settings.json 写入统一走唯一 broker（V1.9.8 收口）。本 adapter 曾自带一套原子写，
// 绕过 broker 的串行队列与备份，是「Skill override 与权限/模型并发写互相覆盖」的根因，已收口。
const { mutateClaudeSettingsFile, detectUnsupportedCustomRoot } = require('../claudeSettingsService')

async function readSettings(settingsPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    if (error instanceof SyntaxError) return { __codepalInvalidJson: true }
    throw error
  }
}

function overrideState(settings, name) {
  if (settings.__codepalInvalidJson) return 'invalid'
  if (!settings.skillOverrides || !Object.prototype.hasOwnProperty.call(settings.skillOverrides, name)) return 'inherit'
  const nativeState = settings.skillOverrides[name]
  if (nativeState === 'on' || nativeState === true) return 'enabled'
  if (nativeState === 'off' || nativeState === false) return 'disabled'
  if (nativeState === 'name-only' || nativeState === 'user-invocable-only') return nativeState
  return 'invalid'
}

function flattenScan(scan, origin, mutable, extra = {}) {
  return [...scan.skills.values()].map((skill) => ({ ...skill, origin, mutable, ...extra }))
}

async function scanLegacyCommands(commandsRoot, deps = {}) {
  const sources = flattenScan(await scanSkillRoot(commandsRoot, deps), 'command', false)
  try {
    const entries = await fs.readdir(commandsRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const name = entry.name.slice(0, -3)
      const content = await fs.readFile(path.join(commandsRoot, entry.name))
      sources.push({
        name,
        absolutePath: path.join(commandsRoot, entry.name),
        origin: 'command',
        mutable: false,
        manifest: { hash: require('crypto').createHash('sha256').update(content).digest('hex'), fileCount: 1, directoryCount: 0, totalBytes: content.byteLength },
      })
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return sources
}

/** 发现 Claude Code 独立 Skill，项目范围严格来自显式 allowlist。 */
async function discoverClaudeSkills({ homeDir, projectRoots = [] }, deps = {}) {
  const userRoot = path.join(homeDir, '.claude', 'skills')
  const commandsRoot = path.join(homeDir, '.claude', 'commands')
  const settingsPath = path.join(homeDir, '.claude', 'settings.json')
  const [userScan, settings] = await Promise.all([scanSkillRoot(userRoot, deps), readSettings(settingsPath)])
  const errors = []
  if (!userScan.available) errors.push({ origin: 'user', code: userScan.error })
  if (settings.__codepalInvalidJson) errors.push({ origin: 'settings', code: 'INVALID_JSON' })
  const sources = flattenScan(userScan, 'user', true)
  for (const projectRoot of [...new Set(projectRoots.filter((item) => typeof item === 'string' && path.isAbsolute(item)))]) {
    const projectScan = await scanSkillRoot(path.join(projectRoot, '.claude', 'skills'), deps)
    if (!projectScan.available) errors.push({ origin: 'project', code: projectScan.error })
    sources.push(...flattenScan(projectScan, 'project', false, { project: path.basename(projectRoot) }))
  }
  try { sources.push(...await scanLegacyCommands(commandsRoot, deps)) } catch (error) {
    errors.push({ origin: 'command', code: error.code === 'EACCES' ? 'PERMISSION_DENIED' : 'READ_FAILED' })
  }
  for (const source of sources) source.overrideState = overrideState(settings, source.name)
  return { toolId: 'claude-code', sources, errors }
}

async function setSkillOverride(settingsPath, skillName, nextState) {
  // 单次事务：读、判断、改、备份、提交都在 broker 的同一个队列任务里完成。
  // 这里的 mutator 只负责 skillOverrides 这一个键——它带着**事务内最新**的 data，
  // 因此不会用旧快照覆盖掉并发的权限/模型改动。
  const result = await mutateClaudeSettingsFile(({ data, kind, errorCode, error }) => {
    if (kind === 'corrupt') {
      // 损坏时拒绝（不自动修复），保持既有语义；错误码留给调用方映射
      return { ok: false, errorCode: 'INVALID_SETTINGS_JSON', error: error || 'settings.json 已损坏' }
    }
    const overrides = data.skillOverrides && typeof data.skillOverrides === 'object' && !Array.isArray(data.skillOverrides)
      ? { ...data.skillOverrides }
      : {}
    if (nextState === 'inherit') delete overrides[skillName]
    else overrides[skillName] = nextState === 'enabled' ? 'on' : 'off'
    const next = { ...data }
    if (Object.keys(overrides).length > 0) next.skillOverrides = overrides
    else delete next.skillOverrides
    return { ok: true, next, create: true }
  }, { filePath: settingsPath, backupSuffix: 'skill-override' })

  if (!result.success) {
    throw Object.assign(new Error(result.errorCode || 'WRITE_FAILED'), {
      code: result.errorCode || 'WRITE_FAILED',
      // 已提交但校验/持久化未达成时不得被上层当成"完全没写"
      committed: result.committed === true,
      durability: result.durability || null,
    })
  }
  return nextState
}

/** 执行 Claude Code 用户级 Skill 与 override 写操作。 */
async function applyClaudeCommand(params, deps = {}) {
  const userPath = path.join(params.homeDir, '.claude', 'skills', params.skillName)
  if (params.action === 'enable') {
    // 写 settings 的路径不支持自定义根时，不得先把 Skill 目录部署出去（会留半完成状态）
    const unsupportedRoot = detectUnsupportedCustomRoot()
    if (unsupportedRoot) {
      throw Object.assign(new Error(unsupportedRoot.error), { code: unsupportedRoot.errorCode })
    }
    const deployed = await deployManagedSkill({ repoPath: params.repoPath, targetPath: userPath, skillName: params.skillName }, deps)
    // 目录存在不代表 Claude 会加载它；显式启用必须覆盖遗留的 off/false。
    await setSkillOverride(path.join(params.homeDir, '.claude', 'settings.json'), params.skillName, 'enabled')
    return deployed
  }
  if (params.action === 'remove-tool') return removeToolCopies([userPath], deps)
  if (params.action === 'set-override' || params.action === 'clear-override' || params.action === 'disable') {
    const settingsPath = path.join(params.homeDir, '.claude', 'settings.json')
    const nextState = params.action === 'clear-override'
      ? 'inherit'
      : (params.action === 'disable' || params.overrideState !== 'enabled' ? 'disabled' : 'enabled')
    await setSkillOverride(settingsPath, params.skillName, nextState)
    return { success: true, overrideState: nextState }
  }
  throw Object.assign(new Error('ACTION_NOT_SUPPORTED'), { code: 'ACTION_NOT_SUPPORTED' })
}

module.exports = { readSettings, overrideState, discoverClaudeSkills, applyClaudeCommand }
