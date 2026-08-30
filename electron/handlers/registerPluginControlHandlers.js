/**
 * Plugin 控制中心 IPC 注册器
 *
 * @module electron/handlers/registerPluginControlHandlers
 */

const { getPluginControlSnapshot, executePluginCommand } = require('../services/pluginControlService')

function registerPluginControlHandlers({ ipcMain, homeDir }, deps = {}) {
  const getSnapshot = deps.getPluginControlSnapshotFn || getPluginControlSnapshot
  const execute = deps.executePluginCommandFn || executePluginCommand
  ipcMain.handle('plugin-control:get-snapshot', async (_event, params) => {
    try {
      return { success: true, data: await getSnapshot({ homeDir, projectPath: params?.projectPath }, deps), error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'PLUGIN_CONTROL_SCAN_FAILED' }
    }
  })
  ipcMain.handle('plugin-control:execute', async (_event, params) => {
    try {
      const data = await execute({ ...params, homeDir }, deps)
      return { success: true, ...data, error: null }
    } catch (error) {
      return { success: false, data: null, snapshot: null, error: error?.code || 'PLUGIN_CONTROL_COMMAND_FAILED' }
    }
  })
}

module.exports = { registerPluginControlHandlers }
