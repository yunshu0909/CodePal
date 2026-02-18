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

/**
 * 注册供应商相关 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 * @param {string} [deps.envFilePath] - .env 文件路径
 */
function registerProviderHandlers({ ipcMain, pathExists, envFilePath }) {
  const ENV_FILE_PATH = envFilePath || path.resolve(__dirname, '..', '..', '.env')
  dotenv.config({ path: ENV_FILE_PATH })

// ==================== V0.7 供应商切换 ====================

const PROVIDER_DEFINITIONS = {
  official: {
    name: 'Claude Official',
    model: 'opus',
    tokenEnvKey: null,
    baseUrlEnvKey: null,
    defaultBaseUrl: null,
    settingsEnv: {},
  },
  qwen: {
    name: 'Qwen3 Coder Plus',
    model: 'opus',
    tokenEnvKey: 'QWEN_API_KEY',
    baseUrlEnvKey: 'QWEN_BASE_URL',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    settingsEnv: {
      ANTHROPIC_MODEL: 'qwen3-coder-plus',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-coder-plus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-coder-plus',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder-plus',
    },
  },
  kimi: {
    name: 'Kimi For Coding',
    model: 'opus',
    tokenEnvKey: 'KIMI_API_KEY',
    baseUrlEnvKey: 'KIMI_BASE_URL',
    defaultBaseUrl: 'https://api.kimi.com/coding/',
    settingsEnv: {},
  },
  aicodemirror: {
    name: 'AICodeMirror',
    model: 'opus',
    tokenEnvKey: 'AICODEMIRROR_API_KEY',
    baseUrlEnvKey: 'AICODEMIRROR_BASE_URL',
    defaultBaseUrl: 'https://api.aicodemirror.com/api/claudecode',
    settingsEnv: {},
  },
}
const ACTIVE_PROVIDER_ENV_KEY = 'CLAUDE_CODE_PROVIDER'
const CLAUDE_SETTINGS_FILE_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_SETTINGS_BACKUP_DIR = path.join(os.homedir(), '.claude', 'backups')
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
 * @returns {Record<string, {name: string, token: string|null, baseUrl: string|null, model: string, settingsEnv: Record<string, string>}>}
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
      settingsEnv: definition.settingsEnv || {},
    }
  }

  return profiles
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

  // 允许通过进程环境变量临时覆盖（如 CI/E2E），不影响 .env 持久化策略。
  for (const key of managedKeys) {
    const runtimeValue = normalizeEnvValue(process.env[key])
    if (runtimeValue) {
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

  const envUpdates = {
    [tokenEnvKey]: normalizedToken,
    // 单一来源：保存供应商专属 key 时顺手清理旧的运行时镜像字段。
    ...Object.fromEntries(CLAUDE_RUNTIME_ENV_KEYS.map((key) => [key, null])),
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

  return { success: true, envPath: ENV_FILE_PATH, errorCode: null, error: null }
}

/**
 * 从环境变量识别当前供应商
 * @param {Record<string, string|undefined>} envSource - 环境变量来源
 * @returns {string} official | qwen | kimi | aicodemirror | custom
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
 * @returns {string} official | qwen | kimi | aicodemirror | custom
 */
function detectProviderFromSettings(settingsData, providerProfiles) {
  if (!isPlainObject(settingsData)) return 'official'

  const envObject = isPlainObject(settingsData.env) ? settingsData.env : null
  if (!envObject) return 'official'

  const token = normalizeEnvValue(envObject.ANTHROPIC_AUTH_TOKEN)
  const baseUrl = normalizeEnvValue(envObject.ANTHROPIC_BASE_URL)

  if (!token && !baseUrl) {
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
 * @param {{token: string|null, baseUrl: string|null, model: string, settingsEnv?: Record<string, string>}} profile - 目标供应商档
 * @returns {Record<string, any>}
 */
function applyProviderProfileToSettings(settingsData, profile) {
  const source = isPlainObject(settingsData) ? settingsData : {}
  const updated = JSON.parse(JSON.stringify(source))
  const envObject = isPlainObject(updated.env) ? updated.env : {}

  for (const key of MANAGED_CLAUDE_ENV_KEYS) {
    delete envObject[key]
  }

  if (profile.token) {
    envObject.ANTHROPIC_AUTH_TOKEN = profile.token
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

  updated.env = envObject
  updated.model = profile.model
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

  const envUpdates = {
    [ACTIVE_PROVIDER_ENV_KEY]: profileKey,
    // 单一来源：切换时删除历史镜像字段，避免双轨状态并存。
    ...Object.fromEntries(CLAUDE_RUNTIME_ENV_KEYS.map((key) => [key, null])),
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
 * @param {Record<string, {token: string|null, baseUrl: string|null, model: string}>} providerProfiles - 当前供应商配置档
 * @returns {Promise<{success: boolean, settingsPath: string, backupPath: string|null, error: string|null, errorCode: string|null}>}
 */
async function switchProviderInClaudeSettings(profileKey, providerProfiles) {
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

  const updatedSettings = applyProviderProfileToSettings(settingsReadResult.data, profile)
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
 * IPC: 读取供应商 API Key 环境变量配置
 * @returns {Promise<{success: boolean, providers: Record<string, {token: string}>, envPath: string, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('get-provider-env-config', async () => {
  try {
    const { envSource, envPath, errorCode, error } = await loadMergedProviderEnv()
    const providerProfiles = getProviderProfiles(envSource)

    const providers = {
      qwen: { token: providerProfiles.qwen.token || '' },
      kimi: { token: providerProfiles.kimi.token || '' },
      aicodemirror: { token: providerProfiles.aicodemirror.token || '' },
    }

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
      providers: {
        qwen: { token: '' },
        kimi: { token: '' },
        aicodemirror: { token: '' },
      },
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

  return saveProviderTokenToEnv(providerKey, token)
})

/**
 * IPC: 切换 Claude 供应商
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} profileKey - 目标档位
 * @returns {Promise<{success: boolean, backupPath: string|null, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('switch-claude-provider', async (event, profileKey) => {
  // IPC 参数类型校验
  if (typeof profileKey !== 'string' || !PROVIDER_DEFINITIONS[profileKey]) {
    return { success: false, backupPath: null, error: '无效的供应商档位', errorCode: 'INVALID_PROFILE_KEY' }
  }

  try {
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

    const settingsSwitchResult = await switchProviderInClaudeSettings(profileKey, providerProfiles)
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
