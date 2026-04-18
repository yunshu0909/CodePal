/**
 * 模型注册表 IPC 注册模块
 *
 * 负责：
 * - 暴露 model-registry:get IPC，供渲染层读取当前生效的 registry 快照
 * - 封装对 modelRegistryService 的调用
 *
 * @module electron/handlers/registerModelRegistryHandlers
 */

const { getEffectiveRegistry } = require('../services/modelRegistryService')

/**
 * 注册 model registry IPC handlers
 * @param {Object} deps - 依赖
 * @param {Electron.IpcMain} deps.ipcMain - Electron ipcMain
 */
function registerModelRegistryHandlers({ ipcMain }) {
  ipcMain.handle('model-registry:get', () => {
    const { registry, source } = getEffectiveRegistry()
    return { success: true, registry, source }
  })
}

module.exports = {
  registerModelRegistryHandlers,
}
