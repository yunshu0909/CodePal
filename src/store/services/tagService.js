/**
 * 标签服务模块
 *
 * 负责：
 * - 标签定义的 CRUD（创建、读取、重命名、删除）
 * - 技能-标签映射的绑定与解除
 * - 删除标签时自动清理关联映射
 *
 * @module store/services/tagService
 */

/** 标签名最大长度 */
const TAG_NAME_MAX_LENGTH = 10

/**
 * 创建标签服务实例
 * @param {Object} deps - 依赖集合
 * @param {Function} deps.getConfig - 获取配置
 * @param {Function} deps.saveConfig - 保存配置
 * @returns {{
 *   getTags: Function,
 *   getSkillTags: Function,
 *   createTag: Function,
 *   renameTag: Function,
 *   deleteTag: Function,
 *   setSkillTag: Function,
 *   removeSkillTag: Function
 * }}
 */
export function createTagService(deps) {
  /**
   * 获取所有标签定义
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async function getTags() {
    const config = await deps.getConfig()
    return config.tags || []
  }

  /**
   * 获取技能-标签映射
   * @returns {Promise<Object>} { skillId: tagId }
   */
  async function getSkillTags() {
    const config = await deps.getConfig()
    return config.skillTags || {}
  }

  /**
   * 创建新标签
   * @param {string} name - 标签名称
   * @returns {Promise<{success: boolean, tag?: Object, error?: string}>}
   */
  async function createTag(name) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return { success: false, error: 'EMPTY_NAME' }
    }

    const trimmedName = name.trim()

    if (trimmedName.length > TAG_NAME_MAX_LENGTH) {
      return { success: false, error: 'NAME_TOO_LONG' }
    }

    const config = await deps.getConfig()
    const tags = config.tags || []

    // 重名校验（不区分大小写）
    const duplicate = tags.some(
      (t) => t.name.toLowerCase() === trimmedName.toLowerCase()
    )
    if (duplicate) {
      return { success: false, error: 'DUPLICATE_NAME' }
    }

    const newTag = {
      id: `tag-${Date.now()}`,
      name: trimmedName,
    }

    config.tags = [...tags, newTag]
    const saveResult = await deps.saveConfig(config)

    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true, tag: newTag }
  }

  /**
   * 重命名标签
   * @param {string} tagId - 标签 ID
   * @param {string} newName - 新名称
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function renameTag(tagId, newName) {
    if (!newName || typeof newName !== 'string' || newName.trim().length === 0) {
      return { success: false, error: 'EMPTY_NAME' }
    }

    const trimmedName = newName.trim()

    if (trimmedName.length > TAG_NAME_MAX_LENGTH) {
      return { success: false, error: 'NAME_TOO_LONG' }
    }

    const config = await deps.getConfig()
    const tags = config.tags || []

    const targetTag = tags.find((t) => t.id === tagId)
    if (!targetTag) {
      return { success: false, error: 'TAG_NOT_FOUND' }
    }

    // 重名校验（排除自身）
    const duplicate = tags.some(
      (t) => t.id !== tagId && t.name.toLowerCase() === trimmedName.toLowerCase()
    )
    if (duplicate) {
      return { success: false, error: 'DUPLICATE_NAME' }
    }

    targetTag.name = trimmedName
    const saveResult = await deps.saveConfig(config)

    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true }
  }

  /**
   * 删除标签（同时清理所有指向该标签的技能映射）
   * @param {string} tagId - 标签 ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function deleteTag(tagId) {
    const config = await deps.getConfig()
    const tags = config.tags || []

    const index = tags.findIndex((t) => t.id === tagId)
    if (index === -1) {
      return { success: false, error: 'TAG_NOT_FOUND' }
    }

    // 删除标签定义
    config.tags = tags.filter((t) => t.id !== tagId)

    // 清理 skillTags 中所有指向该标签的映射
    const skillTags = config.skillTags || {}
    for (const skillId of Object.keys(skillTags)) {
      if (skillTags[skillId] === tagId) {
        delete skillTags[skillId]
      }
    }
    config.skillTags = skillTags

    const saveResult = await deps.saveConfig(config)

    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true }
  }

  /**
   * 给技能设置标签（一对一：一个技能只属于一个标签）
   * @param {string} skillId - 技能 ID
   * @param {string} tagId - 标签 ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function setSkillTag(skillId, tagId) {
    const config = await deps.getConfig()

    // 校验标签存在
    const tags = config.tags || []
    if (!tags.some((t) => t.id === tagId)) {
      return { success: false, error: 'TAG_NOT_FOUND' }
    }

    if (!config.skillTags) config.skillTags = {}
    config.skillTags[skillId] = tagId

    const saveResult = await deps.saveConfig(config)

    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true }
  }

  /**
   * 移除技能的标签
   * @param {string} skillId - 技能 ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function removeSkillTag(skillId) {
    const config = await deps.getConfig()

    if (!config.skillTags || !(skillId in config.skillTags)) {
      // 静默处理：没有标签也算成功
      return { success: true }
    }

    delete config.skillTags[skillId]

    const saveResult = await deps.saveConfig(config)

    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true }
  }

  return {
    getTags,
    getSkillTags,
    createTag,
    renameTag,
    deleteTag,
    setSkillTag,
    removeSkillTag,
  }
}
