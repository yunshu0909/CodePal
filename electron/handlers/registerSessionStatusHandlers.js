/**
 * 会话状态 IPC 与后台监听（#41，取代原 K28 状态灯）
 *
 * 负责：
 * - 总开关（默认开）：读 / 写开关状态，打开时装钩子、关掉时删钩子
 * - 启动时开关开着就静默装好 / 修好钩子，失败原因留给页面显示
 * - 启动状态文件监听，变化推给页面 session-status:changed，并按规则发系统通知
 * - 页面告诉主进程自己是否正在前台显示（在前台时不弹通知）
 *
 * @module electron/handlers/registerSessionStatusHandlers
 */

const path = require('path')
const {
  STATES_DIR,
  STORE_KEY_ENABLED,
  detectTools,
  readHookPresence,
  installSessionStatus,
  uninstallSessionStatus,
  listSessions,
} = require('../services/sessionStatusService')
const { createSessionStatusMonitor } = require('../services/sessionStatusMonitor')

// 失败原因里的工具名给页面用
const TOOL_LABEL = { claude: 'Claude Code', codex: 'Codex', all: '会话状态' }

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {{get: Function, set: Function}} deps.store - electron-store
 * @param {() => Electron.BrowserWindow|null} deps.getWindow
 * @param {(n: {title: string, body: string, icon: string, sound: string}) => void} deps.notify
 * @returns {{start: () => Promise<void>, stop: () => void}}
 */
function registerSessionStatusHandlers({ ipcMain, store, getWindow, notify }) {
  const isEnabled = () => store.get(STORE_KEY_ENABLED) !== false
  // 启动 / 重试时装钩子没装上的工具与原因
  let failures = []
  // 页面是否正在前台显示（由页面上报）
  let pageVisible = false

  const send = (channel, payload) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const monitor = createSessionStatusMonitor({
    statesDir: STATES_DIR,
    listSessions,
    isEnabled,
    isPageInFront: () => {
      const win = getWindow()
      return pageVisible && Boolean(win && !win.isDestroyed() && win.isFocused())
    },
    onChange: (result) => send('session-status:changed', result),
    notify,
    iconDir: path.join(__dirname, '..', 'assets', 'notify'),
  })

  const toFailures = (list) => list.map((f) => ({ tool: f.tool, label: TOOL_LABEL[f.tool] || f.tool, error: f.error }))

  async function snapshot() {
    const [tools, hooks, list] = await Promise.all([detectTools(), readHookPresence(), monitor.refresh()])
    return {
      enabled: isEnabled(),
      tools,
      hooks,
      failures,
      sessions: list.sessions,
      total: list.total,
      error: list.error,
    }
  }

  async function ensureInstalled() {
    const result = await installSessionStatus()
    failures = toFailures(result.failures)
    return result
  }

  ipcMain.handle('session-status:get', async () => {
    try {
      return { success: true, data: await snapshot() }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // 打开 / 关掉总开关：先装 / 删钩子，成功才落开关状态
  ipcMain.handle('session-status:set-enabled', async (_event, enabled) => {
    try {
      if (enabled) {
        const result = await ensureInstalled()
        if (!result.success) {
          const reason = failures[0]?.error || '未知原因'
          failures = []
          return { success: false, error: reason }
        }
        store.set(STORE_KEY_ENABLED, true)
      } else {
        const result = await uninstallSessionStatus()
        if (!result.success) return { success: false, error: result.failures[0]?.error || '未知原因' }
        failures = []
        store.set(STORE_KEY_ENABLED, false)
      }
      monitor.reset()
      return { success: true, data: await snapshot() }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // 某一边没装上时的「重试」
  ipcMain.handle('session-status:retry', async () => {
    try {
      if (isEnabled()) await ensureInstalled()
      return { success: true, data: await snapshot() }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('session-status:set-page-visible', (_event, visible) => {
    pageVisible = visible === true
    return { success: true }
  })

  return {
    async start() {
      // 默认开着：启动时静默装好 / 修好钩子，失败原因留给页面
      if (isEnabled()) {
        try {
          await ensureInstalled()
        } catch (error) {
          failures = toFailures([{ tool: 'all', error: error.message }])
        }
      }
      await monitor.start()
    },
    stop: () => monitor.stop(),
  }
}

module.exports = { registerSessionStatusHandlers }
