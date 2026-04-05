/**
 * 网络诊断 IPC 处理模块
 *
 * 负责：
 * - 注册 IP 监控状态查询/控制 IPC channel
 * - 注册 API 端点连通性检测 IPC channel
 *
 * @module electron/handlers/registerNetworkDiagnosticsHandlers
 */

const {
  probeAllEndpoints,
  getIpMonitorState,
  setIpMonitorFastMode,
  toggleIpMonitor,
} = require('../services/networkDiagnosticsService')

/**
 * 注册网络诊断 IPC handlers
 * @param {Object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 */
function registerNetworkDiagnosticsHandlers({ ipcMain }) {
  /**
   * 获取 IP 监控当前状态（页面打开时拉取历史数据）
   */
  ipcMain.handle('network:getIpMonitorState', () => {
    return { success: true, data: getIpMonitorState(), error: null }
  })

  /**
   * 切换采样频率（页面打开=5秒，离开=30秒）
   */
  ipcMain.handle('network:setIpMonitorFastMode', (_event, fast) => {
    setIpMonitorFastMode(fast)
    return { success: true, data: null, error: null }
  })

  /**
   * 暂停/恢复 IP 监控（开关按钮）
   */
  ipcMain.handle('network:toggleIpMonitor', (_event, enabled) => {
    toggleIpMonitor(enabled)
    return { success: true, data: getIpMonitorState(), error: null }
  })

  /**
   * 并行检测所有 API 端点连通性
   */
  ipcMain.handle('network:probeEndpoints', async () => {
    try {
      const results = await probeAllEndpoints()
      return { success: true, data: results, error: null }
    } catch (error) {
      return { success: false, data: null, error: error.message }
    }
  })
}

module.exports = { registerNetworkDiagnosticsHandlers }
