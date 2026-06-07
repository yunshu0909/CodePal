/**
 * Skill 使用次数 IPC 注册器
 *
 * 负责：
 * - 注册 `aggregate-skill-usage` 通道，统计每个 skill 近 N 天的 Claude+Codex 调用次数
 *
 * @module electron/handlers/registerSkillUsageHandlers
 */

const { scanLogFilesInRange } = require('../logScanner')
const { scanSkillUsage } = require('../services/skillUsageScanService')

/**
 * 注册 Skill 使用次数相关 IPC handlers
 * @param {object} params - 注册依赖
 * @param {Electron.IpcMain} params.ipcMain - IPC 主进程实例
 * @param {(filepath: string) => Promise<boolean>} params.pathExists - 路径存在判断
 * @param {string} params.homeDir - 当前用户主目录
 * @param {() => Date} [params.nowFn] - 当前时间工厂（测试用）
 */
function registerSkillUsageHandlers({ ipcMain, pathExists, homeDir, nowFn = () => new Date() }) {
  /**
   * 聚合 skill 调用次数（近 windowDays 天，Claude+Codex 合计）
   * @param {Electron.IpcMainInvokeEvent} _event - IPC 事件
   * @param {{windowDays?: number, skillNames?: string[]}} params - 参数
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  ipcMain.handle('aggregate-skill-usage', async (_event, params) => {
    try {
      const data = await scanSkillUsage(
        { homeDir, scanLogFilesInRangeFn: scanLogFilesInRange, pathExistsFn: pathExists, nowFn },
        {
          windowDays: params?.windowDays ?? 30,
          skillNames: Array.isArray(params?.skillNames) ? params.skillNames : [],
        }
      )
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error?.message || 'SKILL_USAGE_SCAN_FAILED' }
    }
  })
}

module.exports = { registerSkillUsageHandlers }
