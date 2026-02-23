/**
 * 渠道注册表服务
 *
 * 负责：
 * - 管理内置渠道定义与自定义渠道定义
 * - 校验 register_provider manifest 的合法性与安全边界
 * - 读写自定义渠道注册表（JSON 文件）
 *
 * @module electron/services/providerRegistryService
 */

const fs = require('fs/promises')
const path = require('path')

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
const ALLOWED_SETTINGS_KEY_PREFIXES = ['ANTHROPIC_']

const PROVIDER_REGISTRY_SCHEMA_VERSION = 1
const PROVIDER_REGISTRY_FILE_NAME = '.provider-manifests.json'

const BUILTIN_PROVIDER_DEFINITIONS = {
  official: {
    name: 'Claude Official',
    model: 'opus',
    models: ['opus'],
    tokenEnvKey: null,
    baseUrlEnvKey: null,
    defaultBaseUrl: null,
    settingsEnv: {},
    source: 'builtin',
    ui: {
      url: 'https://www.anthropic.com/claude-code',
      icon: 'A',
      color: '#6b5ce7',
    },
  },
}

/**
 * 构建用于前端展示的渠道卡片数据
 * @param {Record<string, any>} providerDefinitions - 渠道定义映射
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   url: string,
 *   uiUrl: string,
 *   baseUrl: string,
 *   tokenEnvKey: string|null,
 *   baseUrlEnvKey: string|null,
 *   model: string,
 *   models: string[],
 *   settingsEnv: Record<string, string>,
 *   icon: string,
 *   color: string,
 *   supportsToken: boolean,
 *   source: string
 * }>}
 */
function buildProviderCards(providerDefinitions) {
  const entries = Object.entries(providerDefinitions)
  const sortedEntries = entries.sort(([aKey], [bKey]) => {
    const aBuiltin = BUILTIN_PROVIDER_DEFINITIONS[aKey] ? 0 : 1
    const bBuiltin = BUILTIN_PROVIDER_DEFINITIONS[bKey] ? 0 : 1
    if (aBuiltin !== bBuiltin) return aBuiltin - bBuiltin
    if (aKey === 'official') return -1
    if (bKey === 'official') return 1
    return aKey.localeCompare(bKey)
  })

  return sortedEntries.map(([providerId, definition]) => {
    const uiUrl = definition.ui?.url || definition.defaultBaseUrl || ''
    const baseUrl = definition.defaultBaseUrl || uiUrl

    return {
      id: providerId,
      name: definition.name,
      // 兼容旧前端字段：url 仍保留
      url: uiUrl,
      // 与 register_provider 对齐的字段
      uiUrl,
      baseUrl,
      tokenEnvKey: definition.tokenEnvKey || null,
      baseUrlEnvKey: definition.baseUrlEnvKey || null,
      model: definition.model || 'opus',
      models: normalizeModelsArray(definition.models, definition.model || 'opus'),
      settingsEnv: { ...(definition.settingsEnv || {}) },
      modelTiers: definition.modelTiers || {},
      // UI 渲染字段
      icon: definition.ui?.icon || providerId.charAt(0).toUpperCase(),
      color: definition.ui?.color || '#2563eb',
      supportsToken: Boolean(definition.tokenEnvKey),
      source: definition.source || 'builtin',
    }
  })
}

/**
 * 校验 register_provider manifest
 * @param {unknown} manifest - 待校验 manifest
 * @param {Record<string, any>} existingDefinitions - 已存在渠道定义
 * @param {{allowBuiltinOverride?: boolean}} [options] - 校验选项
 * @returns {{success: boolean, normalized: Object|null, errorCode: string|null, error: string|null}}
 */
function validateProviderManifest(manifest, existingDefinitions = {}, options = {}) {
  if (!isPlainObject(manifest)) {
    return { success: false, normalized: null, errorCode: 'INVALID_MANIFEST', error: 'manifest 必须是对象' }
  }

  const rawId = normalizeStringValue(manifest.id)
  if (!rawId || !PROVIDER_ID_PATTERN.test(rawId)) {
    return {
      success: false,
      normalized: null,
      errorCode: 'INVALID_PROVIDER_ID',
      error: 'id 必须为小写字母开头，且仅支持小写字母/数字/中划线（2-32 位）',
    }
  }

  if (BUILTIN_PROVIDER_DEFINITIONS[rawId] && !options.allowBuiltinOverride) {
    return {
      success: false,
      normalized: null,
      errorCode: 'RESERVED_PROVIDER_ID',
      error: '内置渠道 id 不允许覆盖',
    }
  }

  if (existingDefinitions[rawId]) {
    return {
      success: false,
      normalized: null,
      errorCode: 'CONFLICT_ID',
      error: '渠道 id 已存在',
    }
  }

  const name = normalizeStringValue(manifest.name)
  if (!name || name.length > 80) {
    return {
      success: false,
      normalized: null,
      errorCode: 'INVALID_PROVIDER_NAME',
      error: 'name 必填且长度不超过 80',
    }
  }

  const baseUrl = normalizeStringValue(manifest.baseUrl)
  if (!isValidHttpUrl(baseUrl)) {
    return {
      success: false,
      normalized: null,
      errorCode: 'INVALID_BASE_URL',
      error: 'baseUrl 必须是合法的 http/https 地址',
    }
  }

  const tokenEnvKey = normalizeStringValue(manifest.tokenEnvKey)
  if (!tokenEnvKey || !ENV_KEY_PATTERN.test(tokenEnvKey)) {
    return {
      success: false,
      normalized: null,
      errorCode: 'INVALID_TOKEN_ENV_KEY',
      error: 'tokenEnvKey 必须是合法环境变量名（全大写+下划线）',
    }
  }
  if (tokenEnvKey === 'ANTHROPIC_AUTH_TOKEN') {
    return {
      success: false,
      normalized: null,
      errorCode: 'INVALID_TOKEN_ENV_KEY',
      error: 'tokenEnvKey 不支持 ANTHROPIC_AUTH_TOKEN，请使用独立 API Key 变量名（例如 SILICONFLOW_API_KEY）',
    }
  }

  const baseUrlEnvKey = normalizeStringValue(manifest.baseUrlEnvKey)
  if (baseUrlEnvKey && !ENV_KEY_PATTERN.test(baseUrlEnvKey)) {
    return {
      success: false,
      normalized: null,
      errorCode: 'INVALID_BASE_URL_ENV_KEY',
      error: 'baseUrlEnvKey 必须是合法环境变量名（全大写+下划线）',
    }
  }

  const model = normalizeStringValue(manifest.model) || 'opus'
  if (model.length > 80) {
    return {
      success: false,
      normalized: null,
      errorCode: 'INVALID_MODEL',
      error: 'model 长度不超过 80',
    }
  }

  const modelsValidation = normalizeManifestModels(manifest.models, model)
  if (!modelsValidation.success) {
    return {
      success: false,
      normalized: null,
      errorCode: modelsValidation.errorCode,
      error: modelsValidation.error,
    }
  }

  const settingsEnvValidation = normalizeSettingsEnv(manifest.settingsEnv)
  if (!settingsEnvValidation.success) {
    return settingsEnvValidation
  }

  const color = normalizeStringValue(manifest.color) || '#2563eb'
  if (!HEX_COLOR_PATTERN.test(color)) {
    return {
      success: false,
      normalized: null,
      errorCode: 'INVALID_COLOR',
      error: 'color 必须是 #RRGGBB 格式',
    }
  }

  const icon = normalizeStringValue(manifest.icon) || name.charAt(0).toUpperCase()
  if (icon.length > 2) {
    return {
      success: false,
      normalized: null,
      errorCode: 'INVALID_ICON',
      error: 'icon 长度不超过 2',
    }
  }

  return {
    success: true,
    normalized: {
      id: rawId,
      name,
      baseUrl,
      tokenEnvKey,
      baseUrlEnvKey: baseUrlEnvKey || `${rawId.replace(/-/g, '_').toUpperCase()}_BASE_URL`,
      model,
      models: modelsValidation.models,
      settingsEnv: settingsEnvValidation.normalized,
      modelTiers: isPlainObject(manifest.modelTiers) ? manifest.modelTiers : {},
      color,
      icon,
      uiUrl: normalizeStringValue(manifest.uiUrl) || baseUrl,
    },
    errorCode: null,
    error: null,
  }
}

/**
 * 将 manifest 转换为渠道定义
 * @param {{id: string, name: string, baseUrl: string, tokenEnvKey: string, baseUrlEnvKey: string, model: string, models: string[], settingsEnv: Record<string, string>, color: string, icon: string, uiUrl: string}} normalizedManifest - 归一化 manifest
 * @returns {{id: string, definition: Object}}
 */
function createProviderDefinitionFromManifest(normalizedManifest) {
  return {
    id: normalizedManifest.id,
    definition: {
      name: normalizedManifest.name,
      model: normalizedManifest.model,
      models: normalizedManifest.models,
      tokenEnvKey: normalizedManifest.tokenEnvKey,
      baseUrlEnvKey: normalizedManifest.baseUrlEnvKey,
      defaultBaseUrl: normalizedManifest.baseUrl,
      settingsEnv: normalizedManifest.settingsEnv,
      modelTiers: normalizedManifest.modelTiers || {},
      source: 'custom',
      ui: {
        url: normalizedManifest.uiUrl,
        icon: normalizedManifest.icon,
        color: normalizedManifest.color,
      },
    },
  }
}

/**
 * 读取自定义渠道注册表并返回定义映射
 * @param {Object} params
 * @param {string} params.registryFilePath - 注册表文件路径
 * @param {(filepath: string) => Promise<boolean>} params.pathExists - 路径检查函数
 * @returns {Promise<{success: boolean, definitions: Record<string, any>, errorCode: string|null, error: string|null}>}
 */
async function loadCustomProviderDefinitions({ registryFilePath, pathExists }) {
  const exists = await pathExists(registryFilePath)
  if (!exists) {
    return { success: true, definitions: {}, errorCode: null, error: null }
  }

  let rawContent = ''
  try {
    rawContent = await fs.readFile(registryFilePath, 'utf-8')
  } catch (error) {
    return {
      success: false,
      definitions: {},
      errorCode: 'REGISTRY_READ_FAILED',
      error: `读取渠道注册表失败: ${error.message}`,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(rawContent)
  } catch (error) {
    return {
      success: false,
      definitions: {},
      errorCode: 'REGISTRY_PARSE_FAILED',
      error: `渠道注册表 JSON 无法解析: ${error.message}`,
    }
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.providers)) {
    return {
      success: false,
      definitions: {},
      errorCode: 'REGISTRY_INVALID_FORMAT',
      error: '渠道注册表格式错误：缺少 providers 数组',
    }
  }

  const definitions = {}
  for (const manifest of parsed.providers) {
    const validation = validateProviderManifest(manifest, definitions, { allowBuiltinOverride: true })
    if (!validation.success || !validation.normalized) {
      return {
        success: false,
        definitions: {},
        errorCode: validation.errorCode || 'INVALID_MANIFEST',
        error: `渠道注册表存在非法 manifest: ${validation.error || '未知错误'}`,
      }
    }

    const { id, definition } = createProviderDefinitionFromManifest(validation.normalized)
    definitions[id] = definition
  }

  return { success: true, definitions, errorCode: null, error: null }
}

/**
 * 持久化自定义渠道定义
 * @param {Object} params
 * @param {string} params.registryFilePath - 注册表文件路径
 * @param {Record<string, any>} params.providerDefinitions - 完整渠道定义映射（含内置）
 * @returns {Promise<{success: boolean, errorCode: string|null, error: string|null}>}
 */
async function saveCustomProviderDefinitions({ registryFilePath, providerDefinitions }) {
  const payload = {
    schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
    providers: extractCustomProviderManifests(providerDefinitions),
  }
  const content = `${JSON.stringify(payload, null, 2)}\n`
  return atomicWriteText(registryFilePath, content)
}

/**
 * 提取可持久化的自定义 manifest 列表
 * @param {Record<string, any>} providerDefinitions - 完整渠道定义
 * @returns {Array<Object>}
 */
function extractCustomProviderManifests(providerDefinitions) {
  return Object.entries(providerDefinitions)
    .filter(([, definition]) => definition.source === 'custom')
    .map(([providerId, definition]) => ({
      id: providerId,
      name: definition.name,
      baseUrl: definition.defaultBaseUrl,
      tokenEnvKey: definition.tokenEnvKey,
      baseUrlEnvKey: definition.baseUrlEnvKey,
      model: definition.model,
      models: normalizeModelsArray(definition.models, definition.model),
      settingsEnv: definition.settingsEnv || {},
      modelTiers: definition.modelTiers || {},
      icon: definition.ui?.icon || providerId.charAt(0).toUpperCase(),
      color: definition.ui?.color || '#2563eb',
      uiUrl: definition.ui?.url || definition.defaultBaseUrl,
    }))
}

/**
 * 原子写入文本，避免注册表写坏
 * @param {string} filePath - 目标文件
 * @param {string} content - 写入内容
 * @returns {Promise<{success: boolean, errorCode: string|null, error: string|null}>}
 */
async function atomicWriteText(filePath, content) {
  const dirPath = path.dirname(filePath)
  const tmpPath = `${filePath}.tmp.${process.pid}`

  try {
    await fs.mkdir(dirPath, { recursive: true })
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, filePath)
    return { success: true, errorCode: null, error: null }
  } catch (error) {
    try {
      await fs.unlink(tmpPath)
    } catch {}

    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, errorCode: 'PERMISSION_DENIED', error: '写入渠道注册表失败：权限不足' }
    }
    if (error.code === 'ENOSPC') {
      return { success: false, errorCode: 'DISK_FULL', error: '写入渠道注册表失败：磁盘空间不足' }
    }
    return {
      success: false,
      errorCode: 'REGISTRY_WRITE_FAILED',
      error: `写入渠道注册表失败: ${error.message}`,
    }
  }
}

/**
 * 规范化 settingsEnv，并限制仅允许受管字段
 * @param {unknown} settingsEnv - 原始 settingsEnv
 * @returns {{success: boolean, normalized: Record<string, string>|null, errorCode: string|null, error: string|null}}
 */
function normalizeSettingsEnv(settingsEnv) {
  if (settingsEnv == null) {
    return { success: true, normalized: {}, errorCode: null, error: null }
  }
  if (!isPlainObject(settingsEnv)) {
    return { success: false, normalized: null, errorCode: 'INVALID_SETTINGS_ENV', error: 'settingsEnv 必须是对象' }
  }

  const normalized = {}
  for (const [rawKey, rawValue] of Object.entries(settingsEnv)) {
    const envKey = normalizeStringValue(rawKey)
    const envValue = normalizeStringValue(rawValue)
    if (!envKey || !ENV_KEY_PATTERN.test(envKey)) {
      return {
        success: false,
        normalized: null,
        errorCode: 'INVALID_SETTINGS_ENV_KEY',
        error: `settingsEnv 存在非法 key: ${String(rawKey)}`,
      }
    }
    // 只放行 Claude 运行时字段，避免 agent 借注册功能写入任意敏感 env。
    if (!ALLOWED_SETTINGS_KEY_PREFIXES.some((prefix) => envKey.startsWith(prefix))) {
      return {
        success: false,
        normalized: null,
        errorCode: 'UNSAFE_SETTINGS_ENV_KEY',
        error: `settingsEnv key 不在白名单内: ${envKey}`,
      }
    }
    if (!envValue) {
      return {
        success: false,
        normalized: null,
        errorCode: 'INVALID_SETTINGS_ENV_VALUE',
        error: `settingsEnv 值不能为空: ${envKey}`,
      }
    }
    normalized[envKey] = envValue
  }

  return { success: true, normalized, errorCode: null, error: null }
}

/**
 * 规范化模型列表（去重、去空）
 * @param {unknown} models - 原始模型列表
 * @param {string} fallbackModel - 回退模型
 * @returns {string[]}
 */
function normalizeModelsArray(models, fallbackModel) {
  const fallback = normalizeStringValue(fallbackModel) || 'opus'
  if (!Array.isArray(models)) {
    return [fallback]
  }

  const unique = []
  const seen = new Set()
  for (const item of models) {
    const model = normalizeStringValue(item)
    if (!model || seen.has(model)) continue
    seen.add(model)
    unique.push(model)
  }

  return unique.length > 0 ? unique : [fallback]
}

/**
 * 校验 manifest.models
 * @param {unknown} models - 待校验模型列表
 * @param {string} fallbackModel - 默认模型
 * @returns {{success: boolean, models: string[], errorCode: string|null, error: string|null}}
 */
function normalizeManifestModels(models, fallbackModel) {
  if (models == null) {
    return {
      success: true,
      models: normalizeModelsArray(null, fallbackModel),
      errorCode: null,
      error: null,
    }
  }

  if (!Array.isArray(models)) {
    return {
      success: false,
      models: [],
      errorCode: 'INVALID_MODELS',
      error: 'models 必须是字符串数组',
    }
  }

  const normalized = normalizeModelsArray(models, fallbackModel)
  if (normalized.length > 20) {
    return {
      success: false,
      models: [],
      errorCode: 'INVALID_MODELS',
      error: 'models 最多 20 个',
    }
  }
  if (normalized.some((model) => model.length > 80)) {
    return {
      success: false,
      models: [],
      errorCode: 'INVALID_MODELS',
      error: 'models 中每个模型长度不超过 80',
    }
  }

  return {
    success: true,
    models: normalized,
    errorCode: null,
    error: null,
  }
}

/**
 * 判断值是否是普通对象
 * @param {unknown} value - 待检查值
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 规范化字符串输入
 * @param {unknown} value - 原始输入
 * @returns {string}
 */
function normalizeStringValue(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

/**
 * 校验 URL 是否是 http/https
 * @param {string} value - URL 字符串
 * @returns {boolean}
 */
function isValidHttpUrl(value) {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

module.exports = {
  BUILTIN_PROVIDER_DEFINITIONS,
  PROVIDER_REGISTRY_FILE_NAME,
  buildProviderCards,
  validateProviderManifest,
  createProviderDefinitionFromManifest,
  loadCustomProviderDefinitions,
  saveCustomProviderDefinitions,
}
