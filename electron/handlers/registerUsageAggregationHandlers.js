/**
 * 用量聚合 IPC 注册器
 *
 * 负责：
 * - 注册日志扫描 IPC
 * - 注册区间聚合 IPC
 * - 注册预设周期聚合 IPC
 * - 将主进程真实进度事件转发给渲染层
 *
 * @module electron/handlers/registerUsageAggregationHandlers
 */

const { scanLogFilesInRange } = require('../logScanner')
const { handleScanLogFiles } = require('../scanLogFilesHandler')
const { handleAggregateUsageRange } = require('../aggregateUsageRangeHandler')
const { handleAggregateUsagePeriod } = require('../aggregateUsagePeriodHandler')

/**
 * 注册用量聚合相关 IPC handlers
 * @param {object} params - 注册依赖
 * @param {Electron.IpcMain} params.ipcMain - IPC 主进程实例
 * @param {(filepath: string) => string} params.expandHome - 展开 home 路径
 * @param {(filepath: string) => Promise<boolean>} params.pathExists - 检查路径是否存在
 * @param {string} params.homeDir - 当前用户主目录
 * @param {() => Date} [params.nowFn] - 当前时间工厂（测试用）
 */
function registerUsageAggregationHandlers({
  ipcMain,
  expandHome,
  pathExists,
  homeDir,
  nowFn = () => new Date()
}) {
  /**
   * 向当前请求对应的渲染进程发送进度事件
   * 为什么在主进程转发：
   * - invoke 本身只能返回最终结果，过程态必须靠独立事件推送
   * - 这样前端可以拿到“已完成天数 / 总天数”的真实进度，而不是假估时
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {object} progress - 进度载荷
   */
  function sendProgress(event, progress) {
    try {
      if (!event?.sender?.isDestroyed?.()) {
        event.sender.send('usage-aggregate:progress', progress)
      }
    } catch {
      // 页面销毁或切换时静默忽略，避免影响聚合主流程
    }
  }

  /**
   * 扫描日志文件
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {Object} params - 扫描参数
   * @returns {Promise<{success: boolean, files: Array, totalMatched: number, scannedCount: number, truncated: boolean, error: string|null}>}
   */
  ipcMain.handle('scan-log-files', async (event, params) => {
    return handleScanLogFiles(params, {
      expandHomeFn: expandHome,
      pathExistsFn: pathExists,
      scanLogFilesInRangeFn: scanLogFilesInRange
    })
  })

  /**
   * 聚合自定义日期范围用量
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {{taskId?: string, startDate?: string, endDate?: string, timezone?: string}} params - 聚合参数
   * @returns {Promise<{success: boolean, data?: object, meta?: object, error?: string}>}
   */
  ipcMain.handle('aggregate-usage-range', async (event, params) => {
    return handleAggregateUsageRange(params, {
      nowFn,
      homeDir,
      scanLogFilesInRangeFn: scanLogFilesInRange,
      onProgress: (progress) => sendProgress(event, progress)
    })
  })

  /**
   * 聚合预设周期用量（today/week/month/allTime）
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {{taskId?: string, period?: 'today'|'week'|'month'|'allTime', timezone?: string}} params - 聚合参数
   * @returns {Promise<{success: boolean, data?: object, meta?: object, error?: string}>}
   */
  ipcMain.handle('aggregate-usage-period', async (event, params) => {
    return handleAggregateUsagePeriod(params, {
      nowFn,
      homeDir,
      scanLogFilesInRangeFn: scanLogFilesInRange,
      onProgress: (progress) => sendProgress(event, progress)
    })
  })
}

module.exports = {
  registerUsageAggregationHandlers
}
