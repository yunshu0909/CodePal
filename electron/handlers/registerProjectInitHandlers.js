/**
 * 新建项目 IPC 注册模块
 *
 * 负责：
 * - 注册 Git 预检、创建前校验、执行创建三个通道（名字沿用旧版）
 * - 业务全部委托给 projectInitService，这里只做组装与异常兜底
 *
 * 返回形状：{ success, data, error }；校验通道另带 valid，便于界面实时判断。
 * 模板目录固定为 templates/<PROJECT_INIT_TEMPLATE_DIR>（config/projectInitConfig）。
 *
 * @module electron/handlers/registerProjectInitHandlers
 */

const path = require('path')
const { PROJECT_INIT_TEMPLATE_DIR } = require('../config/projectInitConfig')
const {
  checkGitAvailable,
  validateProjectInitParams,
  executeProjectInit,
} = require('../services/projectInitService')

/**
 * 注册新建项目相关 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {(filepath: string) => string} deps.expandHome - 家目录展开函数
 * @returns {void}
 */
function registerProjectInitHandlers({ ipcMain, expandHome }) {
  const templateBaseDir = path.resolve(__dirname, '..', '..', 'templates', PROJECT_INIT_TEMPLATE_DIR)

  /** Git 可用性预检：检测失败一律按不可用处理 */
  ipcMain.handle('project-init-check-git', async () => {
    try {
      return { success: true, data: await checkGitAvailable(), error: null }
    } catch {
      return { success: true, data: { available: false, version: null }, error: null }
    }
  })

  /** 创建前校验：页面停止输入 0.3 秒后调用，也在创建时由执行通道再调一次 */
  ipcMain.handle('project-init-validate', async (event, params = {}) => {
    try {
      const result = await validateProjectInitParams(params, expandHome)
      return { success: true, valid: result.valid, data: { errors: result.errors }, error: null }
    } catch (error) {
      // 校验本身出错（读不了目录）时当作不冲突，创建时还会完整再校验
      return { success: false, valid: true, data: { errors: [] }, error: error.message || 'VALIDATION_EXCEPTION' }
    }
  })

  /** 执行创建 */
  ipcMain.handle('project-init-execute', async (event, params = {}) => {
    try {
      return await executeProjectInit(params, { expandHome, templateBaseDir })
    } catch (error) {
      return {
        success: false,
        error: 'EXECUTION_FAILED',
        data: { failedStep: '创建项目', reason: error.message || '未知错误', rollback: { success: false, path: null } },
      }
    }
  })
}

module.exports = {
  registerProjectInitHandlers,
}
