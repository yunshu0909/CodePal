/**
 * Skill 控制中心领域服务
 *
 * 负责：
 * - 生成稳定的整目录 manifest
 * - 聚合中央仓库与各工具 adapter 的独立 Skill 发现结果
 * - 提供软链接优先、原子复制兜底的安全部署与收进资产库能力
 * - 在写操作前统一拦截 project/plugin/system 等只读来源
 * - 快照带每个工具的装载汇总（Skill 数 + 约多少 tokens，插件不算）、同一工具两份、每个位置的完整路径
 * - 删除：资产库和各工具里指向它的那份一起删，任何一步失败全部恢复
 * - 每一份来源带不含路径的 sourceId；命令带 sourceId 时只对那一份来源操作（收进、停用），启用和删除不支持按来源
 * - 动到 Codex 的写操作（toolId 为 codex，或删除时为 all）在所有拒绝检查通过之后、真正写入之前调用调用方给的
 *   补关钩子（beforeCodexWriteFn）；被拒绝的操作（来源找不到、只读、要删的不在资产库、要收的已在资产库或原件不在）不调用
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

/**
 * 一份来源的稳定身份：工具 + 来源类别 + 真实位置的摘要，不含路径字样；同一位置每次读都一样
 * @param {string} toolId
 * @param {{origin?: string, absolutePath?: string}} source
 * @returns {string}
 */
function sourceIdOf(toolId, source) {
  const key = `${toolId}\0${source.origin || ''}\0${source.absolutePath || ''}`
  return `src_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

function publicOrigin(source) {
  const { absolutePath, manifest, ...safe } = source
  return { ...safe, sourceId: sourceIdOf(source.toolId, source) }
}

function sourceEnabled(source) {
  if (source.configEnabled === false || source.overrideState === 'disabled') return false
  return true
}

const TOKEN_CHARS = 3.5

/**
 * 给页面显示的路径：家目录写成 ~
 * @param {string} absolutePath
 * @param {string} homeDir
 * @returns {string}
 */
function displayPath(absolutePath, homeDir) {
  if (absolutePath === homeDir) return '~'
  return absolutePath.startsWith(`${homeDir}${path.sep}`) ? `~${absolutePath.slice(homeDir.length)}` : absolutePath
}

async function realpathOrNull(targetPath, deps = {}) {
  try {
    return await (deps.realpathFn || fs.realpath)(targetPath)
  } catch {
    return null
  }
}

/** 名字 + 说明的字符数 ÷ 3.5，粗估进上下文的 tokens */
function estimateTokens(items) {
  const chars = items.reduce((sum, item) => sum + String(item.displayName || item.name || '').length + String(item.description || '').length, 0)
  return Math.round(chars / TOKEN_CHARS)
}

/** 工具目录里同名、但 SKILL.md 已经找不到的条目（删了、快捷方式断了） */
async function findMissingEntries(roots, deps = {}) {
  const missing = []
  for (const { toolId, root } of roots) {
    let entries = []
    try {
      entries = await (deps.readdirFn || fs.readdir)(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isSymbolicLink() || !isSafeSkillName(entry.name)) continue
      const skillPath = path.join(root, entry.name)
      if (!(await pathExists(path.join(skillPath, 'SKILL.md'), deps)) && !(await realpathOrNull(skillPath, deps))) {
        missing.push({ toolId, name: entry.name, absolutePath: skillPath })
      }
    }
  }
  return missing
}

// 这些来源读不出时，整个工具的开关状态都说不准：工具本身、配置、Claude 设置，以及个人 Skill 目录（权限坏了不能当成一个都没装）
const UNREADABLE_ORIGINS = new Set(['tool', 'config', 'settings', 'user', 'legacy'])

/** 这个工具的状态读不出 */
function toolUnreadable(errors) {
  return errors.some((item) => UNREADABLE_ORIGINS.has(item.origin))
}

/**
 * 某个工具实际装载的 Skill 汇总；插件带的不在 sources 里，自然不算
 * @returns {object|null}
 */
function buildLoad(toolId, sources, errors) {
  if (toolUnreadable(errors)) return null
  const loaded = new Map()
  for (const source of sources) {
    if (!sourceEnabled(source) || loaded.has(source.name)) continue
    loaded.set(source.name, source)
  }
  // 按来源分桶：个人（可写）+ claude.ai 同步 / Codex 系统；旧命令、项目来源不算 Skill 装载
  const readOnlyOrigin = toolId === 'claude-code' ? 'synced' : 'system'
  const personalItems = [...loaded.values()].filter((item) => item.mutable)
  const readOnlyItems = [...loaded.values()].filter((item) => item.origin === readOnlyOrigin)
  const items = [...personalItems, ...readOnlyItems]
  const syncedBroken = toolId === 'claude-code' && errors.some((item) => item.origin === 'synced')
  const load = { personal: personalItems.length, total: items.length, tokens: estimateTokens(items) }
  if (toolId === 'claude-code') load.synced = syncedBroken ? null : readOnlyItems.length
  else load.system = readOnlyItems.length
  return load
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
        pluginSkills: Array.isArray(result?.pluginSkills) ? result.pluginSkills : [],
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
      load: buildLoad(toolId, result.sources, result.errors),
    }
  }
  const missingEntries = await findMissingEntries([
    { toolId: 'claude-code', root: path.join(homeDir, '.claude', 'skills') },
    { toolId: 'codex', root: path.join(homeDir, '.agents', 'skills') },
    { toolId: 'codex', root: path.join(homeDir, '.codex', 'skills') },
  ], overrides)
  const centralReal = await realpathOrNull(repoPath, overrides) || repoPath
  // 家目录本身可能经过软链接（macOS 的 /var → /private/var）：解析后的路径也写成 ~
  const homeReal = await realpathOrNull(homeDir, overrides) || homeDir
  const showPath = (absolute) => (absolute.startsWith(`${homeReal}${path.sep}`) ? displayPath(absolute, homeReal) : displayPath(absolute, homeDir))

  const skills = [...allNames].sort((a, b) => a.localeCompare(b)).map((name) => {
    const managed = central.skills.get(name) || null
    const origins = []
    const toolStates = {}
    for (const toolId of Object.keys(adapters)) {
      const sources = discovery[toolId].sources.filter((source) => source.name === name)
      origins.push(...sources.map((source) => publicOrigin({ toolId, ...source })))
      // 工具目录读不了、或配置读不出（开关状态无法确定）→ 都显示为不可用，不能按缺省当成已启用
      if (toolUnreadable(discovery[toolId].errors)) {
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
      // 同一个工具的个人目录里同名的几份内容不一样（例如 ~/.agents/skills 和 ~/.codex/skills 各一份）；
      // 同步来的、旧命令这类不同来源同名不算「两份」
      const entities = sources.filter((source) => source.origin === 'user' || source.origin === 'legacy')
      const hashes = new Set(entities.map((source) => source.manifest?.hash).filter(Boolean))
      toolStates[toolId] = {
        enabled,
        state,
        duplicate: entities.length > 1 && hashes.size > 1,
        mutable: Boolean(preferred.mutable),
        origin: preferred.origin,
        pluginId: preferred.pluginId,
        pluginName: preferred.pluginName,
        overrideState: preferred.overrideState,
        configEnabled: preferred.configEnabled,
      }
    }
    const describedOrigin = origins.find((origin) => origin.description)
    // 带同名 Skill 的插件（只作说明，插件本身不计入）
    const plugins = [...new Set(Object.values(discovery)
      .flatMap((item) => item.pluginSkills || [])
      .filter((item) => item.name === name)
      .map((item) => item.plugin))]
    return {
      name,
      displayName: managed?.displayName || describedOrigin?.displayName || name,
      description: managed?.description || describedOrigin?.description || '',
      managed: Boolean(managed),
      origins,
      tools: toolStates,
      plugins,
    }
  })

  // 位置：资产库在前，再按工具列出每一份；快捷方式指到资产库以外时给实际位置；不在了标出
  for (const skill of skills) {
    const locations = []
    const managed = central.skills.get(skill.name)
    if (managed) locations.push({ toolId: 'central', path: displayPath(managed.absolutePath, homeDir), missing: false })
    for (const toolId of Object.keys(adapters)) {
      for (const source of discovery[toolId].sources.filter((item) => item.name === skill.name)) {
        const location = { toolId, path: displayPath(source.absolutePath, homeDir), missing: false }
        if (source.isSymlink) {
          const real = await realpathOrNull(source.absolutePath, overrides)
          if (real && real !== path.join(centralReal, skill.name) && !real.startsWith(`${centralReal}${path.sep}`)) {
            location.target = showPath(real)
          }
        }
        locations.push(location)
      }
    }
    for (const entry of missingEntries.filter((item) => item.name === skill.name)) {
      locations.push({ toolId: entry.toolId, path: displayPath(entry.absolutePath, homeDir), missing: true })
    }
    skill.locations = locations
  }

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

/**
 * 从资产库删除一个 Skill，各工具里指向它的那份（快捷方式或内容一样的副本）一起删。
 * 先把每一处改名挪开，全部挪成功再真删；任何一处挪不动就把已挪的挪回去，一处都不删。
 * 工具的配置记录（skillOverrides、skills.config）不动：文件夹没了，这些记录不起作用。
 * @param {object} params
 * @param {object} deps - renameFn / rmFn 可注入
 * @returns {Promise<{success: true, deleted: string[]}>}
 */
async function deleteSkillEverywhere({ repoPath, homeDir, skillName }, deps = {}) {
  const centralPath = path.join(repoPath, skillName)
  if (!(await pathExists(path.join(centralPath, 'SKILL.md'), deps))) throw codedError('SKILL_NOT_FOUND')
  const centralReal = await realpathOrNull(centralPath, deps) || centralPath
  const centralManifest = await buildSkillManifest(centralPath, deps)
  const targets = [centralPath]
  for (const candidate of [
    path.join(homeDir, '.claude', 'skills', skillName),
    path.join(homeDir, '.agents', 'skills', skillName),
    path.join(homeDir, '.codex', 'skills', skillName),
  ]) {
    let stat
    try {
      stat = await (deps.lstatFn || fs.lstat)(candidate)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) {
      if ((await realpathOrNull(candidate, deps)) === centralReal) targets.push(candidate)
    } else if (stat.isDirectory()) {
      const manifest = await buildSkillManifest(candidate, deps).catch(() => null)
      if (manifest?.hash === centralManifest.hash) targets.push(candidate)
    }
  }
  const operationId = crypto.randomUUID()
  const moved = []
  try {
    for (const target of targets) {
      const parked = `${target}.codepal-delete-${operationId}`
      await (deps.renameFn || fs.rename)(target, parked)
      moved.push({ target, parked })
    }
  } catch (error) {
    for (const { target, parked } of moved.reverse()) await fs.rename(parked, target).catch(() => {})
    throw codedError(mapFsError(error), error)
  }
  for (const { parked } of moved) await (deps.rmFn || fs.rm)(parked, { recursive: true, force: true }).catch(() => {})
  return { success: true, deleted: targets.map((target) => displayPath(target, homeDir)) }
}

/** 执行统一 Skill 命令，并在 adapter 写入后由调用方重新读取原生状态。 */
async function executeSkillCommand(params = {}, overrides = {}) {
  if (!isSafeSkillName(params.skillName)) throw codedError('INVALID_SKILL_NAME')
  assertMutableSource(params.source)
  const homeDir = params.homeDir || overrides.homeDir || os.homedir()
  const repoPath = expandHome(params.repoPath, homeDir)
  if (!repoPath) throw codedError('INVALID_REPO_PATH')
  // 按来源这次只支持收进和停用：启用照旧从资产库链接出去，删除照旧整组删
  const hasSourceId = params.sourceId !== undefined && params.sourceId !== null
  if (hasSourceId && (params.action === 'enable' || params.action === 'delete')) throw codedError('SOURCE_ACTION_UNSUPPORTED')
  if (params.action === 'delete') {
    // 先确认要删的在资产库里，再补关：删不了的不该改 Codex 配置（删除会连带 ~/.codex、~/.agents 里的那份）
    if (!(await pathExists(path.join(repoPath, params.skillName, 'SKILL.md'), overrides))) throw codedError('SKILL_NOT_FOUND')
    if (params.toolId === 'codex' || params.toolId === 'all') await overrides.beforeCodexWriteFn?.()
    return deleteSkillEverywhere({ repoPath, homeDir, skillName: params.skillName }, overrides)
  }
  const adapter = loadAdapters(overrides)[params.toolId]
  if (!adapter) throw codedError('TOOL_NOT_SUPPORTED')
  const discovery = await adapter.discover({ homeDir, projectRoots: params.projectRoots || [], repoPath }, overrides)
  const matchingSources = (discovery?.sources || []).filter((source) => source.name === params.skillName)
  const chosenSource = selectSource(params, matchingSources)
  if (params.action === 'adopt') {
    const adoptParams = { ...params, repoPath, homeDir, source: chosenSource || params.source }
    // 收不了的（已在资产库、原件不在）先拒绝，再补关
    await adoptPaths(adoptParams, overrides)
    if (params.toolId === 'codex') await overrides.beforeCodexWriteFn?.()
    return adoptExternalSkill(adoptParams, overrides)
  }
  if (params.toolId === 'codex') await overrides.beforeCodexWriteFn?.()
  if (!adapter.apply) throw codedError('TOOL_NOT_SUPPORTED')
  // renderer 传来的 source 只作意图提示；真正写入位置始终采用刚刚重读到的来源。
  return adapter.apply({ ...params, repoPath, homeDir, source: chosenSource || params.source }, overrides)
}

/**
 * 选出这次命令要动的那一份来源；不合格时抛错，调用方在此之前不能有任何写入。
 * - 带 sourceId：只认那一份；找不到 SOURCE_NOT_FOUND，只读 ORIGIN_READ_ONLY
 * - 不带：照旧取第一份可写来源；同名只有只读来源时除启用外都报 ORIGIN_READ_ONLY
 * @returns {object|undefined} 选中的来源；没有同名来源时为 undefined
 */
function selectSource(params, matchingSources) {
  if (params.sourceId !== undefined && params.sourceId !== null) {
    const chosen = matchingSources.find((source) => sourceIdOf(params.toolId, source) === params.sourceId)
    if (!chosen) throw codedError('SOURCE_NOT_FOUND')
    if (!chosen.mutable) throw codedError('ORIGIN_READ_ONLY')
    return chosen
  }
  const mutableSource = matchingSources.find((source) => source.mutable)
  if (matchingSources.length > 0 && !mutableSource && params.action !== 'enable') throw codedError('ORIGIN_READ_ONLY')
  return mutableSource
}

/**
 * 收进前的检查：算出原件和资产库里的位置；已在资产库报 SKILL_ALREADY_MANAGED，原件不在报 EXTERNAL_SKILL_NOT_FOUND。
 * 只读不写，executeSkillCommand 在补关之前先调它。
 * @returns {Promise<{sourcePath: string, targetPath: string}>}
 */
async function adoptPaths(params = {}, deps = {}) {
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
  return { sourcePath, targetPath }
}

/** 将可变工具来源物化到中央仓库，不删除软链接上游。 */
async function adoptExternalSkill(params = {}, deps = {}) {
  const { sourcePath, targetPath } = await adoptPaths(params, deps)
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
  sourceIdOf,
  deleteSkillEverywhere,
  displayPath,
}
