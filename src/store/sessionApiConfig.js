/**
 * Session API 配置服务
 *
 * 负责：
 * - 维护 session -> provider 的绑定关系
 * - 基于已有全局切换能力按 session 应用 provider
 * - 为后续 UI 接入提供稳定的数据接口
 *
 * @module store/sessionApiConfig
 */

/**
 * session 绑定映射在 electron-store 中的存储键
 * @type {string}
 */
export const SESSION_PROVIDER_BINDINGS_STORE_KEY = 'api.sessionProviderBindings.v1'

/**
 * 允许绑定的 provider 列表
 * @type {string[]}
 */
export const ALLOWED_PROVIDER_IDS = ['official', 'qwen', 'kimi', 'aicodemirror']

/**
 * 归一化 sessionId
 * @param {unknown} sessionId - 原始 sessionId
 * @returns {string|null}
 */
export function normalizeSessionId(sessionId) {
  if (typeof sessionId !== 'string') return null
  const normalized = sessionId.trim()
  if (!normalized) return null
  if (normalized.length > 120) return null
  return normalized
}

/**
 * 校验 providerId 是否可用
 * @param {unknown} providerId - 供应商 ID
 * @returns {boolean}
 */
function isAllowedProviderId(providerId) {
  return typeof providerId === 'string' && ALLOWED_PROVIDER_IDS.includes(providerId)
}

/**
 * 获取 electronAPI 并做最小能力校验
 * @returns {Record<string, Function>|null}
 */
function getElectronAPI() {
  if (typeof window === 'undefined') return null
  return window.electronAPI || null
}

/**
 * 读取 session 绑定映射
 * @returns {Promise<{success: boolean, map: Record<string, {providerId: string, updatedAt: string}>, error: string|null, errorCode: string|null}>}
 */
async function readSessionBindingMap() {
  const electronAPI = getElectronAPI()
  if (!electronAPI?.getStore) {
    return { success: false, map: {}, error: 'Electron API 不可用', errorCode: 'API_NOT_AVAILABLE' }
  }

  try {
    const raw = await electronAPI.getStore(SESSION_PROVIDER_BINDINGS_STORE_KEY)
    if (raw == null) {
      return { success: true, map: {}, error: null, errorCode: null }
    }

    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { success: false, map: {}, error: 'session 配置存储格式损坏', errorCode: 'INVALID_STORE_DATA' }
    }

    return { success: true, map: raw, error: null, errorCode: null }
  } catch (error) {
    return {
      success: false,
      map: {},
      error: `读取 session 配置失败: ${error.message}`,
      errorCode: 'STORE_READ_FAILED',
    }
  }
}

/**
 * 写入 session 绑定映射
 * @param {Record<string, {providerId: string, updatedAt: string}>} map - 待保存映射
 * @returns {Promise<{success: boolean, error: string|null, errorCode: string|null}>}
 */
async function writeSessionBindingMap(map) {
  const electronAPI = getElectronAPI()
  if (!electronAPI?.setStore) {
    return { success: false, error: 'Electron API 不可用', errorCode: 'API_NOT_AVAILABLE' }
  }

  try {
    await electronAPI.setStore(SESSION_PROVIDER_BINDINGS_STORE_KEY, map)
    return { success: true, error: null, errorCode: null }
  } catch (error) {
    return {
      success: false,
      error: `写入 session 配置失败: ${error.message}`,
      errorCode: 'STORE_WRITE_FAILED',
    }
  }
}

/**
 * 获取单个 session 的 provider 绑定
 * @param {string} sessionId - session ID
 * @returns {Promise<{success: boolean, sessionId: string, binding: {providerId: string, updatedAt: string}|null, error: string|null, errorCode: string|null}>}
 */
export async function getSessionProviderBinding(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!normalizedSessionId) {
    return {
      success: false,
      sessionId: '',
      binding: null,
      error: 'sessionId 无效',
      errorCode: 'INVALID_SESSION_ID',
    }
  }

  const readResult = await readSessionBindingMap()
  if (!readResult.success) {
    return {
      success: false,
      sessionId: normalizedSessionId,
      binding: null,
      error: readResult.error,
      errorCode: readResult.errorCode,
    }
  }

  const binding = readResult.map[normalizedSessionId] || null
  return {
    success: true,
    sessionId: normalizedSessionId,
    binding,
    error: null,
    errorCode: null,
  }
}

/**
 * 保存 session 的 provider 绑定
 * @param {string} sessionId - session ID
 * @param {string} providerId - provider ID
 * @returns {Promise<{success: boolean, sessionId: string, binding: {providerId: string, updatedAt: string}|null, error: string|null, errorCode: string|null}>}
 */
export async function saveSessionProviderBinding(sessionId, providerId) {
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!normalizedSessionId) {
    return {
      success: false,
      sessionId: '',
      binding: null,
      error: 'sessionId 无效',
      errorCode: 'INVALID_SESSION_ID',
    }
  }

  if (!isAllowedProviderId(providerId)) {
    return {
      success: false,
      sessionId: normalizedSessionId,
      binding: null,
      error: 'providerId 无效',
      errorCode: 'INVALID_PROVIDER_ID',
    }
  }

  const readResult = await readSessionBindingMap()
  if (!readResult.success) {
    return {
      success: false,
      sessionId: normalizedSessionId,
      binding: null,
      error: readResult.error,
      errorCode: readResult.errorCode,
    }
  }

  const binding = {
    providerId,
    updatedAt: new Date().toISOString(),
  }

  const nextMap = {
    ...readResult.map,
    [normalizedSessionId]: binding,
  }

  const writeResult = await writeSessionBindingMap(nextMap)
  if (!writeResult.success) {
    return {
      success: false,
      sessionId: normalizedSessionId,
      binding: null,
      error: writeResult.error,
      errorCode: writeResult.errorCode,
    }
  }

  return {
    success: true,
    sessionId: normalizedSessionId,
    binding,
    error: null,
    errorCode: null,
  }
}

/**
 * 删除 session 的 provider 绑定
 * @param {string} sessionId - session ID
 * @returns {Promise<{success: boolean, sessionId: string, removed: boolean, error: string|null, errorCode: string|null}>}
 */
export async function removeSessionProviderBinding(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!normalizedSessionId) {
    return {
      success: false,
      sessionId: '',
      removed: false,
      error: 'sessionId 无效',
      errorCode: 'INVALID_SESSION_ID',
    }
  }

  const readResult = await readSessionBindingMap()
  if (!readResult.success) {
    return {
      success: false,
      sessionId: normalizedSessionId,
      removed: false,
      error: readResult.error,
      errorCode: readResult.errorCode,
    }
  }

  if (!readResult.map[normalizedSessionId]) {
    return {
      success: true,
      sessionId: normalizedSessionId,
      removed: false,
      error: null,
      errorCode: null,
    }
  }

  const nextMap = { ...readResult.map }
  delete nextMap[normalizedSessionId]

  const writeResult = await writeSessionBindingMap(nextMap)
  if (!writeResult.success) {
    return {
      success: false,
      sessionId: normalizedSessionId,
      removed: false,
      error: writeResult.error,
      errorCode: writeResult.errorCode,
    }
  }

  return {
    success: true,
    sessionId: normalizedSessionId,
    removed: true,
    error: null,
    errorCode: null,
  }
}

/**
 * 列出所有 session 绑定（按更新时间倒序）
 * @returns {Promise<{success: boolean, items: Array<{sessionId: string, providerId: string, updatedAt: string}>, error: string|null, errorCode: string|null}>}
 */
export async function listSessionProviderBindings() {
  const readResult = await readSessionBindingMap()
  if (!readResult.success) {
    return {
      success: false,
      items: [],
      error: readResult.error,
      errorCode: readResult.errorCode,
    }
  }

  const items = Object.entries(readResult.map)
    .filter(([sessionId, binding]) => {
      return normalizeSessionId(sessionId) && isAllowedProviderId(binding?.providerId)
    })
    .map(([sessionId, binding]) => ({
      sessionId,
      providerId: binding.providerId,
      updatedAt: binding.updatedAt || '',
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return {
    success: true,
    items,
    error: null,
    errorCode: null,
  }
}

/**
 * 应用某个 session 的 provider 绑定（调用现有全局切换 API）
 * @param {string} sessionId - session ID
 * @returns {Promise<{success: boolean, sessionId: string, providerId: string|null, error: string|null, errorCode: string|null}>}
 */
export async function applySessionProviderBinding(sessionId) {
  const electronAPI = getElectronAPI()
  if (!electronAPI?.switchClaudeProvider) {
    return {
      success: false,
      sessionId: '',
      providerId: null,
      error: 'Electron API 不可用',
      errorCode: 'API_NOT_AVAILABLE',
    }
  }

  const bindingResult = await getSessionProviderBinding(sessionId)
  if (!bindingResult.success) {
    return {
      success: false,
      sessionId: bindingResult.sessionId,
      providerId: null,
      error: bindingResult.error,
      errorCode: bindingResult.errorCode,
    }
  }

  const providerId = bindingResult.binding?.providerId || null
  if (!providerId) {
    return {
      success: false,
      sessionId: bindingResult.sessionId,
      providerId: null,
      error: '当前 session 尚未绑定 provider',
      errorCode: 'NO_SESSION_BINDING',
    }
  }

  // 复用既有切换主链路，避免 session MVP 引入第二套写入实现。
  const switchResult = await electronAPI.switchClaudeProvider(providerId)
  if (!switchResult?.success) {
    return {
      success: false,
      sessionId: bindingResult.sessionId,
      providerId,
      error: switchResult?.error || '按 session 应用 provider 失败',
      errorCode: switchResult?.errorCode || 'SWITCH_FAILED',
    }
  }

  return {
    success: true,
    sessionId: bindingResult.sessionId,
    providerId,
    error: null,
    errorCode: null,
  }
}
