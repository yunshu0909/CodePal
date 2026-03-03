/**
 * 自定义路径管理服务
 *
 * 负责：
 * - 自定义路径的增删查
 * - 路径去重与串行队列控制
 * - 自定义路径扫描
 *
 * @module store/services/customPathManager
 */

import { normalizePathForCompare, dedupeCustomPaths } from './pathService.js'

/**
 * 创建自定义路径管理器
 * @param {Object} deps - 依赖注入
 * @param {Function} deps.getConfig - 获取配置
 * @param {Function} deps.saveConfig - 保存配置
 * @param {Function} deps.scanCustomPath - 扫描自定义路径
 * @param {Function} deps.selectFolder - 选择文件夹对话框
 * @returns {Object} 自定义路径管理器
 */
export function createCustomPathManager(deps) {
  const { getConfig, saveConfig, scanCustomPath, selectFolder } = deps

  // 添加自定义路径串行队列，避免双击确认导致并发写入重复路径
  let addCustomPathQueue = Promise.resolve()

  return {
    /**
     * 获取所有自定义路径
     * @returns {Promise<Array>} 自定义路径列表
     */
    async getCustomPaths() {
      const config = await getConfig()
      return config.customPaths || []
    },

    /**
     * 扫描自定义路径中的 skills
     * @param {string} basePath - 基础路径
     * @returns {Promise<{success: boolean, skills: Object, error: string|null}>}
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

        const config = await getConfig()
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

        config.customPaths.push(customPath)

        const saveResult = await saveConfig(config)
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

      const config = await getConfig()

      const index = config.customPaths.findIndex((cp) => cp.id === customPathId)
      if (index === -1) {
        return { success: false, error: 'PATH_NOT_FOUND' }
      }

      config.customPaths.splice(index, 1)

      const saveResult = await saveConfig(config)
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
  }
}
