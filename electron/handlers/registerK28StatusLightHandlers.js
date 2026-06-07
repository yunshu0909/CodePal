/**
 * K28 状态灯 IPC 处理模块
 *
 * 负责：
 * - 注册状态查询、配置保存、测试播报、测试灯色等 IPC channel
 * - 隔离渲染层与本机脚本/敏感配置文件的直接接触
 *
 * @module electron/handlers/registerK28StatusLightHandlers
 */

const {
  getK28StatusLightState,
  installK28StatusLight,
  saveK28StatusLightConfig,
  testK28Voice,
  testK28Light,
  clearK28States,
  openK28Directory,
} = require('../services/k28StatusLightService')
const {
  fixK28AudioOutput,
  startK28AudioGuard,
} = require('../services/k28AudioGuardService')

/**
 * 注册 K28 状态灯 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {import('electron').Shell} deps.shell - Electron shell
 */
function registerK28StatusLightHandlers({ ipcMain, shell }) {
  startK28AudioGuard()

  ipcMain.handle('k28-status-light:get-state', () => {
    return getK28StatusLightState()
  })

  ipcMain.handle('k28-status-light:install', () => {
    return installK28StatusLight()
  })

  ipcMain.handle('k28-status-light:save-config', (_event, updates) => {
    return saveK28StatusLightConfig(updates)
  })

  ipcMain.handle('k28-status-light:test-voice', (_event, text) => {
    return testK28Voice(text)
  })

  ipcMain.handle('k28-status-light:test-light', (_event, state) => {
    return testK28Light(state)
  })

  ipcMain.handle('k28-status-light:clear-states', () => {
    return clearK28States()
  })

  ipcMain.handle('k28-status-light:fix-audio-output', () => {
    return fixK28AudioOutput()
  })

  ipcMain.handle('k28-status-light:open-directory', () => {
    return openK28Directory(shell)
  })
}

module.exports = { registerK28StatusLightHandlers }
