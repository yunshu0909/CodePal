/**
 * 主进程 → 页面的跳转桥
 *
 * 负责：
 * - 从主进程要求页面切到某个模块（如点系统通知后切到网络诊断）
 * - 窗口在：恢复最小化、显示、聚焦，页面已加载完就直接推送 app:navigate
 * - 窗口不在或还在加载：新建窗口 / 记下待跳转，页面挂载时通过 app:consumePendingNavigation 领取
 *
 * @module electron/services/appNavigation
 */

/**
 * 创建跳转桥
 * @param {object} deps
 * @param {() => import('electron').BrowserWindow|null} deps.getWindow
 * @param {() => void} deps.createWindow
 * @param {{focus: (options: {steal: boolean}) => void}} deps.app
 * @returns {{requestNavigate: (moduleId: string) => void, consumePending: () => string|null}}
 */
function createNavigationBridge({ getWindow, createWindow, app }) {
  let pending = null

  function requestNavigate(moduleId) {
    const win = getWindow?.()
    if (!win || win.isDestroyed()) {
      pending = moduleId
      createWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    app?.focus?.({ steal: true })
    if (win.webContents.isLoading()) {
      pending = moduleId
      return
    }
    pending = null
    win.webContents.send('app:navigate', moduleId)
  }

  /** 页面挂载时领取一次，领完清空，避免刷新后重复跳转 */
  function consumePending() {
    const value = pending
    pending = null
    return value
  }

  return { requestNavigate, consumePending }
}

module.exports = { createNavigationBridge }
