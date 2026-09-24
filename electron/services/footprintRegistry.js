/**
 * 足迹清单：CodePal 装进别的工具里的东西
 *
 * 负责：
 * - 装的时候登记（装了什么、装在哪），卸的时候注销，便于以后排查「谁装的、装了什么、怎么卸」
 * - 只记 CodePal 主动安装的集成（钩子、脚本等），不记普通设置修改
 *
 * 最小版本：只落 electron-store，暂不提供界面（界面需要新文案，待定）。架构优化路线 5。
 *
 * @module electron/services/footprintRegistry
 */

const STORE_KEY = 'footprint.v1'
let store = null

/**
 * 主进程启动时注入 electron-store；未注入时登记为空操作（不影响功能）
 * @param {{get: Function, set: Function}} nextStore
 */
function configureFootprint(nextStore) {
  store = nextStore
}

/** @returns {Array<{id: string, tool: string, kind: string, location: string, recordedAt: string}>} */
function listFootprint() {
  if (!store) return []
  const items = store.get(STORE_KEY)
  return Array.isArray(items) ? items : []
}

/**
 * 登记一项（同 id 覆盖）
 * @param {{id: string, tool: string, kind: string, location: string}} item
 */
function recordFootprint(item) {
  if (!store) return
  const items = listFootprint().filter((existing) => existing.id !== item.id)
  items.push({ ...item, recordedAt: new Date().toISOString() })
  store.set(STORE_KEY, items)
}

/** @param {string} id */
function removeFootprint(id) {
  if (!store) return
  store.set(STORE_KEY, listFootprint().filter((existing) => existing.id !== id))
}

module.exports = { configureFootprint, listFootprint, recordFootprint, removeFootprint }
