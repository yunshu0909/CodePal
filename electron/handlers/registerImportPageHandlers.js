/**
 * 导入页面相关 IPC handlers
 *
 * 负责：
 * - 扫描预设工具目录（技能数量统计）
 * - 扫描自定义路径（各工具子目录技能分布）
 * - 检查路径重复
 *
 * @module electron/handlers/registerImportPageHandlers
 */

const { scanCustomPathSkills } = require('../services/skillScanService')

/**
 * 注册导入页面相关 IPC handlers
 * @param {Object} deps - 依赖集合
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {(filepath: string) => string} deps.expandHome
 */
function registerImportPageHandlers({ ipcMain, expandHome }) {

  /**
   * 扫描自定义路径下各工具子目录的技能分布
   */
  ipcMain.handle('scan-custom-path', async (event, customPath) => {
    if (typeof customPath !== 'string' || customPath.length === 0) {
      return { success: false, skills: {}, error: 'INVALID_PATH' }
    }

    try {
      const expandedPath = expandHome(customPath)
      return await scanCustomPathSkills(expandedPath)
    } catch (error) {
      console.error('Error scanning custom path:', error)
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return { success: false, skills: {}, error: 'PERMISSION_DENIED' }
      }
      return { success: false, skills: {}, error: error.message }
    }
  })

}

module.exports = { registerImportPageHandlers }
