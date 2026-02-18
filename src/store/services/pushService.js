/**
 * 推送状态服务模块
 *
 * 负责：
 * - 技能推送/取消推送
 * - 推送状态缓存与批量检查
 * - 管理页技能推送状态聚合
 *
 * @module store/services/pushService
 */

/**
 * 创建推送状态服务实例
 * @param {Object} deps - 依赖集合
 * @returns {{
 *   getToolStatus: Function,
 *   isPushed: Function,
 *   clearPushStatusCache: Function,
 *   getBatchPushStatus: Function,
 *   pushSkills: Function,
 *   unpushSkills: Function,
 *   getSkillsWithStatus: Function
 * }}
 */
export function createPushService(deps) {
  // 推送状态缓存，避免重复 IPC 调用
  const pushStatusCache = new Map()

  /**
   * 获取所有工具的推送状态
   * @returns {Promise<Object>} 推送状态对象
   */
  async function getToolStatus() {
    const config = await deps.getConfig()
    return config.pushStatus || {}
  }

  /**
   * 检查技能是否已推送到指定工具（基于文件存在性检查）
   * @param {string} toolId - 工具 ID
   * @param {string} skillName - 技能名称
   * @returns {Promise<boolean>} 是否已推送
   */
  async function isPushed(toolId, skillName) {
    const tool = deps.toolDefinitions.find((t) => t.id === toolId)
    if (!tool) return false

    const cacheKey = `${toolId}:${skillName}`
    if (pushStatusCache.has(cacheKey)) {
      return pushStatusCache.get(cacheKey)
    }

    const skillPath = deps.getToolSkillPath(tool.path, skillName)
    const result = await deps.pathExists(skillPath)
    const pushed = result.success && result.exists

    pushStatusCache.set(cacheKey, pushed)
    return pushed
  }

  /**
   * 清除推送状态缓存
   */
  function clearPushStatusCache() {
    pushStatusCache.clear()
  }

  /**
   * 批量检查推送状态（带缓存优化）
   * @param {string[]} toolIds - 工具 ID 列表
   * @param {string[]} skillNames - 技能名称列表
   * @returns {Promise<Object>} 推送状态映射
   */
  async function getBatchPushStatus(toolIds, skillNames) {
    const result = {}

    for (const skillName of skillNames) {
      result[skillName] = {}
      for (const toolId of toolIds) {
        result[skillName][toolId] = await isPushed(toolId, skillName)
      }
    }

    return result
  }

  /**
   * 推送技能到指定工具（从中央仓库复制到工具目录）
   * @param {string} toolId - 工具 ID
   * @param {string[]} skillNames - 技能名称列表
   * @returns {Promise<{success: boolean, pushedCount: number, errors: Array|null}>}
   */
  async function pushSkills(toolId, skillNames) {
    const tool = deps.toolDefinitions.find((t) => t.id === toolId)
    if (!tool) {
      return { success: false, error: 'TOOL_NOT_FOUND' }
    }

    const errors = []
    let pushedCount = 0
    const repoPath = await deps.getRepoPath()

    for (const skillName of skillNames) {
      const sourcePath = await deps.getCentralSkillPath(skillName, repoPath)
      const targetPath = deps.getToolSkillPath(tool.path, skillName)

      const sourceExists = await deps.pathExists(sourcePath)
      if (!sourceExists.success || !sourceExists.exists) {
        errors.push(`${skillName}: not found in central repository`)
        continue
      }

      const copyResult = await deps.copySkill(sourcePath, targetPath, { force: true })

      if (copyResult.success) {
        pushedCount++
      } else {
        errors.push(`${skillName}: ${copyResult.error}`)
      }
    }

    const config = await deps.getConfig()
    if (!config.pushStatus) {
      config.pushStatus = {}
    }
    if (!config.pushStatus[toolId]) {
      config.pushStatus[toolId] = []
    }

    for (const skillName of skillNames) {
      if (!config.pushStatus[toolId].includes(skillName)) {
        config.pushStatus[toolId].push(skillName)
      }
    }

    await deps.saveConfig(config)
    clearPushStatusCache()

    return {
      success: errors.length === 0 || pushedCount > 0,
      pushedCount,
      errors: errors.length > 0 ? errors : null,
    }
  }

  /**
   * 取消推送技能从指定工具（从工具目录删除）
   * @param {string} toolId - 工具 ID
   * @param {string[]} skillNames - 技能名称列表
   * @returns {Promise<{success: boolean, unpushedCount: number, errors: Array|null}>}
   */
  async function unpushSkills(toolId, skillNames) {
    const tool = deps.toolDefinitions.find((t) => t.id === toolId)
    if (!tool) {
      return { success: false, error: 'TOOL_NOT_FOUND' }
    }

    const errors = []
    let unpushedCount = 0

    for (const skillName of skillNames) {
      const skillPath = deps.getToolSkillPath(tool.path, skillName)
      const deleteResult = await deps.deleteSkill(skillPath)

      if (deleteResult.success) {
        unpushedCount++
      } else if (deleteResult.error !== 'SOURCE_NOT_FOUND') {
        errors.push(`${skillName}: ${deleteResult.error}`)
      } else {
        // 用户手动删除也算目标达成，不阻断批量流程
        unpushedCount++
      }
    }

    const config = await deps.getConfig()
    if (config.pushStatus && config.pushStatus[toolId]) {
      config.pushStatus[toolId] = config.pushStatus[toolId].filter(
        (name) => !skillNames.includes(name)
      )
      await deps.saveConfig(config)
    }

    clearPushStatusCache()

    return {
      success: errors.length === 0 || unpushedCount > 0,
      unpushedCount,
      errors: errors.length > 0 ? errors : null,
    }
  }

  /**
   * 获取指定工具的技能及其推送状态（用于管理页面）
   * @param {string} toolId - 工具 ID
   * @returns {Promise<Array>} 带状态的技能列表
   */
  async function getSkillsWithStatus(toolId) {
    const [centralSkills] = await Promise.all([
      deps.getCentralSkills(),
      getToolStatus(),
    ])

    const skillsWithStatus = await Promise.all(
      centralSkills.map(async (skill) => {
        const pushed = await isPushed(toolId, skill.name)
        return {
          ...skill,
          pushed,
        }
      })
    )

    return skillsWithStatus
  }

  return {
    getToolStatus,
    isPushed,
    clearPushStatusCache,
    getBatchPushStatus,
    pushSkills,
    unpushSkills,
    getSkillsWithStatus,
  }
}
