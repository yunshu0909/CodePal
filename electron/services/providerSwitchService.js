/**
 * 供应商切换逻辑服务
 *
 * 负责：
 * - .env 中的供应商切换
 * - Claude settings 中的供应商切换
 * - .env 快照回滚
 * - 供应商检测（从环境变量/settings 推断当前供应商）
 * - 供应商配置档构建
 *
 * @module electron/services/providerSwitchService
 */

const fs = require('fs/promises')
const { normalizeEnvValue, applyEnvVariableUpdates, atomicWriteText } = require('./envFileService')

/**
 * 创建供应商切换服务实例
 * @param {Object} deps - 依赖注入
 * @param {string} deps.envFilePath - .env 文件路径
 * @param {Object} deps.envFileService - .env 文件操作服务
 * @param {Object} deps.claudeSettingsService - Claude settings 服务
 * @param {() => Record<string, Object>} deps.getProviderDefinitions - 获取当前供应商定义
 * @param {string} deps.activeProviderEnvKey - 当前供应商环境变量 key
 * @param {string[]} deps.claudeRuntimeEnvKeys - Claude 运行时环境变量 keys
 * @param {string[]} deps.managedClaudeEnvKeys - 需要管理的 Claude 环境变量 keys
 * @returns {Object} 供应商切换服务
 */
function createProviderSwitchService(deps) {
  const {
    envFilePath,
    envFileService,
    claudeSettingsService,
    getProviderDefinitions,
    activeProviderEnvKey,
    claudeRuntimeEnvKeys,
    managedClaudeEnvKeys,
  } = deps

  /**
   * 基于环境变量生成供应商配置档
   * @param {Record<string, string|undefined>} envSource - 环境变量来源
   * @returns {Record<string, {name: string, token: string|null, baseUrl: string|null, model: string, settingsEnv: Record<string, string>}>}
   */
  function getProviderProfiles(envSource = {}) {
    const profiles = {}
    const PROVIDER_DEFINITIONS = getProviderDefinitions()

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
   * 构造前端可用的 token 映射
   * @param {Record<string, {token: string|null}>} providerProfiles - 供应商配置档
   * @returns {Record<string, {token: string}>}
   */
  function buildProviderTokenMap(providerProfiles) {
    const providers = {}
    const PROVIDER_DEFINITIONS = getProviderDefinitions()

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
    const PROVIDER_DEFINITIONS = getProviderDefinitions()
    const definition = PROVIDER_DEFINITIONS[providerKey]
    return definition?.tokenEnvKey || null
  }

  /**
   * 从环境变量识别当前供应商
   * @param {Record<string, string|undefined>} envSource - 环境变量来源
   * @returns {string} providerId | custom
   */
  function detectProviderFromEnv(envSource) {
    const PROVIDER_DEFINITIONS = getProviderDefinitions()
    const explicitProvider = normalizeEnvValue(envSource[activeProviderEnvKey])
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
    const { isPlainObject } = claudeSettingsService

    if (!isPlainObject(settingsData)) return 'official'

    const managedApiKeyHelper = normalizeEnvValue(settingsData.apiKeyHelper)
    const envObject = isPlainObject(settingsData.env) ? settingsData.env : null
    if (!envObject) return managedApiKeyHelper ? 'custom' : 'official'

    // 兼容双通道：历史版本写入 AUTH_TOKEN，新版本优先支持 API_KEY。
    const token = normalizeEnvValue(envObject.ANTHROPIC_API_KEY) ||
      normalizeEnvValue(envObject.ANTHROPIC_AUTH_TOKEN)
    const baseUrl = normalizeEnvValue(envObject.ANTHROPIC_BASE_URL)

    if (!token && !baseUrl) {
      return managedApiKeyHelper ? 'custom' : 'official'
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
   * 将供应商切换结果写入 .env
   * @param {string} profileKey - 供应商档位
   * @param {Record<string, Object>} providerProfiles - 当前供应商配置档
   * @returns {Promise<{success: boolean, envPath: string, error: string|null, errorCode: string|null, previousContent: string, previousExists: boolean}>}
   */
  async function switchProviderInEnv(profileKey, providerProfiles) {
    const envReadResult = await envFileService.readProjectEnvFile()
    if (envReadResult.errorCode) {
      return { success: false, envPath: envFilePath, errorCode: envReadResult.errorCode, error: envReadResult.error, previousContent: '', previousExists: false }
    }

    const profile = providerProfiles[profileKey]
    if (!profile) {
      return { success: false, envPath: envFilePath, errorCode: 'INVALID_PROFILE_KEY', error: '无效的供应商档位', previousContent: envReadResult.content, previousExists: envReadResult.exists }
    }

    // 清理镜像字段时跳过"已被渠道定义占用"的运行时 key
    const PROVIDER_DEFINITIONS = getProviderDefinitions()
    const providerBoundRuntimeKeys = new Set()
    for (const definition of Object.values(PROVIDER_DEFINITIONS)) {
      if (definition.tokenEnvKey && claudeRuntimeEnvKeys.includes(definition.tokenEnvKey)) {
        providerBoundRuntimeKeys.add(definition.tokenEnvKey)
      }
      if (definition.baseUrlEnvKey && claudeRuntimeEnvKeys.includes(definition.baseUrlEnvKey)) {
        providerBoundRuntimeKeys.add(definition.baseUrlEnvKey)
      }
    }
    const runtimeCleanupKeys = claudeRuntimeEnvKeys.filter((key) => !providerBoundRuntimeKeys.has(key))

    const envUpdates = {
      [activeProviderEnvKey]: profileKey,
      ...Object.fromEntries(runtimeCleanupKeys.map((key) => [key, null])),
    }

    const updatedContent = applyEnvVariableUpdates(envReadResult.content, envUpdates)
    const writeResult = await atomicWriteText(envFilePath, updatedContent)
    if (!writeResult.success) {
      return { success: false, envPath: envFilePath, errorCode: writeResult.error, error: `写入 .env 失败: ${writeResult.error}`, previousContent: envReadResult.content, previousExists: envReadResult.exists }
    }

    return { success: true, envPath: envFilePath, errorCode: null, error: null, previousContent: envReadResult.content, previousExists: envReadResult.exists }
  }

  /**
   * 将供应商切换结果写入 Claude settings.json
   * @param {string} profileKey - 供应商档位
   * @param {Record<string, Object>} providerProfiles - 当前供应商配置档
   * @returns {Promise<{success: boolean, settingsPath: string, backupPath: string|null, error: string|null, errorCode: string|null}>}
   */
  async function switchProviderInClaudeSettings(profileKey, providerProfiles) {
    const profile = providerProfiles[profileKey]
    if (!profile) {
      return { success: false, settingsPath: claudeSettingsService.settingsFilePath, backupPath: null, error: '无效的供应商档位', errorCode: 'INVALID_PROFILE_KEY' }
    }

    const settingsReadResult = await claudeSettingsService.readClaudeSettingsFile()
    if (!settingsReadResult.success) {
      return { success: false, settingsPath: claudeSettingsService.settingsFilePath, backupPath: settingsReadResult.backupPath || null, error: settingsReadResult.error || '读取 Claude settings.json 失败', errorCode: settingsReadResult.errorCode || 'READ_FAILED' }
    }

    let backupPath = null
    if (settingsReadResult.exists) {
      const backupResult = await claudeSettingsService.backupClaudeSettingsRaw(settingsReadResult.content, 'switch')
      if (!backupResult.success) {
        return { success: false, settingsPath: claudeSettingsService.settingsFilePath, backupPath: null, error: backupResult.error || '备份 Claude settings.json 失败', errorCode: backupResult.errorCode || 'WRITE_FAILED' }
      }
      backupPath = backupResult.backupPath
    }

    if (profile.token) {
      const helperResult = await claudeSettingsService.ensureClaudeApiKeyHelperScript()
      if (!helperResult.success) {
        return { success: false, settingsPath: claudeSettingsService.settingsFilePath, backupPath, error: helperResult.error || '写入 Claude apiKeyHelper 脚本失败', errorCode: helperResult.errorCode || 'WRITE_FAILED' }
      }
    }

    const updatedSettings = claudeSettingsService.applyProviderProfileToSettings(
      settingsReadResult.data, profile, managedClaudeEnvKeys
    )
    const updatedSettingsText = `${JSON.stringify(updatedSettings, null, 2)}\n`
    const writeResult = await atomicWriteText(claudeSettingsService.settingsFilePath, updatedSettingsText)
    if (!writeResult.success) {
      return { success: false, settingsPath: claudeSettingsService.settingsFilePath, backupPath, error: `写入 Claude settings.json 失败: ${writeResult.error}`, errorCode: writeResult.error || 'WRITE_FAILED' }
    }

    return { success: true, settingsPath: claudeSettingsService.settingsFilePath, backupPath, error: null, errorCode: null }
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
          await fs.unlink(envFilePath)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        return { success: true, errorCode: null, error: null }
      }

      const writeResult = await atomicWriteText(envFilePath, previousContent)
      if (!writeResult.success) {
        return { success: false, errorCode: writeResult.error || 'WRITE_FAILED', error: `回滚 .env 失败: ${writeResult.error}` }
      }
      return { success: true, errorCode: null, error: null }
    } catch (error) {
      return { success: false, errorCode: error.code || 'ROLLBACK_FAILED', error: `回滚 .env 失败: ${error.message}` }
    }
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
      return { success: false, envPath: envFilePath, errorCode: 'INVALID_PROVIDER', error: '该供应商不支持保存 API Key' }
    }

    const normalizedToken = token.trim()
    if (!normalizedToken) {
      return { success: false, envPath: envFilePath, errorCode: 'INVALID_TOKEN', error: 'API Key 不能为空' }
    }

    const envReadResult = await envFileService.readProjectEnvFile()
    if (envReadResult.errorCode) {
      return { success: false, envPath: envFilePath, errorCode: envReadResult.errorCode, error: envReadResult.error }
    }

    const runtimeCleanupKeys = claudeRuntimeEnvKeys.filter((key) => key !== tokenEnvKey)
    const envUpdates = {
      [tokenEnvKey]: normalizedToken,
      ...Object.fromEntries(runtimeCleanupKeys.map((key) => [key, null])),
    }

    const updatedContent = applyEnvVariableUpdates(envReadResult.content, envUpdates)
    const writeResult = await atomicWriteText(envFilePath, updatedContent)
    if (!writeResult.success) {
      return { success: false, envPath: envFilePath, errorCode: writeResult.error, error: `写入 .env 失败: ${writeResult.error}` }
    }

    return { success: true, envPath: envFilePath, errorCode: null, error: null }
  }

  return {
    getProviderProfiles,
    buildProviderTokenMap,
    getProviderTokenEnvKey,
    detectProviderFromEnv,
    detectProviderFromSettings,
    switchProviderInEnv,
    switchProviderInClaudeSettings,
    restoreEnvSnapshot,
    saveProviderTokenToEnv,
  }
}

module.exports = {
  createProviderSwitchService,
}
