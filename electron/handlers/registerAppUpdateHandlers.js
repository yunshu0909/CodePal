/**
 * 应用更新 IPC 注册模块
 *
 * 负责：
 * - 注册应用更新状态读取、检查与下载页跳转 IPC
 * - 将主进程中的更新状态推送给渲染进程
 * - 统一封装“提醒式更新”入口，避免渲染层直接访问 GitHub API
 *
 * @module electron/handlers/registerAppUpdateHandlers
 */

const {
  DEFAULT_RELEASE_PAGE_URL,
  checkForAppUpdate,
  getAppUpdateState,
  subscribeAppUpdateState,
} = require('../services/appUpdateService')

/**
 * 安全推送更新状态到渲染进程
 * @param {Electron.BrowserWindow|undefined|null} window - 当前主窗口
 * @param {object} state - 更新状态
 */
function sendUpdateState(window, state) {
  if (!window || window.isDestroyed()) return

  // 状态可能在渲染层挂载前更新，因此这里尽量“能推就推”，丢失事件时由 get-state 兜底。
  window.webContents.send('app-update:state', state)
}

/**
 * 注册应用更新相关 IPC
 * @param {Object} deps - 依赖项
 * @param {Electron.IpcMain} deps.ipcMain - Electron ipcMain
 * @param {Electron.App} deps.app - Electron app
 * @param {Electron.Shell} deps.shell - Electron shell
 * @param {() => Electron.BrowserWindow|undefined} deps.getMainWindow - 获取主窗口的方法
 * @returns {{checkForUpdates: () => Promise<object>, cleanup: () => void}}
 */
function registerAppUpdateHandlers({ ipcMain, app, shell, getMainWindow }) {
  const emitState = (state) => {
    sendUpdateState(getMainWindow(), state)
  }

  const unsubscribe = subscribeAppUpdateState(emitState)

  /**
   * 主进程统一发起版本检查，避免多个渲染层同时打 GitHub API。
   * @returns {Promise<object>}
   */
  async function checkForUpdates() {
    return checkForAppUpdate(app.getVersion())
  }

  ipcMain.handle('app-update:get-state', () => ({
    ...getAppUpdateState(),
    currentVersion: app.getVersion(),
  }))


  ipcMain.handle('app-update:open-release-page', async () => {
    const { releaseUrl } = getAppUpdateState()
    const targetUrl = releaseUrl || DEFAULT_RELEASE_PAGE_URL

    await shell.openExternal(targetUrl)
    return { success: true, url: targetUrl }
  })

  return {
    checkForUpdates,
    cleanup: unsubscribe,
  }
}

module.exports = {
  registerAppUpdateHandlers,
}
