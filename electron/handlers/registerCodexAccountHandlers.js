/**
 * Codex 账户 IPC 注册
 *
 * 注册的 channels：
 *   codex-account:list          — 列所有账户 + 当前激活
 *   codex-account:save          — 保存当前 auth.json 为新槽位
 *   codex-account:switch        — 切换账户（含 Codex 重启）
 *   codex-account:rename        — 重命名槽位
 *   codex-account:delete        — 删除槽位（留冷备份）
 *   codex-account:detect-storage — 检测 file/keyring 模式
 *   codex-account:open-codex    — 打开 Codex.app
 *   codex-account:refresh-slot  — V1.6.2 手动续签指定槽位（UI 重新登录入口）
 *
 * V1.6.2 启动 3 件事：
 *   - chokidar watcher（同 V1.5.0）
 *   - codexTokenRefresher.recoverFromCrash() 崩溃恢复
 *   - 后台 sweep 定时器（30 秒后首次 + 每 24h）
 *
 * @module electron/handlers/registerCodexAccountHandlers
 */

const accountService = require('../services/codexAccountService')
const authWatcher = require('../services/codexAuthWatcher')
const refresher = require('../services/codexTokenRefresher')

const SWEEP_FIRST_DELAY_MS = 30 * 1000           // 启动后 30 秒触发首次 sweep
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000    // 每 24 小时

let _stopWatcher = null
let _sweepFirstTimer = null
let _sweepIntervalTimer = null

/**
 * 注册 Codex 账户相关 IPC + 启动 watcher + 启动 token refresher
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').App} [deps.app] - 用于读取应用版本号给 User-Agent
 * @param {() => import('electron').BrowserWindow | null} deps.getMainWindow
 */
function registerCodexAccountHandlers({ ipcMain, app, getMainWindow }) {
  // V1.6.2: 设置诚实 User-Agent
  if (app && typeof app.getVersion === 'function') {
    refresher.setUserAgent(app.getVersion())
  }

  // V1.6.2: 启动时崩溃恢复（扫 .recovery-* 文件）
  refresher.recoverFromCrash().then((stats) => {
    if (stats.recovered > 0 || stats.failed > 0) {
      console.log(`[codex-refresher] crash recovery: ${stats.recovered} recovered, ${stats.failed} failed`)
    }
  }).catch((err) => {
    console.warn('[codex-refresher] crash recovery error:', err?.message || err)
  })

  // V1.6.2: 后台 sweep（启动后延迟 30 秒首次，避免和启动峰值争资源；之后每 24h）
  if (!_sweepFirstTimer) {
    _sweepFirstTimer = setTimeout(() => {
      refresher.sweepAllSlots().then((stats) => {
        console.log('[codex-refresher] initial sweep:', JSON.stringify(stats))
      }).catch((err) => {
        console.warn('[codex-refresher] initial sweep error:', err?.message || err)
      })
    }, SWEEP_FIRST_DELAY_MS)
  }
  if (!_sweepIntervalTimer) {
    _sweepIntervalTimer = setInterval(() => {
      refresher.sweepAllSlots().then((stats) => {
        console.log('[codex-refresher] periodic sweep:', JSON.stringify(stats))
      }).catch((err) => {
        console.warn('[codex-refresher] periodic sweep error:', err?.message || err)
      })
    }, SWEEP_INTERVAL_MS)
  }

  // 启动 watcher（整个 app 生命周期一份）
  if (!_stopWatcher) {
    _stopWatcher = authWatcher.startWatching({
      onNewAccountDetected: (payload) => {
        const win = typeof getMainWindow === 'function' ? getMainWindow() : null
        if (win && !win.isDestroyed()) {
          win.webContents.send('codex-account:new-account-detected', payload)
        }
      },
      onError: (err) => {
        console.warn('[codex-account:watcher]', err?.message || err)
      },
    })
  }

  ipcMain.handle('codex-account:list', async () => {
    try {
      const result = await accountService.listSavedAccounts()
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error?.message || 'LIST_FAILED' }
    }
  })

  ipcMain.handle('codex-account:save', async (_event, payload) => {
    const { name } = payload || {}
    try {
      return await accountService.saveAccount(name)
    } catch (error) {
      return { success: false, error: error?.message || 'SAVE_FAILED' }
    }
  })

  ipcMain.handle('codex-account:switch', async (_event, payload) => {
    const { targetName, restartCodex = false } = payload || {}
    try {
      return await accountService.switchAccount(targetName, { restartCodex })
    } catch (error) {
      return { success: false, error: error?.message || 'SWITCH_FAILED' }
    }
  })

  ipcMain.handle('codex-account:rename', async (_event, payload) => {
    const { oldName, newName } = payload || {}
    try {
      return await accountService.renameAccount(oldName, newName)
    } catch (error) {
      return { success: false, error: error?.message || 'RENAME_FAILED' }
    }
  })

  ipcMain.handle('codex-account:delete', async (_event, payload) => {
    const { name } = payload || {}
    try {
      return await accountService.deleteAccount(name)
    } catch (error) {
      return { success: false, error: error?.message || 'DELETE_FAILED' }
    }
  })

  ipcMain.handle('codex-account:detect-storage', async () => {
    try {
      return { success: true, ...(await accountService.detectStorageMode()) }
    } catch (error) {
      return { success: false, error: error?.message || 'DETECT_FAILED' }
    }
  })

  ipcMain.handle('codex-account:open-codex', async () => {
    try {
      return await accountService.openCodex()
    } catch (error) {
      return { success: false, error: error?.message || 'OPEN_FAILED' }
    }
  })

  // V1.6.2: 手动续签指定槽位（UI 重新登录入口 / 调试用）
  ipcMain.handle('codex-account:refresh-slot', async (_event, payload) => {
    const { name, force = true } = payload || {}
    if (!name || !accountService.__INTERNAL__.SAFE_NAME_REGEX.test(name)) {
      return { success: false, error: 'INVALID_NAME' }
    }
    try {
      return await refresher.ensureFreshCodexToken({
        filePath: accountService.__INTERNAL__.accountPath(name),
        force,
      })
    } catch (error) {
      return { success: false, error: error?.message || 'REFRESH_FAILED' }
    }
  })
}

/**
 * 停止 watcher + sweep 定时器（app quit 时调）
 */
async function stopCodexAccountWatcher() {
  if (_sweepFirstTimer) {
    clearTimeout(_sweepFirstTimer)
    _sweepFirstTimer = null
  }
  if (_sweepIntervalTimer) {
    clearInterval(_sweepIntervalTimer)
    _sweepIntervalTimer = null
  }
  if (_stopWatcher) {
    await _stopWatcher()
    _stopWatcher = null
  }
}

module.exports = { registerCodexAccountHandlers, stopCodexAccountWatcher }
