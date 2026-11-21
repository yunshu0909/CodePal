/** Validated usage IPC adapters; no renderer-supplied paths or persistence options cross the boundary. */
const { runUsage } = require('../modules/skills/usageRunner')
const { saveLastUsage } = require('../modules/skills/lastViewStore')
// 身份键只用来和下次开应用时的快照比对，不拿来拼路径；资产库再大也到不了这个长度
const MAX_CACHE_KEY = 4 * 1024 * 1024

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
 * #101：聚合可带页面算的身份键；合法才收，不进统计引擎。
 * @returns {string|null}
 */
function safeCacheKey(params = {}) {
  if (params.cacheKey === undefined) return null
  if (typeof params.cacheKey !== 'string' || !params.cacheKey || params.cacheKey.length > MAX_CACHE_KEY)
    throw new Error('SKILL_USAGE_CACHE_KEY_INVALID')
  return params.cacheKey
}
/**
 * 注册普通 Skill 的聚合与同批记录通道；两个旧通道委托同一引擎。
 * @param {object} deps - ipcMain、主进程 homeDir，以及可选 env/storeDir/nowFn；runUsageFn / saveLastUsageFn 只给测试替换。
 * @returns {void} 注册 IPC 副作用；响应为 { success, data, error }。
 * 渲染层仅能选择名字、身份、窗口和批次，不能指定读取或写入路径。
 * 聚合带身份键时，读完在后台把次数摘要存进 CodePal 自己的缓存（#101），下次开应用先显示；不等写完再返回。
 */
function registerSkillUsageHandlers({ ipcMain, homeDir, env, storeDir, nowFn, runUsageFn, saveLastUsageFn }) {
  const deps = { homeDir, env, storeDir, nowFn }
  const run = runUsageFn || runUsage
  const remember = saveLastUsageFn || saveLastUsage
  const register = (channel, action) =>
    ipcMain.handle(channel, async (_event, params) => {
      try {
        const options = safeOptions(params, action)
        const cacheKey = action === 'aggregate' ? safeCacheKey(params) : null
        const data = await run(deps, action, options)
        if (cacheKey && data)
          remember(homeDir, { cacheKey, windowDays: options.windowDays, data }).catch(() => {})
        return { success: true, data, error: null }
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
