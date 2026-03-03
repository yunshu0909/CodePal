/**
 * 中央仓库路径管理服务
 *
 * 负责：
 * - 中央仓库路径读取与设置
 * - 路径迁移（配置同步到新路径）
 * - 文件夹选择对话框集成
 *
 * @module store/services/repoPathManager
 */

/**
 * 创建仓库路径管理器
 * @param {Object} deps - 依赖注入
 * @param {Function} deps.getConfig - 获取配置
 * @param {Function} deps.saveConfig - 保存配置
 * @param {Function} deps.ensureDir - 确保目录存在
 * @param {Function} deps.selectFolder - 选择文件夹对话框
 * @param {string} deps.DEFAULT_REPO_PATH - 默认仓库路径
 * @returns {Object} 仓库路径管理器
 */
export function createRepoPathManager(deps) {
  const { getConfig, saveConfig, ensureDir, selectFolder, DEFAULT_REPO_PATH } = deps

  return {
    /**
     * 获取当前中央仓库路径
     * @returns {Promise<string>} 中央仓库路径
     */
    async getRepoPath() {
      const config = await getConfig()
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

      const normalizedPath = newPath.endsWith('/') ? newPath : `${newPath}/`
      const currentConfig = await getConfig()

      currentConfig.repoPath = normalizedPath

      const ensureResult = await ensureDir(normalizedPath)
      if (!ensureResult.success) {
        return { success: false, error: ensureResult.error }
      }

      const saveResult = await saveConfig(currentConfig, normalizedPath)
      if (!saveResult.success) {
        return { success: false, error: saveResult.error }
      }

      // 在默认路径也保存一份，重启时能通过默认路径找到新仓库位置
      if (normalizedPath !== DEFAULT_REPO_PATH) {
        const ensureDefaultResult = await ensureDir(DEFAULT_REPO_PATH)
        if (!ensureDefaultResult.success) {
          return { success: false, error: ensureDefaultResult.error || 'DEFAULT_ANCHOR_DIR_FAILED' }
        }
        const anchorResult = await saveConfig(currentConfig, DEFAULT_REPO_PATH)
        if (!anchorResult || !anchorResult.success) {
          return { success: false, error: anchorResult?.error || 'DEFAULT_ANCHOR_WRITE_FAILED' }
        }
      }

      // 通知主进程重启文件监听
      window.electronAPI?.restartRepoWatcher?.(normalizedPath).catch(() => {})

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
  }
}
