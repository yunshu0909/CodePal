/**
 * 网络诊断 IPC 处理模块
 *
 * 负责：
 * - 注册出口 IP 状态查询 / 单次检测 / 前后台频率 / 持续监控开关 IPC channel
 *
 * @module electron/handlers/registerNetworkDiagnosticsHandlers
 */

const {
  probeIpOnce,
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
   * 按需执行一次公网 IP 检测，不改变持续监控开关、不创建定时器
   */
  ipcMain.handle('network:probeIpOnce', async () => {
    try {
      const data = await probeIpOnce()
      return { success: true, data, error: null }
    } catch (error) {
      return { success: false, data: getIpMonitorState(), error: error.message }
    }
  })

  /**
   * 切换采样频率（页面打开=5秒，离开=60秒）；关闭时不建 timer
   */
  ipcMain.handle('network:setIpMonitorFastMode', (_event, fast) => {
    setIpMonitorFastMode(fast)
    return { success: true, data: null, error: null }
  })

  /**
   * 开启/关闭持续监控（开关按钮，同时持久化）
   */
  ipcMain.handle('network:toggleIpMonitor', (_event, enabled) => {
    try {
      toggleIpMonitor(enabled)
      return { success: true, data: getIpMonitorState(), error: null }
    } catch (error) {
      return { success: false, data: getIpMonitorState(), error: error.message }
    }
  })
}

module.exports = { registerNetworkDiagnosticsHandlers }
