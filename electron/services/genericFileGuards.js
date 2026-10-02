/**
 * 渲染层 store 键的用途校验
 *
 * 负责：
 * - 渲染层 store（get-store / set-store / delete-store）只开放用量目标的两个键
 *
 * 原先这里还管 Skills 旧导入 / 推送引擎的配置读写、Skill 复制和删除入口；2026-10 旧引擎退役
 * （specs/v2.1.9-Skills只留一套引擎）后那些通用文件入口一并删除，Skill 的写入只走 skill-control。
 *
 * @module electron/services/genericFileGuards
 */

/** 渲染层可读写的 electron-store 键（唯一调用方：用量目标） */
const RENDERER_STORE_KEYS = new Set(['usageGoal', 'usageGoalDismissed'])

/**
 * 渲染层是否可以读写这个 store 键
 * @param {unknown} key
 * @returns {boolean}
 */
function isRendererStoreKey(key) {
  return typeof key === 'string' && RENDERER_STORE_KEYS.has(key)
}

module.exports = {
  isRendererStoreKey,
}
