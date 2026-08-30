/**
 * Codex Skill adapter
 *
 * 读取官方个人目录、兼容目录、skills.config 与受保护的 system/plugin 来源；
 * 写入只落官方个人目录和 Codex 官方配置，不改缓存目录。
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

function parseSkillConfig(tomlText) {
  const records = []
  const blocks = String(tomlText || '').split(/(?=\[\[skills\.config\]\])/g)
  for (const block of blocks) {
    if (!block.startsWith('[[skills.config]]')) continue
    const pathMatch = block.match(/^path\s*=\s*["']([^"']+)["']/m)
    const enabledMatch = block.match(/^enabled\s*=\s*(true|false)/m)
    if (pathMatch) records.push({ path: pathMatch[1], enabled: enabledMatch ? enabledMatch[1] === 'true' : true })
  }
  return records
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

async function discoverPluginSkills(homeDir) {
  const pluginRoot = path.join(homeDir, '.codex', 'plugins', 'cache')
  const sources = []
  async function walk(currentPath, depth = 0) {
    if (depth > 6) return
    let entries
    try { entries = await fs.readdir(currentPath, { withFileTypes: true }) } catch { return }
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      const name = path.basename(currentPath)
      const scan = await scanSkillRoot(path.dirname(currentPath))
      const skill = scan.skills.get(name)
      if (skill) sources.push({ ...skill, origin: 'plugin', mutable: false })
      return
    }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== 'node_modules') await walk(path.join(currentPath, entry.name), depth + 1)
  }
  await walk(pluginRoot)
  return sources
}

/** 发现 Codex 可见 Skill。 */
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
  if (!deps.skipPluginDiscovery) sources.push(...await discoverPluginSkills(homeDir))
  return { toolId: 'codex', sources, errors }
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.codepal-${process.pid}-${Date.now()}.tmp`
  await fs.writeFile(tempPath, content, { mode: 0o600 })
  await fs.rename(tempPath, filePath)
}

function setConfigEnabled(text, skillPath, enabled, homeDir) {
  const normalized = String(text || '')
  const blocks = normalized.split(/(?=^\[\[skills\.config\]\]\s*$)/m)
  const index = blocks.findIndex((block) => {
    const match = block.match(/^path\s*=\s*["']([^"']+)["']/m)
    return match && path.resolve(expandHome(match[1], homeDir)) === path.resolve(skillPath)
  })
  if (index < 0) return `${normalized.trimEnd()}\n\n[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = ${enabled}\n`
  blocks[index] = /^enabled\s*=/m.test(blocks[index])
    ? blocks[index].replace(/^enabled\s*=\s*(true|false)/m, `enabled = ${enabled}`)
    : `${blocks[index].trimEnd()}\nenabled = ${enabled}\n`
  return blocks.join('')
}

/** 执行 Codex 个人来源写操作。 */
async function applyCodexCommand(params, deps = {}) {
  const officialPath = path.join(params.homeDir, '.agents', 'skills', params.skillName)
  const legacyPath = path.join(params.homeDir, '.codex', 'skills', params.skillName)
  if (params.action === 'enable') {
    const deployed = await deployManagedSkill({ repoPath: params.repoPath, targetPath: officialPath, skillName: params.skillName }, deps)
    // 重新部署目录并不会覆盖原生 enabled=false；用户明确“启用”时必须同步恢复配置。
    const configPath = path.join(params.homeDir, '.codex', 'config.toml')
    const existing = await readText(configPath)
    await writeAtomic(configPath, setConfigEnabled(existing, officialPath, true, params.homeDir))
    return deployed
  }
  if (params.action === 'remove-tool') return removeToolCopies([officialPath, legacyPath], deps)
  if (params.action === 'set-enabled' || params.action === 'disable') {
    const configPath = path.join(params.homeDir, '.codex', 'config.toml')
    const existing = await readText(configPath)
    const enabled = params.action === 'disable' ? false : Boolean(params.enabled)
    const configuredPath = params.source?.absolutePath || officialPath
    await writeAtomic(configPath, setConfigEnabled(existing, configuredPath, enabled, params.homeDir))
    return { success: true, enabled, state: enabled ? 'synced' : 'disabled' }
  }
  throw Object.assign(new Error('ACTION_NOT_SUPPORTED'), { code: 'ACTION_NOT_SUPPORTED' })
}

module.exports = { parseSkillConfig, discoverCodexSkills, applyCodexCommand }
