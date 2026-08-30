/**
 * Skill 控制中心 IPC 注册器
 *
 * IPC 只做参数收敛、服务调用与稳定错误返回；每次写操作完成后重新读取原生状态。
 *
 * @module electron/handlers/registerSkillControlHandlers
 */

const { getSkillControlSnapshot, executeSkillCommand } = require('../services/skillControlService')

function errorCode(error, fallback) {
  return error?.code || error?.message || fallback
}

function registerSkillControlHandlers({ ipcMain, homeDir }, deps = {}) {
  const getSnapshot = deps.getSkillControlSnapshotFn || getSkillControlSnapshot
  const execute = deps.executeSkillCommandFn || executeSkillCommand

  ipcMain.handle('skill-control:get-snapshot', async (_event, params) => {
    try {
      const data = await getSnapshot({
        repoPath: params?.repoPath,
        projectRoots: Array.isArray(params?.projectRoots) ? params.projectRoots : [],
        homeDir,
      }, deps)
      return { success: true, data, error: null }
    } catch (error) {
      return { success: false, data: null, error: errorCode(error, 'SKILL_CONTROL_SCAN_FAILED') }
    }
  })

  ipcMain.handle('skill-control:execute', async (_event, params) => {
    try {
      const data = await execute({ ...params, homeDir }, deps)
      const snapshot = await getSnapshot({
        repoPath: params?.repoPath,
        projectRoots: Array.isArray(params?.projectRoots) ? params.projectRoots : [],
        homeDir,
      }, deps)
      return { success: true, data, snapshot, error: null }
    } catch (error) {
      return { success: false, data: null, snapshot: null, error: errorCode(error, 'SKILL_CONTROL_COMMAND_FAILED') }
    }
  })

  // 兼容 v1.9 开发分支的两个旧入口，统一转给新命令模型。
  ipcMain.handle('skill-control:deploy', async (_event, params) => {
    const action = params?.enabled ? 'enable' : 'remove-tool'
    try {
      const data = await execute({ ...params, action, homeDir }, deps)
      return { success: true, data, error: null }
    } catch (error) {
      return { success: false, data: null, error: errorCode(error, 'SKILL_CONTROL_DEPLOY_FAILED') }
    }
  })
  ipcMain.handle('skill-control:adopt', async (_event, params) => {
    try {
      const data = await execute({ ...params, action: 'adopt', source: params?.source || { origin: 'user', mutable: true }, homeDir }, deps)
      return { success: true, data, error: null }
    } catch (error) {
      return { success: false, data: null, error: errorCode(error, 'SKILL_CONTROL_ADOPT_FAILED') }
    }
  })
}

module.exports = { registerSkillControlHandlers }
