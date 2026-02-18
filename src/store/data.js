/**
 * 数据存储模块
 *
 * 负责：
 * - 扫描工具目录获取技能
 * - 中央仓库的导入/导出
 * - 推送状态管理
 * - 推送目标与导入来源配置管理
 * - 增量导入支持
 *
 * @module store/data
 */

import {
  scanToolDirectory,
  copySkill,
  deleteSkill,
  ensureDir,
  pathExists,
  readConfig,
  writeConfig,
  selectFolder,
  scanCustomPath,
} from './fs.js'
import {
  normalizePathForCompare,
  dedupeCustomPaths,
  getToolSkillPath,
  buildCustomToolPath,
} from './services/pathService.js'
import { createImportService } from './services/importService.js'
import { createPushService } from './services/pushService.js'

// Tool definitions (paths only, skills will be scanned)
export const toolDefinitions = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: 'CC',
    iconClass: 'cc',
    path: '~/.claude/skills/',
  },
  {
    id: 'codex',
    name: 'CodeX',
    icon: 'CX',
    iconClass: 'cx',
    path: '~/.codex/skills/',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'CU',
    iconClass: 'cu',
    path: '~/.cursor/skills/',
  },
  {
    id: 'trae',
    name: 'Trae',
    icon: 'TR',
    iconClass: 'tr',
    path: '~/.trae/skills/',
  },
]

// Default central repository path
const DEFAULT_REPO_PATH = '~/Documents/SkillManager/'
const CONFIG_FILE = '.config.json'

// In-memory cache for config to avoid repeated reads
let configCache = null

// 添加自定义路径串行队列，避免双击确认导致并发写入重复路径
let addCustomPathQueue = Promise.resolve()

/**
 * 获取配置文件完整路径（基于当前仓库路径）
 * @param {string} repoPath - 中央仓库路径
 * @returns {string} 配置文件路径
 */
function getConfigPath(repoPath) {
  const normalizedPath = repoPath.endsWith('/') ? repoPath : `${repoPath}/`
  return `${normalizedPath}${CONFIG_FILE}`
}

/**
 * 获取中央仓库路径（从配置读取，或使用默认值）
 * @returns {Promise<string>} 中央仓库路径
 */
async function getRepoPath() {
  const config = await dataStore.getConfig()
  return config.repoPath || DEFAULT_REPO_PATH
}

/**
 * 获取中央仓库中技能的路径
 * @param {string} skillName - 技能名称
 * @param {string} repoPath - 中央仓库路径（可选，默认从配置读取）
 * @returns {Promise<string>} 技能路径
 */
async function getCentralSkillPath(skillName, repoPath = null) {
  const basePath = repoPath || (await getRepoPath())
  const normalizedPath = basePath.endsWith('/') ? basePath : `${basePath}/`
  return `${normalizedPath}${skillName}`
}

/**
 * 数据存储对象
 * 提供技能导入、推送、状态管理等操作
 */
export const dataStore = {
  /**
   * 扫描所有工具目录并返回结果
   * @returns {Promise<Array>} 工具扫描结果列表
   */
  async scanAllTools() {
    const results = []

    for (const tool of toolDefinitions) {
      const result = await scanToolDirectory(tool.path)
      results.push({
        id: tool.id,
        name: tool.name,
        icon: tool.icon,
        iconClass: tool.iconClass,
        path: tool.path,
        skills: result.success ? result.skills : [],
        error: result.error || null,
        scanned: true,
      })
    }

    return results
  },

  /**
   * 扫描指定工具目录
   * @param {string} toolId - 工具 ID
   * @returns {Promise<Object>} 扫描结果
   */
  async scanTool(toolId) {
    const tool = toolDefinitions.find((t) => t.id === toolId)
    if (!tool) {
      return { success: false, error: 'TOOL_NOT_FOUND', skills: [] }
    }

    const result = await scanToolDirectory(tool.path)
    return {
      ...result,
      id: tool.id,
      name: tool.name,
      icon: tool.icon,
      iconClass: tool.iconClass,
      path: tool.path,
    }
  },

  /**
   * 获取中央仓库中的所有技能
   * @returns {Promise<Array>} 技能列表
   */
  async getCentralSkills() {
    const repoPath = await getRepoPath()
    const result = await scanToolDirectory(repoPath)

    if (!result.success) {
      return []
    }

    // Transform to central skill format
    return result.skills.map((skill) => ({
      id: skill.name,
      name: skill.name,
      displayName: skill.displayName,
      desc: skill.desc,
      source: 'unknown', // Will be updated during import
    }))
  },

  /**
   * 检查中央仓库是否有技能
   * @returns {Promise<boolean>} 是否有技能
   */
  async hasCentralSkills() {
    const skills = await this.getCentralSkills()
    return skills.length > 0
  },

  /**
   * 从 .config.json 读取配置
   * 优先从缓存读取，支持指定仓库路径
   * @param {string} repoPath - 可选，指定仓库路径
   * @returns {Promise<Object>} 配置对象
   */
  async getConfig(repoPath = null) {
    // Return cached config if available and no specific path requested
    if (configCache && !repoPath) {
      return configCache
    }

    const basePath = repoPath || DEFAULT_REPO_PATH
    const configPath = getConfigPath(basePath)
    const result = await readConfig(configPath)

    let config
    if (result && result.success) {
      config = result.data
    } else {
      // Return default config if read fails
      config = {
        version: '0.4',
        repoPath: DEFAULT_REPO_PATH,
        customPaths: [],
        pushStatus: {},
        pushTargets: [],
        importSources: [],
        firstEntryAfterImport: false,
      }
    }

    // Ensure required fields exist
    if (!config.repoPath) config.repoPath = DEFAULT_REPO_PATH
    if (!config.customPaths) config.customPaths = []
    config.customPaths = dedupeCustomPaths(config.customPaths)
    if (!config.pushStatus) config.pushStatus = {}

    // V0.4: 确保新字段存在（向后兼容）
    if (!config.version) config.version = '0.4'
    if (!config.pushTargets) config.pushTargets = []
    if (!config.importSources) config.importSources = []
    if (config.firstEntryAfterImport === undefined) config.firstEntryAfterImport = false

    // Update cache
    if (!repoPath) {
      configCache = config
    }

    return config
  },

  /**
   * 保存配置到 .config.json
   * @param {Object} config - 配置对象
   * @param {string} repoPath - 可选，指定仓库路径
   * @returns {Promise<Object>} 保存结果
   */
  async saveConfig(config, repoPath = null) {
    const basePath = repoPath || config.repoPath || DEFAULT_REPO_PATH
    const configPath = getConfigPath(basePath)

    // Ensure version field (V0.4)
    if (!config.version) config.version = '0.4'

    const result = await writeConfig(configPath, config)
    if (!result || typeof result.success !== 'boolean') {
      return { success: false, error: 'WRITE_FAILED' }
    }

    // Update cache on success
    if (result.success && !repoPath) {
      configCache = config
    }

    return result
  },

  /**
   * 清除配置缓存（用于重新读取）
   */
  clearConfigCache() {
    configCache = null
  },

  // ==================== 中央仓库路径管理 ====================

  /**
   * 获取当前中央仓库路径
   * @returns {Promise<string>} 中央仓库路径
   */
  async getRepoPath() {
    const config = await this.getConfig()
    return config.repoPath || DEFAULT_REPO_PATH
  },

  /**
   * 设置中央仓库路径
   * 迁移现有配置到新路径
   * @param {string} newPath - 新仓库路径
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  async setRepoPath(newPath) {
    if (!newPath || typeof newPath !== 'string') {
      return { success: false, error: 'INVALID_PATH' }
    }

    // Normalize path
    const normalizedPath = newPath.endsWith('/') ? newPath : `${newPath}/`

    // Get current config before changing path
    const currentConfig = await this.getConfig()

    // Update repo path in config
    currentConfig.repoPath = normalizedPath

    // Ensure new directory exists
    const ensureResult = await ensureDir(normalizedPath)
    if (!ensureResult.success) {
      return { success: false, error: ensureResult.error }
    }

    // Save config to new location
    const saveResult = await this.saveConfig(currentConfig, normalizedPath)
    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    // 在默认路径也保存一份，重启时能通过默认路径找到新仓库位置
    if (normalizedPath !== DEFAULT_REPO_PATH) {
      await ensureDir(DEFAULT_REPO_PATH)
      await this.saveConfig(currentConfig, DEFAULT_REPO_PATH)
    }

    // Update cache
    configCache = currentConfig

    return { success: true, error: null }
  },

  /**
   * 选择文件夹对话框并设置为中央仓库
   * @returns {Promise<{success: boolean, path: string|null, canceled: boolean, error: string|null}>}
   */
  async selectAndSetRepoPath() {
    const result = await selectFolder()

    if (!result.success || result.canceled) {
      return { success: false, path: null, canceled: true, error: result.error }
    }

    const setResult = await this.setRepoPath(result.path)

    if (!setResult.success) {
      return { success: false, path: null, canceled: false, error: setResult.error }
    }

    return { success: true, path: result.path, canceled: false, error: null }
  },

  // ==================== 自定义路径管理 ====================

  /**
   * 获取所有自定义路径
   * @returns {Promise<Array>} 自定义路径列表
   */
  async getCustomPaths() {
    const config = await this.getConfig()
    return config.customPaths || []
  },

  /**
   * 扫描自定义路径中的 skills
   * @param {string} basePath - 基础路径
   * @returns {Promise<{success: boolean, skills: Object, error: string|null}>}
   *   skills format: { claude: 5, codex: 3 }
   */
  async scanCustomPath(basePath) {
    return scanCustomPath(basePath)
  },

  /**
   * 添加自定义路径
   * 扫描路径并保存到配置
   * @param {string} path - 自定义路径
   * @returns {Promise<{success: boolean, customPath: Object|null, error: string|null}>}
   */
  async addCustomPath(path) {
    const runAddCustomPath = async () => {
      if (!path || typeof path !== 'string') {
        return { success: false, customPath: null, error: 'INVALID_PATH' }
      }

      const config = await this.getConfig()
      const normalizedPath = normalizePathForCompare(path)

      // Check for duplicate path
      config.customPaths = dedupeCustomPaths(config.customPaths)
      const exists = config.customPaths.some(
        (cp) => normalizePathForCompare(cp.path) === normalizedPath
      )
      if (exists) {
        return { success: false, customPath: null, error: 'PATH_ALREADY_EXISTS' }
      }

      // Scan path for skills
      const scanResult = await this.scanCustomPath(path)
      if (!scanResult.success) {
        return { success: false, customPath: null, error: scanResult.error }
      }

      // Check if any skills found
      const skillEntries = Object.entries(scanResult.skills)
      const totalSkills = skillEntries.reduce((sum, [, count]) => sum + count, 0)

      if (totalSkills === 0) {
        return { success: false, customPath: null, error: 'NO_SKILLS_FOUND' }
      }

      // 二次校验：并发场景下，扫描耗时期间该路径可能已被其他请求写入
      config.customPaths = dedupeCustomPaths(config.customPaths)
      const existsAfterScan = config.customPaths.some(
        (cp) => normalizePathForCompare(cp.path) === normalizedPath
      )
      if (existsAfterScan) {
        return { success: false, customPath: null, error: 'PATH_ALREADY_EXISTS' }
      }

      // Create custom path entry
      const customPath = {
        id: `custom-${Date.now()}`,
        path: normalizedPath,
        skills: scanResult.skills,
      }

      // Add to config
      config.customPaths.push(customPath)

      // Save config
      const saveResult = await this.saveConfig(config)
      if (!saveResult.success) {
        return { success: false, customPath: null, error: saveResult.error }
      }

      return { success: true, customPath, error: null }
    }

    // 串行执行，确保同一时刻只有一个 addCustomPath 任务写配置
    const queuedTask = addCustomPathQueue.then(runAddCustomPath, runAddCustomPath)
    addCustomPathQueue = queuedTask.then(() => undefined, () => undefined)
    return queuedTask
  },

  /**
   * 删除自定义路径
   * @param {string} customPathId - 自定义路径 ID
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  async deleteCustomPath(customPathId) {
    if (!customPathId) {
      return { success: false, error: 'INVALID_ID' }
    }

    const config = await this.getConfig()

    const index = config.customPaths.findIndex((cp) => cp.id === customPathId)
    if (index === -1) {
      return { success: false, error: 'PATH_NOT_FOUND' }
    }

    // Remove from config
    config.customPaths.splice(index, 1)

    // Save config
    const saveResult = await this.saveConfig(config)
    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true, error: null }
  },

  /**
   * 选择文件夹并添加为自定义路径
   * @returns {Promise<{success: boolean, customPath: Object|null, canceled: boolean, error: string|null}>}
   */
  async selectAndAddCustomPath() {
    const result = await selectFolder()

    if (!result.success || result.canceled) {
      return { success: false, customPath: null, canceled: true, error: result.error }
    }

    const addResult = await this.addCustomPath(result.path)

    return {
      success: addResult.success,
      customPath: addResult.customPath,
      canceled: false,
      error: addResult.error,
    }
  },

  /**
   * 获取所有工具的推送状态
   * @returns {Promise<Object>} 推送状态对象
   */
  async getToolStatus() {
    return pushService.getToolStatus()
  },

  /**
   * 检查技能是否已推送到指定工具（基于文件存在性检查）
   * 使用内存缓存避免重复 IPC 调用
   * @param {string} toolId - 工具 ID
   * @param {string} skillName - 技能名称
   * @returns {Promise<boolean>} 是否已推送
   */
  async isPushed(toolId, skillName) {
    return pushService.isPushed(toolId, skillName)
  },

  /**
   * 清除推送状态缓存
   * 在操作完成后调用以刷新状态
   */
  clearPushStatusCache() {
    pushService.clearPushStatusCache()
  },

  /**
   * 批量检查推送状态（带缓存优化）
   * @param {string[]} toolIds - 工具 ID 列表
   * @param {string[]} skillNames - 技能名称列表
   * @returns {Promise<Object>} 推送状态映射 { [skillName]: { [toolId]: boolean } }
   */
  async getBatchPushStatus(toolIds, skillNames) {
    const result = {}

    // 初始化结果对象
    for (const skillName of skillNames) {
      result[skillName] = {}
      for (const toolId of toolIds) {
        result[skillName][toolId] = await this.isPushed(toolId, skillName)
      }
    }

    return result
  },

  /**
   * 从选中的工具导入技能到中央仓库
   * 如果技能已存在则强制覆盖
   * @param {string[]} selectedToolIds - 选中的工具 ID 列表
   * @param {string[]} selectedCustomPathIds - 选中的自定义路径 ID 列表（可选）
   * @returns {Promise<{success: boolean, copiedCount: number, errors: Array|null}>} 导入结果
   */
  async importSkills(selectedToolIds, selectedCustomPathIds = []) {
    return importService.importSkills(selectedToolIds, selectedCustomPathIds)
  },

  /**
   * 推送技能到指定工具（从中央仓库复制到工具目录）
   * @param {string} toolId - 工具 ID
   * @param {string[]} skillNames - 技能名称列表
   * @returns {Promise<{success: boolean, pushedCount: number, errors: Array|null}>} 推送结果
   */
  async pushSkills(toolId, skillNames) {
    return pushService.pushSkills(toolId, skillNames)
  },

  /**
   * 取消推送技能从指定工具（从工具目录删除）
   * @param {string} toolId - 工具 ID
   * @param {string[]} skillNames - 技能名称列表
   * @returns {Promise<{success: boolean, unpushedCount: number, errors: Array|null}>} 取消推送结果
   */
  async unpushSkills(toolId, skillNames) {
    return pushService.unpushSkills(toolId, skillNames)
  },

  /**
   * 获取指定工具的技能及其推送状态（用于管理页面）
   * @param {string} toolId - 工具 ID
   * @returns {Promise<Array>} 带状态的技能列表
   */
  async getSkillsWithStatus(toolId) {
    const [centralSkills] = await Promise.all([
      this.getCentralSkills(),
      this.getToolStatus(),
    ])

    const skillsWithStatus = await Promise.all(
      centralSkills.map(async (skill) => {
        const isPushed = await this.isPushed(toolId, skill.name)
        return {
          ...skill,
          pushed: isPushed,
        }
      })
    )

    return skillsWithStatus
  },

  /**
   * 重新导入：清空中央仓库并从工具重新导入
   * @param {string[]} selectedToolIds - 选中的工具 ID 列表
   * @param {string[]} selectedCustomPathIds - 选中的自定义路径 ID 列表（可选）
   * @returns {Promise<{success: boolean, copiedCount: number, errors: Array|null}>} 导入结果
   */
  async reimportSkills(selectedToolIds, selectedCustomPathIds = []) {
    const repoPath = await getRepoPath()
    const currentSkills = await this.getCentralSkills()

    for (const skill of currentSkills) {
      const skillPath = await getCentralSkillPath(skill.name, repoPath)
      await deleteSkill(skillPath)
    }

    const config = await this.getConfig()
    const newConfig = {
      version: '0.4',
      repoPath: config.repoPath || DEFAULT_REPO_PATH,
      customPaths: config.customPaths || [],
      pushStatus: {},
      pushTargets: config.pushTargets || [],
      importSources: config.importSources || [],
      firstEntryAfterImport: false,
    }
    await this.saveConfig(newConfig)

    // 保留通过 this.importSkills 转调，兼容单测中的方法级 mock
    return this.importSkills(selectedToolIds, selectedCustomPathIds)
  },

  // ==================== 推送目标管理 (V0.4) ====================

  /**
   * 获取启用的推送目标列表
   * @returns {Promise<string[]>} 工具ID数组
   */
  async getPushTargets() {
    const config = await this.getConfig()
    const configuredTargets = Array.isArray(config.pushTargets) ? config.pushTargets : []
    const validTargets = configuredTargets.filter((targetId) =>
      toolDefinitions.some((tool) => tool.id === targetId)
    )

    // 兼容历史配置：空数组或无效值时自动回退到全部预设工具，避免管理页“点击无响应”
    if (validTargets.length === 0) {
      const fallbackTargets = toolDefinitions.map((tool) => tool.id)
      config.pushTargets = fallbackTargets
      await this.saveConfig(config)
      return fallbackTargets
    }

    // 清理失效配置（例如已删除/拼写错误的工具ID）
    if (validTargets.length !== configuredTargets.length) {
      config.pushTargets = validTargets
      await this.saveConfig(config)
    }

    return validTargets
  },

  /**
   * 保存推送目标配置
   * @param {string[]} targets - 工具ID列表
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  async savePushTargets(targets) {
    if (!Array.isArray(targets)) {
      return { success: false, error: 'INVALID_TARGETS' }
    }

    const config = await this.getConfig()
    config.pushTargets = targets

    const saveResult = await this.saveConfig(config)
    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true, error: null }
  },

  /**
   * 首次进入管理页时初始化推送目标
   * 规则：
   * - 如果导入页选中了预设工具，则默认推送目标 = 这些预设工具
   * - 如果仅选中自定义路径，则默认推送目标 = 全部预设工具
   * @param {string[]} selectedTools - 导入页选中的工具ID列表
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  async initPushTargetsAfterImport(selectedTools) {
    const hasPresetTools = selectedTools.some((id) =>
      toolDefinitions.some((t) => t.id === id)
    )

    let targets
    if (hasPresetTools) {
      // 有选中预设工具，推送目标 = 选中的预设工具
      targets = selectedTools.filter((id) =>
        toolDefinitions.some((t) => t.id === id)
      )
    } else {
      // 仅选中自定义路径，推送目标 = 全部预设工具
      targets = toolDefinitions.map((t) => t.id)
    }

    return this.savePushTargets(targets)
  },

  // ==================== 导入来源管理 (V0.4) ====================

  /**
   * 获取启用的导入来源列表
   * @returns {Promise<string[]>} 来源ID数组（预设工具ID或自定义路径ID）
   */
  async getImportSources() {
    const config = await this.getConfig()
    return config.importSources || []
  },

  /**
   * 保存导入来源配置
   * @param {string[]} sources - 来源ID列表
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  async saveImportSources(sources) {
    if (!Array.isArray(sources)) {
      return { success: false, error: 'INVALID_SOURCES' }
    }

    const config = await this.getConfig()
    config.importSources = sources

    const saveResult = await this.saveConfig(config)
    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true, error: null }
  },

  // ==================== 增量导入 (V0.4) ====================

  /**
   * 增量导入 - 仅新增不覆盖
   * @param {string[]} customPathIds - 要导入的自定义路径ID列表
   * @returns {Promise<{success: boolean, added: number, skipped: number, errors: Array|null}>}
   * 逻辑：
   * 1. 扫描自定义路径获取 skills
   * 2. 对比中央仓库现有 skills（按 skill 名称）
   * 3. 中央仓库不存在的：复制到中央仓库，added++
   * 4. 中央仓库已存在的：跳过，skipped++（保持现有状态不变）
   * 5. 返回统计结果
   */
  async incrementalImport(customPathIds) {
    return importService.incrementalImport(customPathIds)
  },

  /**
   * 自动增量刷新导入来源（仅新增，不覆盖，不删除）
   * @returns {Promise<{success: boolean, added: number, skipped: number, scannedSources: number, errors: Array|null}>}
   */
  async autoIncrementalRefresh() {
    return importService.autoIncrementalRefresh()
  },

  // ==================== 首次进入标记 (V0.4) ====================

  /**
   * 获取是否导入后首次进入管理页
   * @returns {Promise<boolean>}
   */
  async isFirstEntryAfterImport() {
    const config = await this.getConfig()
    return config.firstEntryAfterImport === true
  },

  /**
   * 设置导入后首次进入标记
   * @param {boolean} value
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  async setFirstEntryAfterImport(value) {
    const config = await this.getConfig()
    config.firstEntryAfterImport = value

    const saveResult = await this.saveConfig(config)
    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true, error: null }
  },

  /**
   * 获取上次导入时选中的工具ID（用于初始化推送目标）
   * @returns {string[]} 工具ID列表
   */
  getLastImportedToolIds() {
    return importService.getLastImportedToolIds()
  },
}

const pushService = createPushService({
  toolDefinitions,
  pathExists,
  copySkill,
  deleteSkill,
  getRepoPath,
  getCentralSkillPath,
  getToolSkillPath,
  getConfig: (...args) => dataStore.getConfig(...args),
  saveConfig: (...args) => dataStore.saveConfig(...args),
  getCentralSkills: (...args) => dataStore.getCentralSkills(...args),
})

const importService = createImportService({
  toolDefinitions,
  scanToolDirectory,
  scanCustomPath,
  copySkill,
  deleteSkill,
  ensureDir,
  getRepoPath,
  getCentralSkillPath,
  getToolSkillPath,
  buildCustomToolPath,
  getConfig: (...args) => dataStore.getConfig(...args),
  saveConfig: (...args) => dataStore.saveConfig(...args),
  getCentralSkills: (...args) => dataStore.getCentralSkills(...args),
  setFirstEntryAfterImport: (...args) => dataStore.setFirstEntryAfterImport(...args),
  clearPushStatusCache: () => dataStore.clearPushStatusCache(),
  DEFAULT_REPO_PATH,
})
