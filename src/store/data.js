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
  compareSkillContent,
} from './fs.js'
import {
  dedupeCustomPaths,
  getToolSkillPath,
  buildCustomToolPath,
} from './services/pathService.js'
import { createImportService } from './services/importService.js'
import { createPushService } from './services/pushService.js'
import { createTagService } from './services/tagService.js'
import { createAutoSyncService } from './services/autoSyncService.js'
import { createCustomPathManager } from './services/customPathManager.js'
import { createRepoPathManager } from './services/repoPathManager.js'

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

// 配置保存后的回调队列，用于自动清除依赖缓存（如 pushStatusCache）
// 避免新代码路径遗漏手动调 clearXxxCache()
const onConfigSavedCallbacks = []

/**
 * 注册配置保存后的回调（用于缓存联动失效）
 * @param {() => void} callback
 */
function registerOnConfigSaved(callback) {
  onConfigSavedCallbacks.push(callback)
}

/**
 * 触发所有配置保存后的回调
 */
function fireOnConfigSaved() {
  for (const cb of onConfigSavedCallbacks) {
    try { cb() } catch (_) { /* 静默处理：回调不应阻断主流程 */ }
  }
}

/**
 * 规范化仓库路径（补齐末尾斜杠）
 * @param {string} pathValue - 原始路径
 * @returns {string}
 */
function normalizeRepoPath(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return DEFAULT_REPO_PATH
  }
  return pathValue.endsWith('/') ? pathValue : `${pathValue}/`
}

/**
 * 获取默认配置对象
 * @returns {Object}
 */
function createDefaultConfig() {
  return {
    version: '0.4',
    repoPath: DEFAULT_REPO_PATH,
    customPaths: [],
    pushStatus: {},
    pushTargets: [],
    importSources: [],
    firstEntryAfterImport: false,
    tags: [],
    skillTags: {},
  }
}

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

    /**
     * 读取并补齐配置
     * @param {string} basePath - 配置所在目录
     * @returns {Promise<Object>}
     */
    const readAndNormalizeConfig = async (basePath) => {
      const configPath = getConfigPath(basePath)
      const result = await readConfig(configPath)
      const rawConfig = result && result.success ? result.data : createDefaultConfig()
      const config = {
        ...createDefaultConfig(),
        ...(rawConfig || {}),
      }

      config.repoPath = normalizeRepoPath(config.repoPath || basePath)
      config.customPaths = dedupeCustomPaths(config.customPaths)
      return config
    }

    const normalizedDefaultPath = normalizeRepoPath(DEFAULT_REPO_PATH)
    let config = await readAndNormalizeConfig(repoPath || normalizedDefaultPath)

    // 默认读取时，先从锚点拿 repoPath，再读取真实仓库配置，避免“默认文件和仓库文件”分裂
    if (!repoPath) {
      const normalizedRepoPath = normalizeRepoPath(config.repoPath)
      if (normalizedRepoPath !== normalizedDefaultPath) {
        config = await readAndNormalizeConfig(normalizedRepoPath)
      }
    }

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
    const basePath = normalizeRepoPath(repoPath || config.repoPath || DEFAULT_REPO_PATH)
    const configPath = getConfigPath(basePath)
    const normalizedDefaultPath = normalizeRepoPath(DEFAULT_REPO_PATH)

    // Ensure version field (V0.4)
    if (!config.version) config.version = '0.4'
    config.repoPath = normalizeRepoPath(config.repoPath || basePath)

    const result = await writeConfig(configPath, config)
    if (!result || typeof result.success !== 'boolean') {
      return { success: false, error: 'WRITE_FAILED' }
    }

    // 当中央仓库不在默认目录时，同步写回默认锚点文件，保证重启后仍能定位真实仓库配置
    if (result.success && !repoPath && basePath !== normalizedDefaultPath) {
      const ensureDefaultDirResult = await ensureDir(normalizedDefaultPath)
      if (!ensureDefaultDirResult.success) {
        return { success: false, error: ensureDefaultDirResult.error || 'DEFAULT_ANCHOR_DIR_FAILED' }
      }

      const defaultAnchorPath = getConfigPath(normalizedDefaultPath)
      const defaultAnchorWriteResult = await writeConfig(defaultAnchorPath, config)
      if (!defaultAnchorWriteResult || !defaultAnchorWriteResult.success) {
        return {
          success: false,
          error: defaultAnchorWriteResult?.error || 'DEFAULT_ANCHOR_WRITE_FAILED',
        }
      }
    }

    // Update cache on success, then notify dependent caches
    if (result.success && !repoPath) {
      configCache = config
      fireOnConfigSaved()
    }

    return result
  },

  /**
   * 清除配置缓存（用于重新读取）
   */
  clearConfigCache() {
    configCache = null
  },

  // ==================== 中央仓库路径管理（委托 repoPathManager） ====================

  async getRepoPath() {
    return repoPathManager.getRepoPath()
  },

  async setRepoPath(newPath) {
    const result = await repoPathManager.setRepoPath(newPath)
    // 同步内存缓存
    if (result.success) {
      configCache = await this.getConfig()
    }
    return result
  },

  async selectAndSetRepoPath() {
    return repoPathManager.selectAndSetRepoPath()
  },

  // ==================== 自定义路径管理（委托 customPathManager） ====================

  async getCustomPaths() {
    return customPathManager.getCustomPaths()
  },

  async scanCustomPath(basePath) {
    return customPathManager.scanCustomPath(basePath)
  },

  async addCustomPath(path) {
    return customPathManager.addCustomPath(path)
  },

  async deleteCustomPath(customPathId) {
    return customPathManager.deleteCustomPath(customPathId)
  },

  async selectAndAddCustomPath() {
    return customPathManager.selectAndAddCustomPath()
  },

  // ==================== 推送状态管理（委托 pushService） ====================

  async getToolStatus() { return pushService.getToolStatus() },
  async isPushed(toolId, skillName) { return pushService.isPushed(toolId, skillName) },
  clearPushStatusCache() { pushService.clearPushStatusCache() },

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

  async importSkills(selectedToolIds, selectedCustomPathIds = []) {
    return importService.importSkills(selectedToolIds, selectedCustomPathIds)
  },
  async pushSkills(toolId, skillNames) { return pushService.pushSkills(toolId, skillNames) },
  async unpushSkills(toolId, skillNames) { return pushService.unpushSkills(toolId, skillNames) },

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

  // ==================== 自动同步 (V0.14) ====================

  /**
   * 处理中央仓库变更事件（方向 1：中央→工具）
   * @param {string[]} changedSkillNames - 变更的技能名列表
   * @returns {Promise<{syncedCount: number, errors: string[]}>}
   */
  async handleCentralRepoChanged(changedSkillNames) {
    return autoSyncService.handleCentralRepoChanged(changedSkillNames)
  },

  // ==================== 标签管理 (V0.13) ====================

  /**
   * 获取所有标签定义
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async getTags() {
    return tagService.getTags()
  },

  /**
   * 获取技能-标签映射
   * @returns {Promise<Object>} { skillId: tagId }
   */
  async getSkillTags() {
    return tagService.getSkillTags()
  },

  /**
   * 创建新标签
   * @param {string} name - 标签名称
   * @returns {Promise<{success: boolean, tag?: Object, error?: string}>}
   */
  async createTag(name) {
    return tagService.createTag(name)
  },

  /**
   * 重命名标签
   * @param {string} tagId - 标签 ID
   * @param {string} newName - 新名称
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async renameTag(tagId, newName) {
    return tagService.renameTag(tagId, newName)
  },

  /**
   * 删除标签（同时清理关联映射）
   * @param {string} tagId - 标签 ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteTag(tagId) {
    return tagService.deleteTag(tagId)
  },

  /**
   * 给技能设置标签
   * @param {string} skillId - 技能 ID
   * @param {string} tagId - 标签 ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async setSkillTag(skillId, tagId) {
    return tagService.setSkillTag(skillId, tagId)
  },

  /**
   * 移除技能的标签
   * @param {string} skillId - 技能 ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async removeSkillTag(skillId) {
    return tagService.removeSkillTag(skillId)
  },
}

const customPathManager = createCustomPathManager({
  getConfig: (...args) => dataStore.getConfig(...args),
  saveConfig: (...args) => dataStore.saveConfig(...args),
  scanCustomPath,
  selectFolder,
})

const repoPathManager = createRepoPathManager({
  getConfig: (...args) => dataStore.getConfig(...args),
  saveConfig: (...args) => dataStore.saveConfig(...args),
  ensureDir,
  selectFolder,
  DEFAULT_REPO_PATH,
})

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

const tagService = createTagService({
  getConfig: (...args) => dataStore.getConfig(...args),
  saveConfig: (...args) => dataStore.saveConfig(...args),
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
  compareSkillContent,
  getConfig: (...args) => dataStore.getConfig(...args),
  saveConfig: (...args) => dataStore.saveConfig(...args),
  getCentralSkills: (...args) => dataStore.getCentralSkills(...args),
  setFirstEntryAfterImport: (...args) => dataStore.setFirstEntryAfterImport(...args),
  clearPushStatusCache: () => dataStore.clearPushStatusCache(),
  DEFAULT_REPO_PATH,
})

const autoSyncService = createAutoSyncService({
  getPushTargets: (...args) => dataStore.getPushTargets(...args),
  getConfig: (...args) => dataStore.getConfig(...args),
  pushSkills: (toolId, skillNames) => pushService.pushSkills(toolId, skillNames),
  clearPushStatusCache: () => dataStore.clearPushStatusCache(),
})

// 注册缓存联动：saveConfig 成功后自动清除 pushStatusCache
// 作为安全网，即使新代码路径忘了手动 clear 也不会读到脏缓存
registerOnConfigSaved(() => pushService.clearPushStatusCache())
