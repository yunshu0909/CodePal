/**
 * Session Resume IPC 注册
 *
 * 负责：
 * - 注册 session-resume:read-cwd → 读取 session JSONL 的 cwd + 存在性检测
 * - 注册 session-resume:launch-in-terminal → osascript 起 Terminal 执行 claude --resume
 *
 * @module electron/handlers/registerSessionResumeHandlers
 */

const { readSessionCwd, launchInNewTerminal } = require('../services/sessionResumeService')

/**
 * 注册 Session Resume 相关 IPC handlers
 * @param {Object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 */
function registerSessionResumeHandlers({ ipcMain }) {
  /**
   * 读取 session 的原工作目录（扫 JSONL 前 20 行）
   * @returns {Promise<{success: boolean, cwd?: string|null, cwdExists?: boolean, error?: string}>}
   */
  ipcMain.handle('session-resume:read-cwd', async (_event, payload) => {
    const { projectId, sessionId } = payload || {}
    try {
      const result = await readSessionCwd(projectId, sessionId)
      return { success: true, cwd: result.cwd, cwdExists: result.cwdExists }
    } catch (error) {
      return { success: false, error: error?.message || 'READ_CWD_FAILED' }
    }
  })

  /**
   * 在 macOS Terminal 新窗口中启动 Claude Code 并恢复此 session
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  ipcMain.handle('session-resume:launch-in-terminal', async (_event, payload) => {
    const { cwd, uuid } = payload || {}
    try {
      const result = await launchInNewTerminal(cwd, uuid)
      return result
    } catch (error) {
      return { success: false, error: error?.message || 'LAUNCH_FAILED' }
    }
  })
}

module.exports = { registerSessionResumeHandlers }
