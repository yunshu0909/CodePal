/**
 * Session 浏览 IPC 处理模块
 *
 * 负责：
 * - 注册项目列表查询 IPC channel
 * - 注册 session 列表查询 IPC channel
 * - 注册 session 对话内容读取 IPC channel
 *
 * @module electron/handlers/registerSessionBrowserHandlers
 */

const { listProjects, listSessions, readSession, searchSessions } = require('../services/sessionBrowserService')

/**
 * 注册 Session 浏览 IPC handlers
 * @param {Object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 */
function registerSessionBrowserHandlers({ ipcMain }) {
  /**
   * 获取所有项目列表
   */
  ipcMain.handle('session:listProjects', async () => {
    try {
      const projects = await listProjects()
      return { success: true, data: projects, error: null }
    } catch (error) {
      return { success: false, data: null, error: error.message }
    }
  })

  /**
   * 获取指定项目的 session 列表
   */
  ipcMain.handle('session:listSessions', async (_event, projectId) => {
    try {
      const sessions = await listSessions(projectId)
      return { success: true, data: sessions, error: null }
    } catch (error) {
      return { success: false, data: null, error: error.message }
    }
  })

  /**
   * 读取 session 对话内容
   */
  ipcMain.handle('session:readSession', async (_event, projectId, sessionId) => {
    try {
      const messages = await readSession(projectId, sessionId)
      return { success: true, data: messages, error: null }
    } catch (error) {
      return { success: false, data: null, error: error.message }
    }
  })

  /**
   * 全文搜索对话内容
   */
  ipcMain.handle('session:search', async (_event, keyword) => {
    try {
      const results = await searchSessions(keyword)
      return { success: true, data: results, error: null }
    } catch (error) {
      return { success: false, data: null, error: error.message }
    }
  })
}

module.exports = { registerSessionBrowserHandlers }
