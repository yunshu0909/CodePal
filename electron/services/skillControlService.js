/**
 * Skill 控制中心领域服务
 *
 * 负责：
 * - 生成稳定的整目录 manifest
 * - 聚合中央仓库与各工具 adapter 的独立 Skill 发现结果
 * - 提供软链接优先、原子复制兜底的安全部署与收进资产库能力
 * - 在写操作前统一拦截 project/plugin/system 等只读来源
 *
 * @module electron/services/skillControlService
 */

const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { readSkillMetadata } = require('./skillMetadataService')

const IGNORED_ENTRY_NAMES = new Set(['.DS_Store'])
const READ_ONLY_ORIGINS = new Set(['project', 'synced', 'plugin', 'system', 'bundled', 'command'])

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined)
  error.code = code
  return error
}

function isSafeSkillName(skillName) {
  return typeof skillName === 'string'
    && skillName.length > 0
    && skillName !== '.'
    && skillName !== '..'
    && path.basename(skillName) === skillName
    && !skillName.includes('\0')
}

function expandHome(value, homeDir) {
  if (value === '~') return homeDir
  if (typeof value === 'string' && value.startsWith('~/')) return path.join(homeDir, value.slice(2))
  return value
}

function mapFsError(error) {
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'PERMISSION_DENIED'
  if (error?.code === 'ENOENT') return 'NOT_FOUND'
  if (error?.code === 'EEXIST') return 'ALREADY_EXISTS'
  return error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'READ_FAILED'
}

async function pathExists(targetPath, deps = {}) {
  try {
    await (deps.accessFn || fs.access)(targetPath)
    return true
  } catch {
    return false
  }
}

/**
 * 对 Skill 完整目录生成稳定摘要。
 * @param {string} skillPath Skill 根路径
 * @param {object} deps 测试依赖
 * @returns {Promise<{hash:string,fileCount:number,directoryCount:number,totalBytes:number}>}
 */
async function buildSkillManifest(skillPath, deps = {}) {
  const readdirFn = deps.readdirFn || fs.readdir
  const readFileFn = deps.readFileFn || fs.readFile
  const lstatFn = deps.lstatFn || fs.lstat
  const readlinkFn = deps.readlinkFn || fs.readlink
  const digest = crypto.createHash('sha256')
  let fileCount = 0
  let directoryCount = 0
  let totalBytes = 0

  async function walk(currentPath, relativePath = '') {
    const entries = await readdirFn(currentPath, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (IGNORED_ENTRY_NAMES.has(entry.name)) continue
      const absolutePath = path.join(currentPath, entry.name)
      const relativeEntryPath = relativePath ? path.posix.join(relativePath, entry.name) : entry.name
      const stat = await lstatFn(absolutePath)
      const mode = stat.mode & 0o777
      if (stat.isDirectory()) {
        directoryCount += 1
        digest.update(`D\0${relativeEntryPath}\0${mode}\0`)
        await walk(absolutePath, relativeEntryPath)
      } else if (stat.isSymbolicLink()) {
        const target = await readlinkFn(absolutePath)
        digest.update(`L\0${relativeEntryPath}\0${mode}\0${target}\0`)
      } else if (stat.isFile()) {
        const content = await readFileFn(absolutePath)
        const contentHash = crypto.createHash('sha256').update(content).digest('hex')
        fileCount += 1
        totalBytes += stat.size
        digest.update(`F\0${relativeEntryPath}\0${mode}\0${stat.size}\0${contentHash}\0`)
      }
    }
  }

  await walk(skillPath)
  return { hash: digest.digest('hex'), fileCount, directoryCount, totalBytes }
}

/** 扫描一个只包含 Skill 子目录的根目录。 */
async function scanSkillRoot(basePath, deps = {}) {
  try {
    const entries = await (deps.readdirFn || fs.readdir)(basePath, { withFileTypes: true })
    const candidates = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .filter((entry) => isSafeSkillName(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
    const skills = new Map()
    for (const entry of candidates) {
      const skillPath = path.join(basePath, entry.name)
      if (!(await pathExists(path.join(skillPath, 'SKILL.md'), deps))) continue
      try {
        const [manifest, metadata] = await Promise.all([
          buildSkillManifest(skillPath, deps),
          readSkillMetadata(skillPath, deps),
        ])
        skills.set(entry.name, {
          name: entry.name,
          displayName: metadata.name || entry.name,
          description: metadata.description,
          metadataStatus: metadata.metadataStatus,
          absolutePath: skillPath,
          isSymlink: entry.isSymbolicLink(),
          manifest,
        })
      } catch (error) {
        skills.set(entry.name, { name: entry.name, absolutePath: skillPath, manifest: null, error: mapFsError(error) })
      }
    }
    return { available: true, exists: true, error: null, skills }
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: true, exists: false, error: null, skills: new Map() }
    return { available: false, exists: true, error: mapFsError(error), skills: new Map() }
  }
}

async function copyDirectoryVerified(sourcePath, targetPath, deps = {}) {
  const mkdirFn = deps.mkdirFn || fs.mkdir
  const cpFn = deps.cpFn || fs.cp
  const renameFn = deps.renameFn || fs.rename
  const rmFn = deps.rmFn || fs.rm
  const parentPath = path.dirname(targetPath)
  await mkdirFn(parentPath, { recursive: true })
  const operationId = crypto.randomUUID()
  const stagingPath = path.join(parentPath, `.${path.basename(targetPath)}.codepal-${operationId}.tmp`)
  const backupPath = path.join(parentPath, `.${path.basename(targetPath)}.codepal-${operationId}.bak`)
  let backupCreated = false
  let promoted = false
  try {
    await cpFn(sourcePath, stagingPath, { recursive: true, force: false, errorOnExist: true, dereference: true })
    const [sourceManifest, stagingManifest] = await Promise.all([
      buildSkillManifest(sourcePath, deps),
      buildSkillManifest(stagingPath, deps),
    ])
    if (sourceManifest.hash !== stagingManifest.hash) throw codedError('STAGING_VERIFY_FAILED')
    if (await pathExists(targetPath, deps)) {
      await renameFn(targetPath, backupPath)
      backupCreated = true
    }
    await renameFn(stagingPath, targetPath)
    promoted = true
    const deployedManifest = await buildSkillManifest(targetPath, deps)
    if (deployedManifest.hash !== sourceManifest.hash) throw codedError('DEPLOY_VERIFY_FAILED')
    if (backupCreated) await rmFn(backupPath, { recursive: true, force: true }).catch(() => {})
    return { mode: 'copy', manifest: deployedManifest }
  } catch (error) {
    if (promoted) await rmFn(targetPath, { recursive: true, force: true }).catch(() => {})
    if (backupCreated) await renameFn(backupPath, targetPath).catch(() => {})
    await rmFn(stagingPath, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** 将中央 Skill 安全部署到工具目录；macOS 优先软链接，失败时原子复制。 */
async function deployManagedSkill({ repoPath, targetPath, skillName }, deps = {}) {
  if (!isSafeSkillName(skillName)) throw codedError('INVALID_SKILL_NAME')
  const sourcePath = path.join(repoPath, skillName)
  if (!(await pathExists(path.join(sourcePath, 'SKILL.md'), deps))) throw codedError('SKILL_NOT_FOUND')
  const mkdirFn = deps.mkdirFn || fs.mkdir
  const renameFn = deps.renameFn || fs.rename
  const rmFn = deps.rmFn || fs.rm
  const symlinkFn = deps.symlinkFn || fs.symlink
  await mkdirFn(path.dirname(targetPath), { recursive: true })

  if ((deps.platform || process.platform) === 'darwin') {
    const operationId = crypto.randomUUID()
    const stagedLink = `${targetPath}.codepal-${operationId}.tmp`
    const backupPath = `${targetPath}.codepal-${operationId}.bak`
    let backupCreated = false
    try {
      await symlinkFn(sourcePath, stagedLink, 'dir')
      if (await pathExists(targetPath, deps)) {
        await renameFn(targetPath, backupPath)
        backupCreated = true
      }
      await renameFn(stagedLink, targetPath)
      if (backupCreated) await rmFn(backupPath, { recursive: true, force: true }).catch(() => {})
      return { success: true, enabled: true, state: 'synced', mode: 'symlink' }
    } catch {
      await rmFn(stagedLink, { recursive: true, force: true }).catch(() => {})
      if (backupCreated && !(await pathExists(targetPath, deps))) await renameFn(backupPath, targetPath).catch(() => {})
    }
  }

  const result = await copyDirectoryVerified(sourcePath, targetPath, deps)
  return { success: true, enabled: true, state: 'synced', mode: result.mode }
}

async function removeToolCopies(paths, deps = {}) {
  const rmFn = deps.rmFn || fs.rm
  for (const targetPath of [...new Set(paths.filter(Boolean))]) {
    await rmFn(targetPath, { recursive: true, force: true })
  }
  return { success: true, enabled: false, state: 'removed' }
}

function loadAdapters(overrides = {}) {
  const codexModule = require('./skillAdapters/codexSkillAdapter')
  const claudeModule = require('./skillAdapters/claudeSkillAdapter')
  return {
    codex: overrides.codexAdapter || { discover: codexModule.discoverCodexSkills, apply: codexModule.applyCodexCommand },
    'claude-code': overrides.claudeAdapter || { discover: claudeModule.discoverClaudeSkills, apply: claudeModule.applyClaudeCommand },
  }
}

function publicOrigin(source) {
  const { absolutePath, manifest, ...safe } = source
  return safe
}

function sourceEnabled(source) {
  if (source.configEnabled === false || source.overrideState === 'disabled') return false
  return true
}

/** 聚合中央仓库、Codex 与 Claude Code 的中立 Skill 快照。 */
async function getSkillControlSnapshot(params = {}, overrides = {}) {
  const homeDir = params.homeDir || overrides.homeDir || os.homedir()
  const repoPath = expandHome(params.repoPath, homeDir)
  if (typeof repoPath !== 'string' || !repoPath) throw codedError('INVALID_REPO_PATH')
  const central = await scanSkillRoot(repoPath, overrides)
  if (!central.available) throw codedError(central.error || 'CENTRAL_REPO_UNAVAILABLE')
  const adapters = loadAdapters(overrides)
  const discoverParams = { homeDir, projectRoots: params.projectRoots || [], repoPath }
  const results = await Promise.all(Object.entries(adapters).map(async ([toolId, adapter]) => {
    try {
      const result = await adapter.discover(discoverParams, overrides)
      // 双重边界保护：即使未来某个 adapter 意外返回 Plugin 子 Skill，也不进入 Skill 控制中心。
      return [toolId, {
        toolId,
        sources: (result?.sources || []).filter((source) => source.origin !== 'plugin'),
        errors: (result?.errors || []).filter((error) => error.origin !== 'plugin'),
      }]
    } catch (error) {
      return [toolId, { toolId, sources: [], errors: [{ origin: 'tool', code: mapFsError(error) }] }]
    }
  }))

  const discovery = Object.fromEntries(results)
  const errors = results.flatMap(([toolId, result]) => result.errors.map((item) => ({ toolId, ...item })))
  const allNames = new Set(central.skills.keys())
  results.forEach(([, result]) => result.sources.forEach((source) => allNames.add(source.name)))
  const toolNames = { codex: 'Codex', 'claude-code': 'Claude Code' }
  const tools = {}
  for (const toolId of Object.keys(adapters)) {
    const result = discovery[toolId]
    tools[toolId] = {
      id: toolId,
      name: toolNames[toolId],
      available: !result.errors.some((item) => item.origin === 'tool'),
      skillCount: new Set(result.sources.map((source) => source.name)).size,
    }
  }

  const skills = [...allNames].sort((a, b) => a.localeCompare(b)).map((name) => {
    const managed = central.skills.get(name) || null
    const origins = []
    const toolStates = {}
    for (const toolId of Object.keys(adapters)) {
      const sources = discovery[toolId].sources.filter((source) => source.name === name)
      origins.push(...sources.map((source) => publicOrigin({ toolId, ...source })))
      // 工具目录读不了、或配置读不出（开关状态无法确定）→ 都显示为不可用，不能按缺省当成已启用
      if (discovery[toolId].errors.some((item) => item.origin === 'tool' || item.origin === 'config')) {
        toolStates[toolId] = { enabled: null, state: 'unavailable', mutable: false }
        continue
      }
      if (sources.length === 0) {
        toolStates[toolId] = { enabled: false, state: 'disabled', mutable: true }
        continue
      }
      const preferred = sources.find((source) => source.mutable) || sources[0]
      const enabled = sources.some(sourceEnabled)
      let state = managed ? 'synced' : 'external'
      if (managed && preferred.manifest?.hash && managed.manifest?.hash && preferred.manifest.hash !== managed.manifest.hash) state = 'drifted'
      if (!enabled) state = 'disabled'
      toolStates[toolId] = {
        enabled,
        state,
        mutable: Boolean(preferred.mutable),
        origin: preferred.origin,
        pluginId: preferred.pluginId,
        pluginName: preferred.pluginName,
        overrideState: preferred.overrideState,
        configEnabled: preferred.configEnabled,
      }
    }
    const describedOrigin = origins.find((origin) => origin.description)
    return {
      name,
      displayName: managed?.displayName || describedOrigin?.displayName || name,
      description: managed?.description || describedOrigin?.description || '',
      managed: Boolean(managed),
      origins,
      tools: toolStates,
    }
  })

  const managedSkills = skills.filter((skill) => skill.managed)
  return {
    generatedAt: new Date().toISOString(),
    partial: errors.length > 0,
    errors,
    central: { available: true, exists: central.exists, skillCount: central.skills.size },
    tools,
    skills,
    summary: {
      managed: managedSkills.length,
      claudeEnabled: skills.filter((skill) => skill.tools['claude-code'].enabled === true).length,
      codexEnabled: skills.filter((skill) => skill.tools.codex.enabled === true).length,
      protected: skills.filter((skill) => skill.origins.some((origin) => origin.mutable === false)).length,
      drifted: managedSkills.filter((skill) => Object.values(skill.tools).some((state) => state.state === 'drifted')).length,
      external: skills.filter((skill) => !skill.managed).length,
    },
  }
}

function assertMutableSource(source) {
  if (source && (source.mutable === false || READ_ONLY_ORIGINS.has(source.origin))) throw codedError('ORIGIN_READ_ONLY')
}

/** 执行统一 Skill 命令，并在 adapter 写入后由调用方重新读取原生状态。 */
async function executeSkillCommand(params = {}, overrides = {}) {
  if (!isSafeSkillName(params.skillName)) throw codedError('INVALID_SKILL_NAME')
  assertMutableSource(params.source)
  const homeDir = params.homeDir || overrides.homeDir || os.homedir()
  const repoPath = expandHome(params.repoPath, homeDir)
  if (!repoPath) throw codedError('INVALID_REPO_PATH')
  const adapter = loadAdapters(overrides)[params.toolId]
  if (!adapter) throw codedError('TOOL_NOT_SUPPORTED')
  const discovery = await adapter.discover({ homeDir, projectRoots: params.projectRoots || [], repoPath }, overrides)
  const matchingSources = (discovery?.sources || []).filter((source) => source.name === params.skillName)
  const mutableSource = matchingSources.find((source) => source.mutable)
  if (matchingSources.length > 0 && !mutableSource && params.action !== 'enable') throw codedError('ORIGIN_READ_ONLY')
  if (params.action === 'adopt') {
    return adoptExternalSkill({ ...params, repoPath, homeDir, source: mutableSource || params.source }, overrides)
  }
  if (!adapter.apply) throw codedError('TOOL_NOT_SUPPORTED')
  // renderer 传来的 source 只作意图提示；真正写入位置始终采用刚刚重读到的来源。
  return adapter.apply({ ...params, repoPath, homeDir, source: mutableSource || params.source }, overrides)
}

/** 将可变工具来源物化到中央仓库，不删除软链接上游。 */
async function adoptExternalSkill(params = {}, deps = {}) {
  assertMutableSource(params.source)
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const repoPath = expandHome(params.repoPath, homeDir)
  const roots = {
    codex: path.join(homeDir, '.agents', 'skills'),
    'claude-code': path.join(homeDir, '.claude', 'skills'),
  }
  const sourceRoot = roots[params.toolId]
  if (!sourceRoot) throw codedError('TOOL_NOT_SUPPORTED')
  const sourcePath = params.source?.absolutePath || path.join(sourceRoot, params.skillName)
  const targetPath = path.join(repoPath, params.skillName)
  if (await pathExists(targetPath, deps)) throw codedError('SKILL_ALREADY_MANAGED')
  if (!(await pathExists(path.join(sourcePath, 'SKILL.md'), deps))) throw codedError('EXTERNAL_SKILL_NOT_FOUND')
  const realpathFn = deps.realpathFn || fs.realpath
  const lstatFn = deps.lstatFn || fs.lstat
  const stat = await lstatFn(sourcePath)
  const materialSource = stat.isSymbolicLink() ? await realpathFn(sourcePath) : sourcePath
  await copyDirectoryVerified(materialSource, targetPath, deps)
  return { success: true, managed: true, toolId: params.toolId, skillName: params.skillName, sourceType: stat.isSymbolicLink() ? 'symlink' : 'directory' }
}

module.exports = {
  READ_ONLY_ORIGINS,
  isSafeSkillName,
  expandHome,
  mapFsError,
  pathExists,
  buildSkillManifest,
  scanSkillRoot,
  deployManagedSkill,
  removeToolCopies,
  getSkillControlSnapshot,
  executeSkillCommand,
  adoptExternalSkill,
}
