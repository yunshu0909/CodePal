/**
 * Claude Code Skill adapter
 *
 * 支持用户 Skill、显式项目 allowlist、旧 commands、plugin/synced 只读来源与
 * settings.json 的 skillOverrides 四态读取和保留式写入。
 *
 * @module electron/services/skillAdapters/claudeSkillAdapter
 */

const fs = require('fs/promises')
const path = require('path')
const {
  scanSkillRoot,
  buildSkillManifest,
  deployManagedSkill,
  removeToolCopies,
} = require('../skillControlService')

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
  if (settings.skillOverrides[name] === true) return 'enabled'
  if (settings.skillOverrides[name] === false) return 'disabled'
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

async function discoverProtectedPluginSkills(homeDir) {
  const roots = [
    [path.join(homeDir, '.claude', 'plugins', 'cache'), 'plugin'],
    [path.join(homeDir, '.claude', 'plugins', 'marketplaces'), 'plugin'],
  ]
  const sources = []
  async function walk(currentPath, origin, depth = 0) {
    if (depth > 7) return
    let entries
    try { entries = await fs.readdir(currentPath, { withFileTypes: true }) } catch { return }
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      const stat = await fs.stat(currentPath)
      sources.push({
        name: path.basename(currentPath), absolutePath: currentPath, origin, mutable: false,
        manifest: await buildSkillManifest(currentPath), modifiedAt: stat.mtimeMs,
      })
      return
    }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== 'node_modules') await walk(path.join(currentPath, entry.name), origin, depth + 1)
  }
  for (const [root, origin] of roots) await walk(root, origin)
  return sources
}

/** 发现 Claude Code 可见 Skill，项目范围严格来自显式 allowlist。 */
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
  if (!deps.skipPluginDiscovery) sources.push(...await discoverProtectedPluginSkills(homeDir))
  for (const source of sources) source.overrideState = overrideState(settings, source.name)
  return { toolId: 'claude-code', sources, errors }
}

async function writeSettingsAtomic(settingsPath, settings) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  const tempPath = `${settingsPath}.codepal-${process.pid}-${Date.now()}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tempPath, settingsPath)
}

async function setSkillOverride(settingsPath, skillName, nextState) {
  const settings = await readSettings(settingsPath)
  if (settings.__codepalInvalidJson) throw Object.assign(new Error('INVALID_SETTINGS_JSON'), { code: 'INVALID_SETTINGS_JSON' })
  const overrides = settings.skillOverrides && typeof settings.skillOverrides === 'object' && !Array.isArray(settings.skillOverrides)
    ? { ...settings.skillOverrides }
    : {}
  if (nextState === 'inherit') delete overrides[skillName]
  else overrides[skillName] = nextState === 'enabled'
  if (Object.keys(overrides).length > 0) settings.skillOverrides = overrides
  else delete settings.skillOverrides
  await writeSettingsAtomic(settingsPath, settings)
  return nextState
}

/** 执行 Claude Code 用户级 Skill 与 override 写操作。 */
async function applyClaudeCommand(params, deps = {}) {
  const userPath = path.join(params.homeDir, '.claude', 'skills', params.skillName)
  if (params.action === 'enable') {
    const deployed = await deployManagedSkill({ repoPath: params.repoPath, targetPath: userPath, skillName: params.skillName }, deps)
    // 目录存在不代表 Claude 会加载它；显式启用必须覆盖遗留的 skillOverrides=false。
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
