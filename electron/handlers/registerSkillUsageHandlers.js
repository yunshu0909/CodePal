/**
 * Skill 使用次数 IPC 注册器
 *
 * 负责：
 * - 注册 `aggregate-skill-usage` 通道，扫描后从 v2 ledger 统计有效调用
 * - 保留 `list-skill-run-samples` 通道名，详情只读 invocation ledger
 *
 * @module electron/handlers/registerSkillUsageHandlers
 */

const { scanSkillUsage } = require('../services/skillUsageScanService')
const { listSkillInvocationRecords } = require('../services/skillRunSampleService')

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
   * 聚合 Skill 使用统计（主数字为 ledger 已记录的有效 invocation）
   * @param {Electron.IpcMainInvokeEvent} _event - IPC 事件
   * @param {{windowDays?: number, skillNames?: string[]}} params - 参数
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  ipcMain.handle('aggregate-skill-usage', async (_event, params) => {
    try {
      const data = await scanSkillUsage(
        { homeDir, pathExistsFn: pathExists, nowFn },
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

  /**
   * 获取单个 skill 的调用记录（近 windowDays 天）
   * @param {Electron.IpcMainInvokeEvent} _event - IPC 事件
   * @param {{skillName?: string, windowDays?: number}} params - 参数
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  ipcMain.handle('list-skill-run-samples', async (_event, params) => {
    try {
      const skillName = typeof params?.skillName === 'string' ? params.skillName : ''
      if (!skillName) {
        return { success: false, error: 'SKILL_NAME_REQUIRED' }
      }

      const data = await listSkillInvocationRecords(
        { homeDir, nowFn },
        {
          windowDays: params?.windowDays ?? 30,
          skillName,
        }
      )
      const {
        ledgerPath: _ledgerPath,
        ...publicData
      } = data
      return {
        success: true,
        data: publicData,
      }
    } catch (error) {
      return { success: false, error: error?.message || 'SKILL_INVOCATION_LIST_FAILED' }
    }
  })
}

module.exports = { registerSkillUsageHandlers }
