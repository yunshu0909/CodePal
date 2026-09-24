/**
 * 对话回顾 IPC 处理模块
 *
 * 负责：
 * - 注册最近对话列表、分页读对话、搜索三个 channel
 * - 只校验与转发，统一返回 { success, data, error }
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

/**
 * 注册对话回顾 IPC handlers
 * @param {Object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {object} [deps.service] - 对话服务（测试注入）
 */
function registerSessionBrowserHandlers({ ipcMain, service = defaultService }) {
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
