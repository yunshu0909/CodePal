/**
 * Skill 控制中心 IPC 注册器
 *
 * IPC 只做参数收敛、服务调用与稳定错误返回；每次写操作完成后重新读取原生状态。
 * 读就是读：读快照不改任何配置。Codex 旧写法的补关挂在 Codex 写操作上，由服务在来源检查通过之后、
 * 真正写入之前调用（被拒绝的操作不补关）；补关失败自己恢复备份，不挡这次写操作。
 * 写操作失败时也尽量带回一份新快照，让页面按实际状态显示。
 * 资产库路径由主进程按配置解析（skillRepoPath），页面经 `skill-control:get-repo-path` 取得。
 *
 * @module electron/handlers/registerSkillControlHandlers
 */

const { getSkillControlSnapshot, executeSkillCommand } = require('../services/skillControlService')
const { migrateLegacyCodexDisables } = require('../services/skillAdapters/codexSkillAdapter')
const { resolveSkillRepoPath } = require('../services/skillRepoPath')

function errorCode(error, fallback) {
  return error?.code || error?.message || fallback
}

function registerSkillControlHandlers({ ipcMain, homeDir }, deps = {}) {
  const getSnapshot = deps.getSkillControlSnapshotFn || getSkillControlSnapshot
  const execute = deps.executeSkillCommandFn || executeSkillCommand
  const migrate = deps.migrateLegacyCodexDisablesFn || migrateLegacyCodexDisables
  const resolveRepoPath = deps.resolveSkillRepoPathFn || resolveSkillRepoPath

  const readSnapshot = (params) => getSnapshot({
    repoPath: params?.repoPath,
    projectRoots: Array.isArray(params?.projectRoots) ? params.projectRoots : [],
    homeDir,
  }, deps)

  ipcMain.handle('skill-control:get-repo-path', async () => {
    try {
      return { success: true, data: await resolveRepoPath({ homeDir }, deps), error: null }
    } catch (error) {
      return { success: false, data: null, error: errorCode(error, 'SKILL_REPO_PATH_FAILED') }
    }
  })

  ipcMain.handle('skill-control:get-snapshot', async (_event, params) => {
    try {
      return { success: true, data: await readSnapshot(params), error: null }
    } catch (error) {
      return { success: false, data: null, error: errorCode(error, 'SKILL_CONTROL_SCAN_FAILED') }
    }
  })

  ipcMain.handle('skill-control:execute', async (_event, params) => {
    // 补关失败不挡这次写操作：它自己恢复了备份，下次动 Codex 时再试
    const beforeCodexWriteFn = () => migrate({ homeDir }, deps).catch(() => null)
    try {
      const data = await execute({ ...params, homeDir }, { ...deps, beforeCodexWriteFn })
      const snapshot = await readSnapshot(params)
      return { success: true, data, snapshot, error: null }
    } catch (error) {
      // 失败后重读一次：状态不确定时页面要按实际显示；重读也失败就不带快照
      const snapshot = await readSnapshot(params).catch(() => null)
      return { success: false, data: null, snapshot, error: errorCode(error, 'SKILL_CONTROL_COMMAND_FAILED') }
    }
  })
}

module.exports = { registerSkillControlHandlers }
