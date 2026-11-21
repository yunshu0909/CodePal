/**
 * 对话回顾 IPC 处理模块
 *
 * 负责：
 * - 注册最近对话列表、分页读对话、搜索三个 channel
 * - 只校验与转发，统一返回 { success, data, error }
 * - 启动预读（#102）：主窗口加载完后在后台读一次对话列表，重开应用后第一次进页不用等
 *
 * @module electron/handlers/registerSessionBrowserHandlers
 */

// 通过模块对象调用（不解构），测试可以替换其中的函数；也可在注册时注入
const defaultService = require('../services/sessionBrowserService')

/**
 * 包一层统一返回结构
 * @param {Function} fn - 返回 Promise 的服务调用
 * @returns {Promise<{success: boolean, data: any, error: string|null}>}
 */
async function wrap(fn) {
  try {
    return { success: true, data: await fn(), error: null }
  } catch (error) {
    return { success: false, data: null, error: error.message }
  }
}

// 页面加载完再等一会儿，让默认页先拿到数据
const PREWARM_DELAY_MS = 300

/**
 * 启动预读：第一个窗口的页面加载完后，后台读一次对话列表，把主进程内存索引填好。
 * 只在内存里，不写磁盘；同一次运行只读一次（窗口重载、关于窗口、关窗再开都不再读）。
 * 页面在读完前进来会接上同一批在途读取，不会重读。出错只记日志，进页时照常再读。
 * @param {import('electron').App} app - 用它的 browser-window-created 找第一个窗口
 * @param {object} service - 对话服务
 */
function prewarmAfterFirstWindowLoads(app, service) {
  app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        Promise.resolve()
          .then(() => service.listRecent())
          .catch((error) => console.warn('[session-browser] prewarm failed:', error?.message || error))
      }, PREWARM_DELAY_MS)
    })
  })
}

/**
 * 注册对话回顾 IPC handlers
 * @param {Object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {object} [deps.service] - 对话服务（测试注入）
 * @param {import('electron').App} [deps.app] - 传了就在第一个窗口加载完后预读对话列表
 */
function registerSessionBrowserHandlers({ ipcMain, service = defaultService, app = null }) {
  if (app) prewarmAfterFirstWindowLoads(app, service)

  // 每个窗口只保留一个进行中的搜索：新搜索来了就取消上一个，主进程不再白扫
  const searches = new Map()

  ipcMain.handle('session:listRecent', () => wrap(() => service.listRecent()))

  ipcMain.handle('session:readSession', (_event, projectId, sessionId, options = {}) =>
    wrap(() => service.readSessionPage(projectId, sessionId, {
      ...(options.limit != null ? { limit: options.limit } : {}),
      ...(options.before != null ? { before: options.before } : {}),
    })))

  ipcMain.handle('session:search', (event, keyword, options = {}) => {
    const senderId = event?.sender?.id ?? 'default'
    searches.get(senderId)?.abort()
    const controller = new AbortController()
    searches.set(senderId, controller)
    return wrap(() => service.searchSessions(keyword, {
      projectPath: options.projectPath ?? null,
      includeAuto: Boolean(options.includeAuto),
      signal: controller.signal,
    })).finally(() => {
      if (searches.get(senderId) === controller) searches.delete(senderId)
    })
  })
}

module.exports = { registerSessionBrowserHandlers }
