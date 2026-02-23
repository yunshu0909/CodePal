/**
 * Claude 供应商 IPC 注册模块
 *
 * 负责：
 * - 注册供应商读取/切换/API Key 保存相关 IPC
 * - 隔离 provider 业务逻辑，降低 main.js 体积
 *
 * @module electron/handlers/registerProviderHandlers
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const dotenv = require('dotenv')
const {
  BUILTIN_PROVIDER_DEFINITIONS,
  PROVIDER_REGISTRY_FILE_NAME,
  buildProviderCards,
  validateProviderManifest,
  createProviderDefinitionFromManifest,
  loadCustomProviderDefinitions,
  saveCustomProviderDefinitions,
} = require('../services/providerRegistryService')

/**
 * 注册供应商相关 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 * @param {string} [deps.envFilePath] - .env 文件路径
 * @param {string} [deps.providerRegistryFilePath] - 渠道注册表文件路径
 */
function registerProviderHandlers({ ipcMain, pathExists, envFilePath, providerRegistryFilePath }) {
  const ENV_FILE_PATH = envFilePath || path.resolve(__dirname, '..', '..', '.env')
  const PROVIDER_REGISTRY_FILE_PATH = providerRegistryFilePath || path.resolve(__dirname, '..', '..', PROVIDER_REGISTRY_FILE_NAME)
  dotenv.config({ path: ENV_FILE_PATH })

// ==================== V0.7 供应商切换 ====================

const PROVIDER_DEFINITIONS = { ...BUILTIN_PROVIDER_DEFINITIONS }
let providerDefinitionsLoadError = null
const ACTIVE_PROVIDER_ENV_KEY = 'CLAUDE_CODE_PROVIDER'
const CLAUDE_SETTINGS_FILE_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_SETTINGS_BACKUP_DIR = path.join(os.homedir(), '.claude', 'backups')
const CLAUDE_API_KEY_HELPER_FILE_NAME = 'skill-manager-api-key-helper.sh'
const CLAUDE_API_KEY_HELPER_PATH = path.join(path.dirname(CLAUDE_SETTINGS_FILE_PATH), CLAUDE_API_KEY_HELPER_FILE_NAME)
const CLAUDE_API_KEY_HELPER_CONTENT = `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="$SCRIPT_DIR/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
  exit 1
fi
node -e '
const fs=require("fs")
const settingsPath=process.argv[1]
const settings=JSON.parse(fs.readFileSync(settingsPath,"utf8"))
const env=settings&&typeof settings==="object"&&settings.env&&typeof settings.env==="object"
  ? settings.env
  : {}
const token=(env.ANTHROPIC_API_KEY||env.ANTHROPIC_AUTH_TOKEN||"").trim()
if (token) {
  process.stdout.write(token + "\\n")
}
' "$SETTINGS_FILE"
`
const CLAUDE_RUNTIME_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]
const MANAGED_CLAUDE_ENV_KEYS = [
  ...CLAUDE_RUNTIME_ENV_KEYS,
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
]

/**
 * 清理当前进程中的认证变量，避免 API Key 与 Auth Token 同时存在导致冲突。
 * @returns {void}
 */
function clearRuntimeAuthConflictEnv() {
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_API_KEY
}

/**
 * 判断是否为合法 http/https URL
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

/**
 * 去除 URL 末尾斜杠
 * @param {string} url - 原始 URL
 * @returns {string}
 */
function trimTrailingSlash(url) {
  return url.replace(/\/+$/, '')
}

/**
 * 安全读取响应文本（限制长度）
 * @param {Response} response - fetch 响应
 * @returns {Promise<string>}
 */
async function safeReadResponseText(response) {
  try {
    const text = await response.text()
    return text.slice(0, 8000)
  } catch {
    return ''
  }
}

/**
 * 测试供应商 API 连通性
 * 说明：
 * - 按 Claude Code 的调用方式优先测试 `${baseUrl}/v1/messages`
 * - 当 baseUrl 末尾带 `/v1` 时，额外尝试 `${baseUrl}/messages` 仅用于诊断误配
 *
 * @param {{baseUrl: string, token: string, model?: string}} params - 测试参数
 * @returns {Promise<{success: boolean, errorCode: string|null, error: string|null}>}
 */
async function testProviderConnection(params) {
  const baseUrl = normalizeEnvValue(params?.baseUrl)
  const token = normalizeEnvValue(params?.token)
  const model = normalizeEnvValue(params?.model) || 'opus'

  if (!baseUrl || !isValidHttpUrl(baseUrl)) {
    return { success: false, errorCode: 'INVALID_BASE_URL', error: 'Base URL 非法，仅支持 http/https' }
  }
  if (!token) {
    return { success: false, errorCode: 'INVALID_TOKEN', error: 'API Key 不能为空' }
  }
  if (typeof fetch !== 'function') {
    return { success: false, errorCode: 'UNSUPPORTED_RUNTIME', error: '当前运行环境不支持网络测试' }
  }

  const normalizedBaseUrl = trimTrailingSlash(baseUrl)
  const runtimeUrl = `${normalizedBaseUrl}/v1/messages`
  const looksLikeVersionedBase = /\/v\d+$/i.test(normalizedBaseUrl)
  const diagnosticUrl = looksLikeVersionedBase ? `${normalizedBaseUrl}/messages` : null

  const callMessagesApi = async (url) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    try {
      const headers = {
        'x-api-key': token,
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      })
      clearTimeout(timer)

      if (response.ok) {
        return { ok: true, status: response.status, text: '' }
      }

      const errorText = await safeReadResponseText(response)
      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, text: `鉴权失败（${response.status}）` }
      }
      if (response.status === 400) {
        // 400 常见于模型参数校验失败，但代表链路与端点存在。
        return { ok: true, status: response.status, text: '', note: '服务可达（请求参数被服务端校验拒绝）' }
      }
      if (response.status === 500 && /invalid\s+claude\s+code\s+request/i.test(errorText)) {
        // 部分第三方网关会对“非 Claude Code 原生请求形状”返回 500，
        // 但这已证明鉴权与路由可达，不应判定为连接失败。
        return { ok: true, status: response.status, text: '', note: '服务可达（网关要求 Claude Code 原生请求格式）' }
      }
      return {
        ok: false,
        status: response.status,
        text: `请求失败（${response.status}）${errorText ? `: ${errorText}` : ''}`
      }
    } catch (error) {
      clearTimeout(timer)
      if (error?.name === 'AbortError') {
        return { ok: false, status: 0, text: '请求超时（12s）' }
      }
      return { ok: false, status: 0, text: `请求异常: ${error.message || '未知错误'}` }
    }
  }

  const runtimeResult = await callMessagesApi(runtimeUrl)
  if (runtimeResult.ok) {
    return { success: true, errorCode: null, error: null, note: runtimeResult.note || null }
  }

  // 诊断：用户常把 Base URL 填成 .../v1，Claude 实际会拼接 /v1/messages，导致 404。
  if (diagnosticUrl && runtimeResult.status === 404) {
    const diagnosticResult = await callMessagesApi(diagnosticUrl)
    if (diagnosticResult.ok) {
      return {
        success: false,
        errorCode: 'BASE_URL_FORMAT',
        error: 'Base URL 可能多写了 /v1。请改为不含 /v1 的根地址后重试（例如 https://api.siliconflow.cn）。'
      }
    }
  }

  return {
    success: false,
    errorCode: runtimeResult.status === 404 ? 'ENDPOINT_NOT_FOUND' : 'CONNECT_FAILED',
    error: runtimeResult.text || '连接失败'
  }
}

/**
 * 延迟加载自定义渠道定义
 * @returns {Promise<void>}
 */
async function ensureProviderDefinitionsLoaded() {
  // 每次读取前都从磁盘刷新，确保外部 MCP 写入可即时生效。
  resetProviderDefinitionsToBuiltin()
  providerDefinitionsLoadError = null

  const loadResult = await loadCustomProviderDefinitions({
    registryFilePath: PROVIDER_REGISTRY_FILE_PATH,
    pathExists,
  })
  if (!loadResult.success) {
    providerDefinitionsLoadError = loadResult.error || '读取渠道注册表失败'
    return
  }

  for (const [providerKey, definition] of Object.entries(loadResult.definitions)) {
    PROVIDER_DEFINITIONS[providerKey] = definition
  }
}

/**
 * 重置内存中的渠道定义为内置渠道
 * @returns {void}
 */
function resetProviderDefinitionsToBuiltin() {
  for (const providerKey of Object.keys(PROVIDER_DEFINITIONS)) {
    delete PROVIDER_DEFINITIONS[providerKey]
  }
  for (const [providerKey, definition] of Object.entries(BUILTIN_PROVIDER_DEFINITIONS)) {
    PROVIDER_DEFINITIONS[providerKey] = definition
  }
}

/**
 * 保存自定义渠道定义到注册表
 * @returns {Promise<{success: boolean, errorCode: string|null, error: string|null}>}
 */
async function persistCustomProviderDefinitions() {
  return saveCustomProviderDefinitions({
    registryFilePath: PROVIDER_REGISTRY_FILE_PATH,
    providerDefinitions: PROVIDER_DEFINITIONS,
  })
}

/**
 * 规范化环境变量值
 * @param {unknown} value - 原始值
 * @returns {string|null}
 */
function normalizeEnvValue(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/**
 * 判断是否为普通对象
 * @param {unknown} value - 待检查的值
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 生成备份文件名时间戳
 * @returns {string}
 */
function createBackupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * 备份 Claude settings 原始内容
 * @param {string} rawContent - 原始文件内容
 * @param {string} suffix - 备份后缀
 * @returns {Promise<{success: boolean, backupPath: string|null, errorCode: string|null, error: string|null}>}
 */
async function backupClaudeSettingsRaw(rawContent, suffix = 'snapshot') {
  try {
    await fs.mkdir(CLAUDE_SETTINGS_BACKUP_DIR, { recursive: true })
    const backupPath = path.join(
      CLAUDE_SETTINGS_BACKUP_DIR,
      `settings-${suffix}-${createBackupTimestamp()}.json`
    )
    await fs.writeFile(backupPath, rawContent, 'utf-8')
    return { success: true, backupPath, errorCode: null, error: null }
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return {
        success: false,
        backupPath: null,
        errorCode: 'PERMISSION_DENIED',
        error: '无法写入 Claude settings 备份，请检查权限',
      }
    }
    if (error.code === 'ENOSPC') {
      return {
        success: false,
        backupPath: null,
        errorCode: 'DISK_FULL',
        error: '磁盘空间不足，无法写入 Claude settings 备份',
      }
    }
    return {
      success: false,
      backupPath: null,
      errorCode: 'WRITE_FAILED',
      error: `写入 Claude settings 备份失败: ${error.message}`,
    }
  }
}

/**
 * 确保 Claude apiKeyHelper 脚本存在
 * @returns {Promise<{success: boolean, helperPath: string|null, errorCode: string|null, error: string|null}>}
 */
async function ensureClaudeApiKeyHelperScript() {
  try {
    await fs.mkdir(path.dirname(CLAUDE_API_KEY_HELPER_PATH), { recursive: true })
    await fs.writeFile(CLAUDE_API_KEY_HELPER_PATH, CLAUDE_API_KEY_HELPER_CONTENT, {
      encoding: 'utf-8',
      mode: 0o700,
    })
    await fs.chmod(CLAUDE_API_KEY_HELPER_PATH, 0o700)
    return {
      success: true,
      helperPath: CLAUDE_API_KEY_HELPER_PATH,
      errorCode: null,
      error: null,
    }
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return {
        success: false,
        helperPath: null,
        errorCode: 'PERMISSION_DENIED',
        error: '无法写入 Claude apiKeyHelper 脚本，请检查权限',
      }
    }
    if (error.code === 'ENOSPC') {
      return {
        success: false,
        helperPath: null,
        errorCode: 'DISK_FULL',
        error: '磁盘空间不足，无法写入 Claude apiKeyHelper 脚本',
      }
    }
    return {
      success: false,
      helperPath: null,
      errorCode: 'WRITE_FAILED',
      error: `写入 Claude apiKeyHelper 脚本失败: ${error.message}`,
    }
  }
}

/**
 * 读取 Claude settings.json 文件
 * @returns {Promise<{success: boolean, exists: boolean, content: string, data: Record<string, any>, errorCode: string|null, error: string|null, backupPath: string|null}>}
 */
async function readClaudeSettingsFile() {
  try {
    const exists = await pathExists(CLAUDE_SETTINGS_FILE_PATH)
    if (!exists) {
      return {
        success: true,
        exists: false,
        content: '',
        data: {},
        errorCode: null,
        error: null,
        backupPath: null,
      }
    }

    const content = await fs.readFile(CLAUDE_SETTINGS_FILE_PATH, 'utf-8')
    let data

    try {
      data = JSON.parse(content)
    } catch (error) {
      const backupResult = await backupClaudeSettingsRaw(content, 'corrupted')
      const backupMessage = backupResult.success
        ? `已备份到 ${backupResult.backupPath}`
        : `备份失败（${backupResult.error || '未知错误'}）`
      return {
        success: false,
        exists: true,
        content,
        data: {},
        errorCode: 'CONFIG_CORRUPTED',
        error: `Claude settings.json 已损坏，${backupMessage}`,
        backupPath: backupResult.backupPath || null,
      }
    }

    if (!isPlainObject(data)) {
      const backupResult = await backupClaudeSettingsRaw(content, 'corrupted')
      const backupMessage = backupResult.success
        ? `已备份到 ${backupResult.backupPath}`
        : `备份失败（${backupResult.error || '未知错误'}）`
      return {
        success: false,
        exists: true,
        content,
        data: {},
        errorCode: 'CONFIG_CORRUPTED',
        error: `Claude settings.json 结构异常，${backupMessage}`,
        backupPath: backupResult.backupPath || null,
      }
    }

    return {
      success: true,
      exists: true,
      content,
      data,
      errorCode: null,
      error: null,
      backupPath: null,
    }
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return {
        success: false,
        exists: false,
        content: '',
        data: {},
        errorCode: 'PERMISSION_DENIED',
        error: '无法读取 Claude settings.json，请检查权限',
        backupPath: null,
      }
    }
    return {
      success: false,
      exists: false,
      content: '',
      data: {},
      errorCode: 'READ_FAILED',
      error: `读取 Claude settings.json 失败: ${error.message}`,
      backupPath: null,
    }
  }
}

/**
 * 基于环境变量生成供应商配置档
 * @param {Record<string, string|undefined>} envSource - 环境变量来源
 * @returns {Record<string, {name: string, token: string|null, baseUrl: string|null, model: string, models: string[], settingsEnv: Record<string, string>}>}
 */
function getProviderProfiles(envSource = {}) {
  const profiles = {}

  for (const [providerKey, definition] of Object.entries(PROVIDER_DEFINITIONS)) {
    const token = definition.tokenEnvKey
      ? normalizeEnvValue(envSource[definition.tokenEnvKey])
      : null

    const configuredBaseUrl = definition.baseUrlEnvKey
      ? normalizeEnvValue(envSource[definition.baseUrlEnvKey])
      : null

    profiles[providerKey] = {
      name: definition.name,
      token,
      baseUrl: configuredBaseUrl || definition.defaultBaseUrl || null,
      model: definition.model,
      models: Array.isArray(definition.models) && definition.models.length > 0
        ? definition.models
        : [definition.model || 'opus'],
      settingsEnv: definition.settingsEnv || {},
      modelTiers: definition.modelTiers || {},
    }
  }

  return profiles
}

/**
 * 构造前端可用的 token 映射
 * @param {Record<string, {token: string|null}>} providerProfiles - 供应商配置档
 * @returns {Record<string, {token: string}>}
 */
function buildProviderTokenMap(providerProfiles) {
  const providers = {}

  for (const [providerKey, definition] of Object.entries(PROVIDER_DEFINITIONS)) {
    if (!definition.tokenEnvKey) continue
    providers[providerKey] = { token: providerProfiles[providerKey]?.token || '' }
  }

  return providers
}

/**
 * 获取供应商对应的 API Key 环境变量名
 * @param {string} providerKey - 供应商 key
 * @returns {string|null}
 */
function getProviderTokenEnvKey(providerKey) {
  const definition = PROVIDER_DEFINITIONS[providerKey]
  return definition?.tokenEnvKey || null
}

/**
 * 读取项目 .env 文件
 * @returns {Promise<{exists: boolean, content: string, envMap: Record<string, string>, errorCode: string|null, error: string|null}>}
 */
async function readProjectEnvFile() {
  try {
    const exists = await pathExists(ENV_FILE_PATH)
    if (!exists) {
      return { exists: false, content: '', envMap: {}, errorCode: null, error: null }
    }

    const content = await fs.readFile(ENV_FILE_PATH, 'utf-8')
    return {
      exists: true,
      content,
      envMap: dotenv.parse(content),
      errorCode: null,
      error: null,
    }
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return {
        exists: false,
        content: '',
        envMap: {},
        errorCode: 'PERMISSION_DENIED',
        error: '无法读取 .env 文件，请检查权限',
      }
    }
    return {
      exists: false,
      content: '',
      envMap: {},
      errorCode: 'READ_FAILED',
      error: `读取 .env 失败: ${error.message}`,
    }
  }
}

/**
 * 读取当前生效的供应商环境变量
 * 以 .env 文件为单一真相，避免进程内旧值污染判断结果。
 * @returns {Promise<{envSource: Record<string, string|undefined>, envPath: string, errorCode: string|null, error: string|null}>}
 */
async function loadMergedProviderEnv() {
  const envReadResult = await readProjectEnvFile()
  const envSource = { ...envReadResult.envMap }
  const managedKeys = [ACTIVE_PROVIDER_ENV_KEY]

  for (const definition of Object.values(PROVIDER_DEFINITIONS)) {
    if (definition.tokenEnvKey) managedKeys.push(definition.tokenEnvKey)
    if (definition.baseUrlEnvKey) managedKeys.push(definition.baseUrlEnvKey)
  }

  // 进程环境变量仅用于补齐 .env 缺失值，避免启动时旧 process.env 覆盖用户刚写入的 .env。
  // 这样能保证“保存 API Key -> 读取 API Key”的一致性。
  for (const key of managedKeys) {
    const runtimeValue = normalizeEnvValue(process.env[key])
    const fileValue = normalizeEnvValue(envSource[key])
    if (runtimeValue && !fileValue) {
      envSource[key] = runtimeValue
    }
  }

  return {
    envSource,
    envPath: ENV_FILE_PATH,
    envExists: envReadResult.exists,
    errorCode: envReadResult.errorCode,
    error: envReadResult.error,
  }
}

/**
 * 转义 .env 值，避免特殊字符破坏解析
 * @param {string} value - 原始值
 * @returns {string}
 */
function quoteEnvValue(value) {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
  return `"${escaped}"`
}

/**
 * 更新或追加指定的 .env 变量
 * @param {string} envContent - 原始 .env 内容
 * @param {string} key - 变量名
 * @param {string} value - 变量值
 * @returns {string} 新的 .env 内容
 */
function upsertEnvVariable(envContent, key, value) {
  const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
  const lines = envContent ? envContent.split(/\r?\n/) : []
  const nextLine = `${key}=${quoteEnvValue(value)}`

  let replaced = false
  const updatedLines = lines.map((line) => {
    if (!replaced && keyPattern.test(line)) {
      replaced = true
      return nextLine
    }
    return line
  })

  // 追加前保留一行空行，便于区分“手写配置”与“应用写入配置”。
  if (!replaced) {
    const hasAnyLine = updatedLines.some((line) => line.length > 0)
    if (hasAnyLine && updatedLines[updatedLines.length - 1] !== '') {
      updatedLines.push('')
    }
    updatedLines.push(nextLine)
  }

  const normalized = updatedLines.join('\n').replace(/\n*$/, '\n')
  return normalized
}

/**
 * 删除 .env 中的指定变量
 * @param {string} envContent - 原始 .env 内容
 * @param {string} key - 变量名
 * @returns {string} 新的 .env 内容
 */
function removeEnvVariable(envContent, key) {
  const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
  const lines = envContent ? envContent.split(/\r?\n/) : []
  const filtered = lines.filter((line) => !keyPattern.test(line))
  const normalized = filtered.join('\n').replace(/\n*$/, '\n')
  return normalized
}

/**
 * 批量更新 .env 变量
 * @param {string} envContent - 原始 .env 内容
 * @param {Record<string, string|null>} updates - 变量更新集合（null 表示删除）
 * @returns {string} 新的 .env 内容
 */
function applyEnvVariableUpdates(envContent, updates) {
  let nextContent = envContent

  for (const [key, value] of Object.entries(updates)) {
    nextContent = value == null
      ? removeEnvVariable(nextContent, key)
      : upsertEnvVariable(nextContent, key, value)
  }

  return nextContent
}

/**
 * 保存供应商 API Key 到项目 .env 文件
 * @param {string} providerKey - 供应商 key
 * @param {string} token - API Key
 * @returns {Promise<{success: boolean, envPath: string, errorCode: string|null, error: string|null}>}
 */
async function saveProviderTokenToEnv(providerKey, token) {
  const tokenEnvKey = getProviderTokenEnvKey(providerKey)
  if (!tokenEnvKey) {
    return { success: false, envPath: ENV_FILE_PATH, errorCode: 'INVALID_PROVIDER', error: '该供应商不支持保存 API Key' }
  }

  const normalizedToken = token.trim()
  if (!normalizedToken) {
    return { success: false, envPath: ENV_FILE_PATH, errorCode: 'INVALID_TOKEN', error: 'API Key 不能为空' }
  }

  const envReadResult = await readProjectEnvFile()
  if (envReadResult.errorCode) {
    return {
      success: false,
      envPath: ENV_FILE_PATH,
      errorCode: envReadResult.errorCode,
      error: envReadResult.error,
    }
  }

  // 清理镜像字段时排除当前供应商实际使用的 token key，避免“先写后删”导致保存看似成功但值丢失。
  const runtimeCleanupKeys = CLAUDE_RUNTIME_ENV_KEYS.filter((key) => key !== tokenEnvKey)
  const envUpdates = {
    [tokenEnvKey]: normalizedToken,
    // 单一来源：保存供应商专属 key 时顺手清理旧的运行时镜像字段。
    ...Object.fromEntries(runtimeCleanupKeys.map((key) => [key, null])),
  }

  const updatedContent = applyEnvVariableUpdates(envReadResult.content, envUpdates)
  const writeResult = await atomicWriteText(ENV_FILE_PATH, updatedContent)
  if (!writeResult.success) {
    return {
      success: false,
      envPath: ENV_FILE_PATH,
      errorCode: writeResult.error,
      error: `写入 .env 失败: ${writeResult.error}`,
    }
  }

  clearRuntimeAuthConflictEnv()
  return { success: true, envPath: ENV_FILE_PATH, errorCode: null, error: null }
}

/**
 * 从环境变量识别当前供应商
 * @param {Record<string, string|undefined>} envSource - 环境变量来源
 * @returns {string} providerId | custom
 */
function detectProviderFromEnv(envSource) {
  const explicitProvider = normalizeEnvValue(envSource[ACTIVE_PROVIDER_ENV_KEY])
  if (explicitProvider && PROVIDER_DEFINITIONS[explicitProvider]) {
    return explicitProvider
  }
  if (!explicitProvider) return 'official'
  return 'custom'
}

/**
 * 从 Claude settings 识别当前供应商
 * @param {Record<string, any>} settingsData - settings.json 数据
 * @param {Record<string, {token: string|null, baseUrl: string|null}>} providerProfiles - 供应商配置档
 * @returns {string} providerId | custom
 */
function detectProviderFromSettings(settingsData, providerProfiles) {
  if (!isPlainObject(settingsData)) return 'official'

  const managedApiKeyHelper = normalizeEnvValue(settingsData.apiKeyHelper)
  const configuredModel = normalizeEnvValue(settingsData.model)
  const officialModel = providerProfiles?.official?.model || 'opus'
  const envObject = isPlainObject(settingsData.env) ? settingsData.env : null
  if (!envObject) return managedApiKeyHelper ? 'custom' : 'official'

  // 兼容双通道：历史版本写入 AUTH_TOKEN，新版本优先支持 API_KEY。
  const token = normalizeEnvValue(envObject.ANTHROPIC_API_KEY) ||
    normalizeEnvValue(envObject.ANTHROPIC_AUTH_TOKEN)
  const baseUrl = normalizeEnvValue(envObject.ANTHROPIC_BASE_URL)

  if (!token && !baseUrl) {
    // settings 上仅残留 apiKeyHelper 时，CLI 仍会走 API helper 链路。
    // 该状态不能判定为 official，否则 UI 会把“需要清理的异常态”误显示为官方态。
    if (managedApiKeyHelper) return 'custom'
    // 无 token/baseUrl 但 model 已偏离官方默认，通常代表用户在外部改成了非官方接入。
    if (configuredModel && configuredModel !== officialModel) return 'custom'
    return 'official'
  }

  for (const [providerKey, profile] of Object.entries(providerProfiles)) {
    if (providerKey === 'official') continue
    if (token === profile.token && baseUrl === profile.baseUrl) {
      return providerKey
    }
  }

  return 'custom'
}

/**
 * 将供应商档应用到 Claude settings 数据
 * @param {Record<string, any>} settingsData - 原始 settings 数据
 * @param {{token: string|null, baseUrl: string|null, model: string, models?: string[], settingsEnv?: Record<string, string>}} profile - 目标供应商档
 * @param {string|null} selectedModel - 用户选择模型（可选）
 * @param {string} managedApiKeyHelperPath - Skill Manager 托管 helper 路径
 * @returns {Record<string, any>}
 */
function applyProviderProfileToSettings(settingsData, profile, selectedModel, managedApiKeyHelperPath) {
  const source = isPlainObject(settingsData) ? settingsData : {}
  const updated = JSON.parse(JSON.stringify(source))
  const envObject = isPlainObject(updated.env) ? updated.env : {}
  const normalizedSelectedModel = normalizeEnvValue(selectedModel)
  const allowedModels = Array.isArray(profile.models) && profile.models.length > 0
    ? profile.models
    : [profile.model]
  const effectiveModel = normalizedSelectedModel && allowedModels.includes(normalizedSelectedModel)
    ? normalizedSelectedModel
    : profile.model

  for (const key of MANAGED_CLAUDE_ENV_KEYS) {
    delete envObject[key]
  }

  if (profile.token) {
    // 仅写 API_KEY：避免将第三方 sk-* 误当作 OAuth token 走账号登录链路。
    // 兼容读取层仍保留 AUTH_TOKEN 兜底，用于识别历史配置。
    envObject.ANTHROPIC_API_KEY = profile.token
  }
  if (profile.baseUrl) {
    envObject.ANTHROPIC_BASE_URL = profile.baseUrl
  }
  if (isPlainObject(profile.settingsEnv)) {
    for (const [key, value] of Object.entries(profile.settingsEnv)) {
      const normalizedValue = normalizeEnvValue(value)
      if (normalizedValue) {
        envObject[key] = normalizedValue
      }
    }
  }
  if (effectiveModel) {
    envObject.ANTHROPIC_MODEL = effectiveModel
    // 根据选中模型的 modelTiers 动态写入分级
    const tiers = isPlainObject(profile.modelTiers) ? profile.modelTiers[effectiveModel] : null
    if (isPlainObject(tiers)) {
      envObject.ANTHROPIC_DEFAULT_OPUS_MODEL = effectiveModel
      if (tiers.sonnet) envObject.ANTHROPIC_DEFAULT_SONNET_MODEL = tiers.sonnet
      if (tiers.haiku) envObject.ANTHROPIC_DEFAULT_HAIKU_MODEL = tiers.haiku
    }
  }

  updated.env = envObject
  if (profile.token) {
    // Claude CLI 登录判断优先读取 apiKeyHelper，写入后可避免无谓账号登录弹窗。
    updated.apiKeyHelper = managedApiKeyHelperPath
  } else {
    // Official 严格登录模式：无条件清理 apiKeyHelper，避免继续走 API 鉴权。
    delete updated.apiKeyHelper
  }
  updated.model = effectiveModel || profile.model
  return updated
}

/**
 * 将供应商切换结果写入 .env（单一状态来源）
 * @param {string} profileKey - 供应商档位
 * @param {Record<string, {token: string|null, baseUrl: string|null}>} providerProfiles - 当前供应商配置档
 * @returns {Promise<{success: boolean, envPath: string, error: string|null, errorCode: string|null}>}
 */
async function switchProviderInEnv(profileKey, providerProfiles) {
  const envReadResult = await readProjectEnvFile()
  if (envReadResult.errorCode) {
    return {
      success: false,
      envPath: ENV_FILE_PATH,
      errorCode: envReadResult.errorCode,
      error: envReadResult.error,
      previousContent: '',
      previousExists: false,
    }
  }

  const profile = providerProfiles[profileKey]
  if (!profile) {
    return {
      success: false,
      envPath: ENV_FILE_PATH,
      errorCode: 'INVALID_PROFILE_KEY',
      error: '无效的供应商档位',
      previousContent: envReadResult.content,
      previousExists: envReadResult.exists,
    }
  }

  // 清理镜像字段时跳过“已被渠道定义占用”的运行时 key，避免切换时误删用户真实 token/baseUrl。
  const providerBoundRuntimeKeys = new Set()
  for (const definition of Object.values(PROVIDER_DEFINITIONS)) {
    if (definition.tokenEnvKey && CLAUDE_RUNTIME_ENV_KEYS.includes(definition.tokenEnvKey)) {
      providerBoundRuntimeKeys.add(definition.tokenEnvKey)
    }
    if (definition.baseUrlEnvKey && CLAUDE_RUNTIME_ENV_KEYS.includes(definition.baseUrlEnvKey)) {
      providerBoundRuntimeKeys.add(definition.baseUrlEnvKey)
    }
  }
  const runtimeCleanupKeys = CLAUDE_RUNTIME_ENV_KEYS.filter((key) => !providerBoundRuntimeKeys.has(key))

  const envUpdates = {
    [ACTIVE_PROVIDER_ENV_KEY]: profileKey,
    // 单一来源：切换时删除历史镜像字段，避免双轨状态并存。
    ...Object.fromEntries(runtimeCleanupKeys.map((key) => [key, null])),
  }

  const updatedContent = applyEnvVariableUpdates(envReadResult.content, envUpdates)
  const writeResult = await atomicWriteText(ENV_FILE_PATH, updatedContent)
  if (!writeResult.success) {
    return {
      success: false,
      envPath: ENV_FILE_PATH,
      errorCode: writeResult.error,
      error: `写入 .env 失败: ${writeResult.error}`,
      previousContent: envReadResult.content,
      previousExists: envReadResult.exists,
    }
  }

  return {
    success: true,
    envPath: ENV_FILE_PATH,
    errorCode: null,
    error: null,
    previousContent: envReadResult.content,
    previousExists: envReadResult.exists,
  }
}

/**
 * 将供应商切换结果写入 Claude settings.json
 * @param {string} profileKey - 供应商档位
 * @param {Record<string, {token: string|null, baseUrl: string|null, model: string, models?: string[]}>} providerProfiles - 当前供应商配置档
 * @param {string|null} selectedModel - 用户选择模型（可选）
 * @returns {Promise<{success: boolean, settingsPath: string, backupPath: string|null, error: string|null, errorCode: string|null}>}
 */
async function switchProviderInClaudeSettings(profileKey, providerProfiles, selectedModel = null) {
  const profile = providerProfiles[profileKey]
  if (!profile) {
    return {
      success: false,
      settingsPath: CLAUDE_SETTINGS_FILE_PATH,
      backupPath: null,
      error: '无效的供应商档位',
      errorCode: 'INVALID_PROFILE_KEY',
    }
  }

  const settingsReadResult = await readClaudeSettingsFile()
  if (!settingsReadResult.success) {
    return {
      success: false,
      settingsPath: CLAUDE_SETTINGS_FILE_PATH,
      backupPath: settingsReadResult.backupPath || null,
      error: settingsReadResult.error || '读取 Claude settings.json 失败',
      errorCode: settingsReadResult.errorCode || 'READ_FAILED',
    }
  }

  let backupPath = null
  if (settingsReadResult.exists) {
    const backupResult = await backupClaudeSettingsRaw(settingsReadResult.content, 'switch')
    if (!backupResult.success) {
      return {
        success: false,
        settingsPath: CLAUDE_SETTINGS_FILE_PATH,
        backupPath: null,
        error: backupResult.error || '备份 Claude settings.json 失败',
        errorCode: backupResult.errorCode || 'WRITE_FAILED',
      }
    }
    backupPath = backupResult.backupPath
  }

  if (profile.token) {
    const helperResult = await ensureClaudeApiKeyHelperScript()
    if (!helperResult.success) {
      return {
        success: false,
        settingsPath: CLAUDE_SETTINGS_FILE_PATH,
        backupPath,
        error: helperResult.error || '写入 Claude apiKeyHelper 脚本失败',
        errorCode: helperResult.errorCode || 'WRITE_FAILED',
      }
    }
  }

  const updatedSettings = applyProviderProfileToSettings(
    settingsReadResult.data,
    profile,
    selectedModel,
    CLAUDE_API_KEY_HELPER_PATH
  )
  const updatedSettingsText = `${JSON.stringify(updatedSettings, null, 2)}\n`
  const writeResult = await atomicWriteText(CLAUDE_SETTINGS_FILE_PATH, updatedSettingsText)
  if (!writeResult.success) {
    return {
      success: false,
      settingsPath: CLAUDE_SETTINGS_FILE_PATH,
      backupPath,
      error: `写入 Claude settings.json 失败: ${writeResult.error}`,
      errorCode: writeResult.error || 'WRITE_FAILED',
    }
  }

  return {
    success: true,
    settingsPath: CLAUDE_SETTINGS_FILE_PATH,
    backupPath,
    error: null,
    errorCode: null,
  }
}

/**
 * 尝试恢复 .env 到切换前快照
 * @param {string} previousContent - 切换前 .env 内容
 * @param {boolean} previousExists - 切换前 .env 是否存在
 * @returns {Promise<{success: boolean, errorCode: string|null, error: string|null}>}
 */
async function restoreEnvSnapshot(previousContent, previousExists) {
  try {
    if (!previousExists) {
      try {
        await fs.unlink(ENV_FILE_PATH)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      return { success: true, errorCode: null, error: null }
    }

    const writeResult = await atomicWriteText(ENV_FILE_PATH, previousContent)
    if (!writeResult.success) {
      return {
        success: false,
        errorCode: writeResult.error || 'WRITE_FAILED',
        error: `回滚 .env 失败: ${writeResult.error}`,
      }
    }
    return { success: true, errorCode: null, error: null }
  } catch (error) {
    return {
      success: false,
      errorCode: error.code || 'ROLLBACK_FAILED',
      error: `回滚 .env 失败: ${error.message}`,
    }
  }
}

/**
 * 原子写入文本文件
 * 先写临时文件再替换，避免写入中断导致配置文件损坏
 * @param {string} filePath - 目标文件路径
 * @param {string} content - 要写入的内容
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function atomicWriteText(filePath, content) {
  const dir = path.dirname(filePath)
  const tmpPath = `${filePath}.tmp.${process.pid}`

  try {
    // 确保目录存在
    await fs.mkdir(dir, { recursive: true })
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED' }
    }
    if (error.code === 'ENOSPC') {
      return { success: false, error: 'DISK_FULL' }
    }
    return { success: false, error: `CREATE_DIR_FAILED: ${error.message}` }
  }

  try {
    await fs.writeFile(tmpPath, content, 'utf-8')
  } catch (error) {
    // 清理临时文件
    try { await fs.unlink(tmpPath) } catch {}
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED' }
    }
    if (error.code === 'ENOSPC') {
      return { success: false, error: 'DISK_FULL' }
    }
    return { success: false, error: `WRITE_FAILED: ${error.message}` }
  }

  try {
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    // 清理临时文件
    try { await fs.unlink(tmpPath) } catch {}
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED' }
    }
    return { success: false, error: `RENAME_FAILED: ${error.message}` }
  }

  return { success: true, error: null }
}

/**
 * IPC: 获取当前 Claude 供应商配置
 * @returns {Promise<{success: boolean, current: string, profile: Object|null, isNew: boolean, corruptedBackup: string|null, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('get-claude-provider', async () => {
  try {
    await ensureProviderDefinitionsLoaded()
    const { envSource, envExists, errorCode, error } = await loadMergedProviderEnv()
    const providerProfiles = getProviderProfiles(envSource)

    if (errorCode) {
      return {
        success: false,
        current: 'official',
        profile: providerProfiles.official,
        isNew: false,
        corruptedBackup: null,
        error: error || '读取环境变量失败',
        errorCode,
      }
    }

    const settingsReadResult = await readClaudeSettingsFile()
    if (!settingsReadResult.success) {
      // 配置损坏可降级：先用 .env 推断当前档位，并提示用户修复 settings 文件。
      if (settingsReadResult.errorCode === 'CONFIG_CORRUPTED') {
        const fallbackCurrent = detectProviderFromEnv(envSource)
        return {
          success: true,
          current: fallbackCurrent,
          profile: providerProfiles[fallbackCurrent] || null,
          isNew: !envExists,
          corruptedBackup: settingsReadResult.backupPath || null,
          error: settingsReadResult.error,
          errorCode: settingsReadResult.errorCode,
        }
      }

      return {
        success: false,
        current: 'official',
        profile: providerProfiles.official,
        isNew: false,
        corruptedBackup: settingsReadResult.backupPath || null,
        error: settingsReadResult.error || '读取 Claude settings.json 失败',
        errorCode: settingsReadResult.errorCode || 'READ_FAILED',
      }
    }

    // 以 Claude 实际运行配置为准，避免页面显示与真实生效状态不一致。
    const current = detectProviderFromSettings(settingsReadResult.data, providerProfiles)
    const profile = providerProfiles[current] || null

    return {
      success: true,
      current,
      profile,
      isNew: !envExists && !settingsReadResult.exists,
      corruptedBackup: null,
      error: null,
      errorCode: null
    }
  } catch (error) {
    console.error('Error getting Claude provider:', error)
    const fallbackProfiles = getProviderProfiles({})
    return {
      success: false,
      current: 'official',
      profile: fallbackProfiles.official,
      isNew: false,
      corruptedBackup: null,
      error: `获取配置失败: ${error.message}`,
      errorCode: 'UNKNOWN_ERROR'
    }
  }
})

/**
 * IPC: 获取当前可用供应商定义（含内置与注册表自定义）
 * MCP Tool 对应：list_providers
 * 设计约束：返回内容仅用于“展示 + 选择”，不暴露 token。
 *
 * 示例返回（成功）：
 * {
 *   success: true,
 *   providers: [
 *     { id: 'official', name: 'Claude Official', source: 'builtin' },
 *     { id: 'neo-proxy', name: 'NeoProxy Gateway', source: 'custom' }
 *   ],
 *   registryPath: '/path/to/.provider-manifests.json',
 *   error: null,
 *   errorCode: null
 * }
 *
 * @returns {Promise<{success: boolean, providers: Array, registryPath: string, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('list-provider-definitions', async () => {
  try {
    await ensureProviderDefinitionsLoaded()
    return {
      success: true,
      providers: buildProviderCards(PROVIDER_DEFINITIONS),
      registryPath: PROVIDER_REGISTRY_FILE_PATH,
      error: providerDefinitionsLoadError,
      errorCode: providerDefinitionsLoadError ? 'REGISTRY_LOAD_FAILED' : null,
    }
  } catch (error) {
    console.error('Error listing provider definitions:', error)
    return {
      success: false,
      providers: buildProviderCards(BUILTIN_PROVIDER_DEFINITIONS),
      registryPath: PROVIDER_REGISTRY_FILE_PATH,
      error: `读取渠道定义失败: ${error.message}`,
      errorCode: 'UNKNOWN_ERROR',
    }
  }
})

/**
 * IPC: 注册自定义供应商 manifest（MCP 形状，本地入口）
 * MCP Tool 对应：register_provider
 * 设计约束：只接受“渠道定义”，不在此接口处理 token 保存与供应商切换。
 *
 * 示例请求：
 * {
 *   id: 'neo-proxy',
 *   name: 'NeoProxy Gateway',
 *   baseUrl: 'https://api.neoproxy.dev/anthropic',
 *   tokenEnvKey: 'NEO_PROXY_API_KEY',
 *   model: 'opus',
 *   settingsEnv: { ANTHROPIC_MODEL: 'neoproxy-opus' }
 * }
 *
 * 示例错误：
 * {
 *   success: false,
 *   errorCode: 'UNSAFE_SETTINGS_ENV_KEY',
 *   error: 'settingsEnv key 不在白名单内: OPENAI_API_KEY'
 * }
 *
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} manifest - 供应商 manifest
 * @returns {Promise<{success: boolean, provider: Object|null, registryPath: string, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('register-provider-manifest', async (event, manifest) => {
  try {
    await ensureProviderDefinitionsLoaded()

    const validation = validateProviderManifest(manifest, PROVIDER_DEFINITIONS)
    if (!validation.success || !validation.normalized) {
      return {
        success: false,
        provider: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: validation.error || '渠道 manifest 非法',
        errorCode: validation.errorCode || 'INVALID_MANIFEST',
      }
    }

    const { id, definition } = createProviderDefinitionFromManifest(validation.normalized)
    PROVIDER_DEFINITIONS[id] = definition

    const saveResult = await persistCustomProviderDefinitions()
    if (!saveResult.success) {
      // 持久化失败时回滚内存态，避免 UI 看到不可持久化的幻象渠道。
      delete PROVIDER_DEFINITIONS[id]
      return {
        success: false,
        provider: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: saveResult.error || '写入渠道注册表失败',
        errorCode: saveResult.errorCode || 'REGISTRY_WRITE_FAILED',
      }
    }

    return {
      success: true,
      provider: buildProviderCards({ [id]: definition })[0] || null,
      registryPath: PROVIDER_REGISTRY_FILE_PATH,
      error: null,
      errorCode: null,
    }
  } catch (error) {
    console.error('Error registering provider manifest:', error)
    return {
      success: false,
      provider: null,
      registryPath: PROVIDER_REGISTRY_FILE_PATH,
      error: `注册渠道失败: ${error.message}`,
      errorCode: 'UNKNOWN_ERROR',
    }
  }
})

/**
 * IPC: 更新自定义供应商 manifest
 * 说明：
 * - 支持更新自定义渠道与内置渠道（内置渠道将以同 id 自定义覆盖的方式持久化）
 * - 渠道 id 固定为 providerId，不支持重命名
 *
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} providerId - 待更新的渠道 ID
 * @param {Object} manifest - 渠道 manifest（name/baseUrl/tokenEnvKey/model/models/settingsEnv 等）
 * @returns {Promise<{success: boolean, provider: Object|null, registryPath: string, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('update-provider-manifest', async (event, providerId, manifest) => {
  try {
    await ensureProviderDefinitionsLoaded()

    if (typeof providerId !== 'string' || !providerId.trim()) {
      return {
        success: false,
        provider: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: '渠道 id 非法',
        errorCode: 'INVALID_PROVIDER_ID',
      }
    }

    const normalizedId = providerId.trim()
    const existingDefinition = PROVIDER_DEFINITIONS[normalizedId]
    if (!existingDefinition) {
      return {
        success: false,
        provider: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: '渠道不存在',
        errorCode: 'PROVIDER_NOT_FOUND',
      }
    }
    const nextManifest = {
      ...(isPlainObject(manifest) ? manifest : {}),
      id: normalizedId,
    }
    const validationContext = { ...PROVIDER_DEFINITIONS }
    delete validationContext[normalizedId]
    const validation = validateProviderManifest(nextManifest, validationContext, { allowBuiltinOverride: true })
    if (!validation.success || !validation.normalized) {
      return {
        success: false,
        provider: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: validation.error || '渠道 manifest 非法',
        errorCode: validation.errorCode || 'INVALID_MANIFEST',
      }
    }

    const previousDefinition = existingDefinition
    const { id, definition } = createProviderDefinitionFromManifest(validation.normalized)
    PROVIDER_DEFINITIONS[id] = definition

    const saveResult = await persistCustomProviderDefinitions()
    if (!saveResult.success) {
      PROVIDER_DEFINITIONS[id] = previousDefinition
      return {
        success: false,
        provider: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: saveResult.error || '写入渠道注册表失败',
        errorCode: saveResult.errorCode || 'REGISTRY_WRITE_FAILED',
      }
    }

    return {
      success: true,
      provider: buildProviderCards({ [id]: definition })[0] || null,
      registryPath: PROVIDER_REGISTRY_FILE_PATH,
      error: null,
      errorCode: null,
    }
  } catch (error) {
    console.error('Error updating provider manifest:', error)
    return {
      success: false,
      provider: null,
      registryPath: PROVIDER_REGISTRY_FILE_PATH,
      error: `修改渠道失败: ${error.message}`,
      errorCode: 'UNKNOWN_ERROR',
    }
  }
})

/**
 * IPC: 删除自定义供应商 manifest
 * 说明：仅允许删除 source=custom 的渠道
 *
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} providerId - 待删除渠道 ID
 * @returns {Promise<{success: boolean, providerId: string|null, registryPath: string, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('delete-provider-manifest', async (event, providerId) => {
  try {
    await ensureProviderDefinitionsLoaded()

    if (typeof providerId !== 'string' || !providerId.trim()) {
      return {
        success: false,
        providerId: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: '渠道 id 非法',
        errorCode: 'INVALID_PROVIDER_ID',
      }
    }

    const normalizedId = providerId.trim()
    const existingDefinition = PROVIDER_DEFINITIONS[normalizedId]
    if (!existingDefinition) {
      return {
        success: false,
        providerId: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: '渠道不存在',
        errorCode: 'PROVIDER_NOT_FOUND',
      }
    }
    if (existingDefinition.source !== 'custom') {
      return {
        success: false,
        providerId: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: '仅支持删除自定义渠道',
        errorCode: 'BUILTIN_PROVIDER_READONLY',
      }
    }

    delete PROVIDER_DEFINITIONS[normalizedId]

    const saveResult = await persistCustomProviderDefinitions()
    if (!saveResult.success) {
      PROVIDER_DEFINITIONS[normalizedId] = existingDefinition
      return {
        success: false,
        providerId: null,
        registryPath: PROVIDER_REGISTRY_FILE_PATH,
        error: saveResult.error || '写入渠道注册表失败',
        errorCode: saveResult.errorCode || 'REGISTRY_WRITE_FAILED',
      }
    }

    return {
      success: true,
      providerId: normalizedId,
      registryPath: PROVIDER_REGISTRY_FILE_PATH,
      error: null,
      errorCode: null,
    }
  } catch (error) {
    console.error('Error deleting provider manifest:', error)
    return {
      success: false,
      providerId: null,
      registryPath: PROVIDER_REGISTRY_FILE_PATH,
      error: `删除渠道失败: ${error.message}`,
      errorCode: 'UNKNOWN_ERROR',
    }
  }
})

/**
 * IPC: 读取供应商 API Key 环境变量配置
 * @returns {Promise<{success: boolean, providers: Record<string, {token: string}>, envPath: string, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('get-provider-env-config', async () => {
  try {
    await ensureProviderDefinitionsLoaded()
    const { envSource, envPath, errorCode, error } = await loadMergedProviderEnv()
    const providerProfiles = getProviderProfiles(envSource)
    const providers = buildProviderTokenMap(providerProfiles)

    return {
      success: !errorCode,
      providers,
      envPath,
      error: errorCode ? error : null,
      errorCode,
    }
  } catch (error) {
    console.error('Error getting provider env config:', error)
    return {
      success: false,
      providers: buildProviderTokenMap({}),
      envPath: ENV_FILE_PATH,
      error: `读取环境变量失败: ${error.message}`,
      errorCode: 'UNKNOWN_ERROR',
    }
  }
})

/**
 * IPC: 保存供应商 API Key 到 .env
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} providerKey - 供应商 key
 * @param {string} token - API Key
 * @returns {Promise<{success: boolean, envPath: string, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('save-provider-token', async (event, providerKey, token) => {
  if (typeof providerKey !== 'string' || typeof token !== 'string') {
    return {
      success: false,
      envPath: ENV_FILE_PATH,
      error: '参数格式错误',
      errorCode: 'INVALID_ARGUMENT',
    }
  }

  try {
    await ensureProviderDefinitionsLoaded()
    return saveProviderTokenToEnv(providerKey, token)
  } catch (error) {
    return {
      success: false,
      envPath: ENV_FILE_PATH,
      error: `读取渠道定义失败: ${error.message}`,
      errorCode: 'REGISTRY_LOAD_FAILED',
    }
  }
})

/**
 * IPC: 测试供应商连接
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {{baseUrl: string, token: string, model?: string}} params - 测试参数
 * @returns {Promise<{success: boolean, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('test-provider-connection', async (event, params) => {
  try {
    return await testProviderConnection(params || {})
  } catch (error) {
    return {
      success: false,
      errorCode: 'UNKNOWN_ERROR',
      error: `连接测试失败: ${error.message}`,
    }
  }
})

/**
 * IPC: 切换 Claude 供应商
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} profileKey - 目标档位
 * @param {string|null|undefined} selectedModel - 可选模型覆盖
 * @returns {Promise<{success: boolean, backupPath: string|null, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('switch-claude-provider', async (event, profileKey, selectedModel) => {
  try {
    await ensureProviderDefinitionsLoaded()
    // IPC 参数类型校验
    if (typeof profileKey !== 'string' || !PROVIDER_DEFINITIONS[profileKey]) {
      return { success: false, backupPath: null, error: '无效的供应商档位', errorCode: 'INVALID_PROFILE_KEY' }
    }

    const { envSource, errorCode, error } = await loadMergedProviderEnv()
    if (errorCode) {
      return {
        success: false,
        backupPath: null,
        error: error || '读取 .env 文件失败',
        errorCode,
      }
    }
    const providerProfiles = getProviderProfiles(envSource)
    const normalizedSelectedModel = typeof selectedModel === 'string'
      ? selectedModel.trim()
      : ''
    if (normalizedSelectedModel) {
      const profileModels = Array.isArray(providerProfiles[profileKey]?.models)
        ? providerProfiles[profileKey].models
        : [providerProfiles[profileKey]?.model || 'opus']
      if (!profileModels.includes(normalizedSelectedModel)) {
        return {
          success: false,
          backupPath: null,
          error: '无效的模型选项',
          errorCode: 'INVALID_MODEL',
        }
      }
    }

    // 非官方档位要求必须已配置 API Key，避免写入无效配置。
    if (profileKey !== 'official' && !providerProfiles[profileKey].token) {
      return {
        success: false,
        backupPath: null,
        error: '请先为该供应商配置 API Key（保存到 .env）',
        errorCode: 'MISSING_API_KEY',
      }
    }

    const switchResult = await switchProviderInEnv(profileKey, providerProfiles)
    if (!switchResult.success) {
      const errorMap = {
        PERMISSION_DENIED: '写入失败：权限被拒绝，请检查 .env 文件写入权限',
        DISK_FULL: '写入失败：磁盘空间不足',
        CREATE_DIR_FAILED: `写入失败：无法创建目录 (${switchResult.error})`,
        WRITE_FAILED: `写入失败：无法写入临时文件 (${switchResult.error})`,
        RENAME_FAILED: `写入失败：无法完成配置替换 (${switchResult.error})`,
        READ_FAILED: switchResult.error || '读取 .env 文件失败',
      }
      return {
        success: false,
        backupPath: null,
        error: errorMap[switchResult.errorCode] || `切换失败: ${switchResult.error || '未知错误'}`,
        errorCode: switchResult.errorCode || 'UNKNOWN_ERROR',
      }
    }

    const settingsSwitchResult = await switchProviderInClaudeSettings(
      profileKey,
      providerProfiles,
      normalizedSelectedModel || null
    )
    if (!settingsSwitchResult.success) {
      const rollbackResult = await restoreEnvSnapshot(
        switchResult.previousContent,
        switchResult.previousExists
      )

      const settingsErrorMap = {
        PERMISSION_DENIED: '写入失败：无法更新 ~/.claude/settings.json（权限不足）',
        DISK_FULL: '写入失败：磁盘空间不足，无法更新 ~/.claude/settings.json',
        CONFIG_CORRUPTED: settingsSwitchResult.error || 'Claude settings.json 已损坏，无法切换',
        READ_FAILED: settingsSwitchResult.error || '读取 ~/.claude/settings.json 失败',
        WRITE_FAILED: settingsSwitchResult.error || '写入 ~/.claude/settings.json 失败',
        RENAME_FAILED: settingsSwitchResult.error || '更新 ~/.claude/settings.json 失败',
      }
      const baseError = settingsErrorMap[settingsSwitchResult.errorCode] ||
        `切换失败: ${settingsSwitchResult.error || 'settings 同步失败'}`

      if (!rollbackResult.success) {
        return {
          success: false,
          backupPath: settingsSwitchResult.backupPath || null,
          error: `${baseError}；同时回滚 .env 失败，请手动检查 .env 与 ~/.claude/settings.json`,
          errorCode: 'ROLLBACK_FAILED',
        }
      }

      return {
        success: false,
        backupPath: settingsSwitchResult.backupPath || null,
        error: `${baseError}；已自动回滚 .env，当前状态保持不变`,
        errorCode: settingsSwitchResult.errorCode || 'SETTINGS_SYNC_FAILED',
      }
    }

    clearRuntimeAuthConflictEnv()
    return {
      success: true,
      backupPath: settingsSwitchResult.backupPath || null,
      error: null,
      errorCode: null
    }
  } catch (error) {
    console.error('Error switching Claude provider:', error)
    return {
      success: false,
      backupPath: null,
      error: `切换失败: ${error.message}`,
      errorCode: 'UNKNOWN_ERROR'
    }
  }
})

}

module.exports = {
  registerProviderHandlers,
}
