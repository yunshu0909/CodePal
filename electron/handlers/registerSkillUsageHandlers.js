/** Validated usage IPC adapters; no renderer-supplied paths or persistence options cross the boundary. */
const { runUsage } = require('../modules/skills/usageRunner')

// Names select known assets; they are never joined to a renderer-supplied filesystem path.
const safeName = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 255 &&
  !/[\p{Cc}/\\]/u.test(name) &&
  name !== '.' &&
  name !== '..'

function safeOptions(params = {}, action) {
  if (
    params.windowDays !== undefined &&
    (!Number.isFinite(params.windowDays) || params.windowDays <= 0 || params.windowDays > 3650)
  )
    throw new Error('SKILL_USAGE_WINDOW_INVALID')
  const options = { windowDays: params.windowDays ?? 30 }
  if (action === 'aggregate') {
    if (
      params.skillNames !== undefined &&
      (!Array.isArray(params.skillNames) || params.skillNames.some((name) => !safeName(name)))
    )
      throw new Error('SKILL_NAME_INVALID')
    options.skillNames = params.skillNames || []
    if (params.assetIds !== undefined) {
      if (
        !Array.isArray(params.assetIds) ||
        params.assetIds.some((id) => !/^asset_[a-f0-9]{24}$/.test(id))
      )
        throw new Error('SKILL_ASSET_ID_INVALID')
      options.assetIds = params.assetIds
    }
  } else {
    if (params.assetId !== undefined && !/^asset_[a-f0-9]{24}$/.test(params.assetId))
      throw new Error('SKILL_ASSET_ID_INVALID')
    if (params.skillName !== undefined && !safeName(params.skillName))
      throw new Error('SKILL_NAME_INVALID')
    if (!params.assetId && !params.skillName) throw new Error('SKILL_NAME_REQUIRED')
    if (params.batchId !== undefined && !/^[0-9a-f-]{36}$/.test(params.batchId))
      throw new Error('SKILL_USAGE_BATCH_INVALID')
    if (params.assetId) options.assetId = params.assetId
    if (params.skillName) options.skillName = params.skillName
    if (params.batchId) options.batchId = params.batchId
  }
  return options
}
/**
 * 注册普通 Skill 的聚合与同批记录通道；两个旧通道委托同一引擎。
 * @param {object} deps - ipcMain、主进程 homeDir，以及可选 env/storeDir/nowFn。
 * @returns {void} 注册 IPC 副作用；响应为 { success, data, error }。
 * 渲染层仅能选择名字、身份、窗口和批次，不能指定读取或写入路径。
 */
function registerSkillUsageHandlers({ ipcMain, homeDir, env, storeDir, nowFn }) {
  const deps = { homeDir, env, storeDir, nowFn }
  const register = (channel, action) =>
    ipcMain.handle(channel, async (_event, params) => {
      try {
        return {
          success: true,
          data: await runUsage(deps, action, safeOptions(params, action)),
          error: null,
        }
      } catch (error) {
        return { success: false, data: null, error: error.message || 'SKILL_USAGE_FAILED' }
      }
    })
  register('skill-usage:aggregate', 'aggregate')
  register('skill-usage:records', 'records')
  register('aggregate-skill-usage', 'aggregate')
  register('list-skill-run-samples', 'records')
}
module.exports = { registerSkillUsageHandlers }
