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
const PREWARM_DELAY_MS = 100

/**
 * 启动预读：第一个加载完的窗口出来后，后台读一次对话列表，把主进程内存索引填好。
 * 只在内存里，不写磁盘；同一次运行只读一次（窗口重载、关于窗口、关窗再开都不再读）。
 * 窗口没加载完就关了，不算用掉这次机会，下一个窗口加载完再读。
 * 页面在读完前进来，没变的文件接上在途读取、不重读；页面已经先要过列表，就不再预读。出错只记日志，进页时照常再读。
 * @param {import('electron').App} app - 用它的 browser-window-created 找窗口
 * @param {object} service - 对话服务
 * @returns {{ markListed: Function }} 页面要过列表时调用
 */
function prewarmAfterFirstWindowLoads(app, service) {
  let scheduled = false
  let listed = false
  const onWindow = (_event, window) => {
    window.webContents.once('did-finish-load', () => {
      if (scheduled) return
      scheduled = true
      app.removeListener('browser-window-created', onWindow)
      setTimeout(() => {
        if (listed) return
        Promise.resolve()
          .then(() => service.listRecent())
          .catch((error) => console.warn('[session-browser] prewarm failed:', error?.message || error))
      }, PREWARM_DELAY_MS)
    })
  }
  app.on('browser-window-created', onWindow)
  return { markListed: () => { listed = true } }
}

/**
 * 注册对话回顾 IPC handlers
 * @param {Object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {object} [deps.service] - 对话服务（测试注入）
 * @param {import('electron').App} [deps.app] - 传了就在第一个窗口加载完后预读对话列表
 */
function registerSessionBrowserHandlers({ ipcMain, service = defaultService, app = null }) {
  const prewarm = app ? prewarmAfterFirstWindowLoads(app, service) : null

  // 每个窗口只保留一个进行中的搜索：新搜索来了就取消上一个，主进程不再白扫
  const searches = new Map()

  ipcMain.handle('session:listRecent', () => {
    prewarm?.markListed()
    return wrap(() => service.listRecent())
  })

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
