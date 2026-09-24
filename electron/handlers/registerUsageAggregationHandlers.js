/**
 * 用量聚合 IPC 注册器
 *
 * 负责：
 * - 注册用量日历 IPC（唯一仍在用的用量聚合入口，数据来自共享统计）
 * - 将主进程真实进度事件转发给渲染层
 *
 * 旧的日志扫描 / 区间 / 周期 / DSH / 最早日期通道已无渲染层入口，B2-7 下线。
 *
 * @module electron/handlers/registerUsageAggregationHandlers
 */

const { aggregateUsageCalendar } = require('../services/usageCalendarService')

/**
 * 注册用量聚合相关 IPC handlers
 * @param {object} params - 注册依赖
 * @param {Electron.IpcMain} params.ipcMain - IPC 主进程实例
 * @param {string} params.homeDir - 当前用户主目录
 * @param {object} params.statistics - 共享用量统计
 * @param {() => Date} [params.nowFn] - 当前时间工厂（测试用）
 */
function registerUsageAggregationHandlers({
  ipcMain,
  homeDir,
  statistics,
  nowFn = () => new Date()
}) {
  ipcMain.handle('aggregate-usage-calendar', (event, params) => aggregateUsageCalendar(params, {
    nowFn, homeDir, statistics,
    onProgress: progress => {
      try {
        if (!event?.sender?.isDestroyed?.()) event.sender.send('usage-calendar:progress', progress)
      } catch { /* A closed renderer cannot turn a valid day's result into a scan failure. */ }
    }
  }))
}

module.exports = {
  registerUsageAggregationHandlers
}
