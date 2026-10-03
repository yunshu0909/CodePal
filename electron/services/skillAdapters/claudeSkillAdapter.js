/**
 * Claude Code Skill adapter
 *
 * 支持用户 Skill、显式项目 allowlist、旧 commands、claude.ai 同步来的（只读）等独立来源与
 * settings.json 的 skillOverrides 四态读取和保留式写入。
 * 写完重读 settings 核对：不一致写回原值并再核对，通过报 NOT_EFFECTIVE，写回不成或读不出报 STATE_UNKNOWN。
 *
 * @module electron/services/skillAdapters/claudeSkillAdapter
 */

const fs = require('fs/promises')
const path = require('path')
const {
  scanSkillRoot,
  deployManagedSkill,
  removeToolCopies,
  mapFsError,
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

async function scanLegacyCommands(commandsRoot, deps = {}, names = null) {
  const sources = flattenScan(await scanSkillRoot(commandsRoot, deps, names), 'command', false)
  try {
    const entries = await fs.readdir(commandsRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const name = entry.name.slice(0, -3)
      if (names && !names.has(name)) continue
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

/**
 * 扫 claude.ai 同步来的 Skill：~/.claude/skills/synced/<账号>/<Skill>/SKILL.md，只读
 * @returns {Promise<{sources: Array, error: string|null}>}
 */
async function scanSyncedSkills(userRoot, deps = {}, names = null) {
  const syncedRoot = path.join(userRoot, 'synced')
  let accounts
  try {
    accounts = await (deps.readdirFn || fs.readdir)(syncedRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { sources: [], error: null }
    return { sources: [], error: mapFsError(error) }
  }
  const sources = []
  for (const account of accounts.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())) {
    const scan = await scanSkillRoot(path.join(syncedRoot, account.name), deps, names)
    if (!scan.available) return { sources: [], error: scan.error }
    sources.push(...flattenScan(scan, 'synced', false))
  }
  return { sources, error: null }
}

/**
 * 发现 Claude Code 独立 Skill，项目范围严格来自显式 allowlist。
 * names 给了就只读这几个名字（单个操作后只重读动到的那一个）。
 */
async function discoverClaudeSkills({ homeDir, projectRoots = [], names = null }, deps = {}) {
  const userRoot = path.join(homeDir, '.claude', 'skills')
  const commandsRoot = path.join(homeDir, '.claude', 'commands')
  const settingsPath = path.join(homeDir, '.claude', 'settings.json')
  const [userScan, settings, synced] = await Promise.all([
    scanSkillRoot(userRoot, deps, names),
    (deps.readSettingsFn || readSettings)(settingsPath),
    scanSyncedSkills(userRoot, deps, names),
  ])
  const errors = []
  if (synced.error) errors.push({ origin: 'synced', code: synced.error })
  if (!userScan.available) errors.push({ origin: 'user', code: userScan.error })
  if (settings.__codepalInvalidJson) errors.push({ origin: 'settings', code: 'INVALID_JSON' })
  const sources = [...flattenScan(userScan, 'user', true), ...synced.sources]
  for (const projectRoot of [...new Set(projectRoots.filter((item) => typeof item === 'string' && path.isAbsolute(item)))]) {
    const projectScan = await scanSkillRoot(path.join(projectRoot, '.claude', 'skills'), deps, names)
    if (!projectScan.available) errors.push({ origin: 'project', code: projectScan.error })
    sources.push(...flattenScan(projectScan, 'project', false, { project: path.basename(projectRoot) }))
  }
  try { sources.push(...await scanLegacyCommands(commandsRoot, deps, names)) } catch (error) {
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
    else if (nextState === 'name-only' || nextState === 'user-invocable-only') overrides[skillName] = nextState
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

/**
 * 写 skillOverrides 后重读核对；不一致写回原值并再核对
 * @param {object} params
 * @param {string} params.settingsPath
 * @param {string} params.skillName
 * @param {'enabled'|'disabled'} params.nextState
 * @param {object} deps - setSkillOverrideFn / readSettingsFn 可注入
 * @throws {Error} NOT_EFFECTIVE / STATE_UNKNOWN / 写入本身的错误
 */
async function setOverrideAndVerify({ settingsPath, skillName, nextState }, deps = {}) {
  const write = deps.setSkillOverrideFn || setSkillOverride
  const read = deps.readSettingsFn || readSettings
  const previous = overrideState(await read(settingsPath), skillName)
  if (previous === 'invalid') throw Object.assign(new Error('INVALID_SETTINGS_JSON'), { code: 'INVALID_SETTINGS_JSON' })
  await write(settingsPath, skillName, nextState)
  let after
  try {
    after = overrideState(await read(settingsPath), skillName)
  } catch (error) {
    throw Object.assign(new Error('STATE_UNKNOWN', { cause: error }), { code: 'STATE_UNKNOWN' })
  }
  if (after === nextState) return nextState
  try {
    await write(settingsPath, skillName, previous)
    const again = overrideState(await read(settingsPath), skillName)
    if (again === previous) throw Object.assign(new Error('NOT_EFFECTIVE'), { code: 'NOT_EFFECTIVE' })
  } catch (error) {
    if (error?.code === 'NOT_EFFECTIVE') throw error
    throw Object.assign(new Error('STATE_UNKNOWN', { cause: error }), { code: 'STATE_UNKNOWN' })
  }
  throw Object.assign(new Error('STATE_UNKNOWN'), { code: 'STATE_UNKNOWN' })
}

/** 执行 Claude Code 用户级 Skill 与 override 写操作。 */
async function applyClaudeCommand(params, deps = {}) {
  const userPath = path.join(params.homeDir, '.claude', 'skills', params.skillName)
  const settingsPath = path.join(params.homeDir, '.claude', 'settings.json')
  if (params.action === 'enable') {
    // 写 settings 的路径不支持自定义根时，不得先把 Skill 目录部署出去（会留半完成状态）
    const unsupportedRoot = detectUnsupportedCustomRoot()
    if (unsupportedRoot) {
      throw Object.assign(new Error(unsupportedRoot.error), { code: unsupportedRoot.errorCode })
    }
    let existed = true
    try { await fs.lstat(userPath) } catch { existed = false }
    const deployed = await deployManagedSkill({ repoPath: params.repoPath, targetPath: userPath, skillName: params.skillName }, deps)
    // 目录存在不代表 Claude 会加载它；显式启用必须覆盖遗留的 off/false。
    try {
      await setOverrideAndVerify({ settingsPath, skillName: params.skillName, nextState: 'enabled' }, deps)
    } catch (error) {
      // 这次新部署的撤掉，原来就有的不动
      if (!existed) await fs.rm(userPath, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return deployed
  }
  if (params.action === 'remove-tool') return removeToolCopies([userPath], deps)
  if (params.action === 'clear-override') {
    await setSkillOverride(settingsPath, params.skillName, 'inherit')
    return { success: true, overrideState: 'inherit' }
  }
  if (params.action === 'set-override' || params.action === 'disable') {
    const nextState = params.action === 'disable' || params.overrideState !== 'enabled' ? 'disabled' : 'enabled'
    await setOverrideAndVerify({ settingsPath, skillName: params.skillName, nextState }, deps)
    return { success: true, overrideState: nextState }
  }
  throw Object.assign(new Error('ACTION_NOT_SUPPORTED'), { code: 'ACTION_NOT_SUPPORTED' })
}

module.exports = { readSettings, overrideState, setSkillOverride, discoverClaudeSkills, applyClaudeCommand }
