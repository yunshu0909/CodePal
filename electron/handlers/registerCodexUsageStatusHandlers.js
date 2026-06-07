/**
 * Codex 会员额度状态 IPC 处理模块
 *
 * 负责：
 * - 读取 Codex 最新 rate_limits 接入状态（只读 ~/.codex/sessions 日志，零配置）
 *
 * @module electron/handlers/registerCodexUsageStatusHandlers
 */

const { createCodexUsageStatusService } = require('../services/codexUsageStatusService')

/**
 * 注册 Codex 会员额度状态 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 */
function registerCodexUsageStatusHandlers({ ipcMain, pathExists }) {
  const codexUsageStatusService = createCodexUsageStatusService({ pathExists })

  /**
   * IPC: 获取 Codex 会员额度状态
   */
  ipcMain.handle('codex-usage-status:get-state', async () => {
    return codexUsageStatusService.getCodexUsageStatusState()
  })

  /**
   * IPC: 获取 Codex 满载率趋势（按自然周聚合 7 天窗口峰值）
   */
  ipcMain.handle('codex-usage-status:get-trend', async () => {
    return codexUsageStatusService.getCodexUsageTrend()
  })
}

module.exports = {
  registerCodexUsageStatusHandlers,
}
