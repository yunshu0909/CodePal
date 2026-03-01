/**
 * 中央仓库监听 IPC 注册模块
 *
 * 负责：
 * - 注册 watcher 生命周期和同步锁的 IPC handlers
 * - 启动中央仓库文件监听
 * - 将变更事件推送到渲染进程
 *
 * @module electron/handlers/registerRepoWatcherHandlers
 */

const { createRepoWatcher } = require('../services/repoWatcherService')

/**
 * 注册中央仓库监听相关 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {() => import('electron').BrowserWindow|null} deps.getMainWindow - 获取主窗口
 * @param {(filepath: string) => string} deps.expandHome - 家目录展开函数
 * @param {string} deps.initialRepoPath - 初始仓库路径（含 ~）
 * @returns {{ stopWatching: () => Promise<void> }} 清理函数
 */
function registerRepoWatcherHandlers({ ipcMain, getMainWindow, expandHome, initialRepoPath }) {
  const repoWatcher = createRepoWatcher()

  /**
   * 变更回调：将变更的技能名列表推送到渲染进程
   * @param {string[]} skillNames - 变更的技能名列表
   */
  function onRepoChanged(skillNames) {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('central-repo-changed', skillNames)
    }
  }

  // 启动监听
  const expandedPath = expandHome(initialRepoPath)
  repoWatcher.startWatching(expandedPath, onRepoChanged)

  // 重启 watcher（仓库路径变更时由渲染进程调用）
  ipcMain.handle('restart-repo-watcher', async (event, newRepoPath) => {
    try {
      const expandedNewPath = expandHome(newRepoPath)
      await repoWatcher.restartWatching(expandedNewPath, onRepoChanged)
      return { success: true }
    } catch (error) {
      console.error('[repo-watcher] Restart failed:', error)
      return { success: false, error: error.message }
    }
  })

  // 获取同步锁（方向 2 写入中央仓库前调用）
  ipcMain.handle('acquire-sync-lock', () => {
    repoWatcher.acquireSyncLock()
    return { success: true }
  })

  // 释放同步锁（方向 2 写入完成后调用）
  ipcMain.handle('release-sync-lock', () => {
    repoWatcher.releaseSyncLock()
    return { success: true }
  })

  return {
    stopWatching: () => repoWatcher.stopWatching(),
  }
}

module.exports = { registerRepoWatcherHandlers }
