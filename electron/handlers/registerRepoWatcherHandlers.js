/**
 * 中央仓库监听 IPC 注册模块
 *
 * 负责：
 * - 注册 watcher 生命周期和同步锁的 IPC handlers
 * - 启动中央仓库文件监听
 * - 将变更事件推送到渲染进程
 * - 关窗停监听后，再开窗口时恢复（记住最新仓库路径；启停串行，快速关 / 开不打架）
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
 * @param {() => object} [deps.createWatcher] - watcher 工厂（测试注入）
 * @returns {{ stopWatching: () => Promise<void>, ensureWatching: () => Promise<void> }} 停止 / 按需恢复
 */
function registerRepoWatcherHandlers({ ipcMain, getMainWindow, expandHome, initialRepoPath, createWatcher = createRepoWatcher }) {
  const repoWatcher = createWatcher()
  // 当前仓库路径：改仓库路径时更新，重开窗口恢复监听时用它
  let currentRepoPath = expandHome(initialRepoPath)
  // 启停串行：关窗（停）和马上重开（开）不能交错，否则可能刚开就被旧的停掉
  let lifecycle = Promise.resolve()
  const serial = (task) => {
    const result = lifecycle.then(task, task)
    lifecycle = result.catch(() => {})
    return result
  }

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
  serial(() => repoWatcher.startWatching(currentRepoPath, onRepoChanged)).catch((error) => {
    console.error('[repo-watcher] Start failed:', error)
  })

  // 重启 watcher（仓库路径变更时由渲染进程调用）
  ipcMain.handle('restart-repo-watcher', async (event, newRepoPath) => {
    try {
      const expandedNewPath = expandHome(newRepoPath)
      currentRepoPath = expandedNewPath
      await serial(() => repoWatcher.restartWatching(expandedNewPath, onRepoChanged))
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
    stopWatching: () => serial(() => repoWatcher.stopWatching()),
    // 窗口（重新）创建时调用：没在监听就用当前仓库路径恢复；已在监听则什么都不做
    ensureWatching: () => serial(async () => {
      if (!repoWatcher.isWatching()) await repoWatcher.startWatching(currentRepoPath, onRepoChanged)
    }),
  }
}

module.exports = { registerRepoWatcherHandlers }
