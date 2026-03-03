/**
 * Claude 供应商 IPC 注册模块
 *
 * 负责：
 * - 注册供应商读取/切换/API Key 保存相关 IPC
 * - 隔离 provider 业务逻辑，降低 main.js 体积
 *
 * @module electron/handlers/registerProviderHandlers
 */

const path = require('path')
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
const { createEnvFileService } = require('../services/envFileService')
const { createClaudeSettingsService } = require('../services/claudeSettingsService')
const { createProviderSwitchService } = require('../services/providerSwitchService')

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

  // ==================== 供应商定义管理 ====================

  const PROVIDER_DEFINITIONS = { ...BUILTIN_PROVIDER_DEFINITIONS }
  let providerDefinitionsLoadError = null
  const ACTIVE_PROVIDER_ENV_KEY = 'CLAUDE_CODE_PROVIDER'
  const CLAUDE_RUNTIME_ENV_KEYS = [
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]
  const MANAGED_CLAUDE_ENV_KEYS = [
    ...CLAUDE_RUNTIME_ENV_KEYS,
    'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  ]

  // ==================== 服务实例化 ====================

  const envFileService = createEnvFileService({ envFilePath: ENV_FILE_PATH, pathExists })
  const claudeSettingsService = createClaudeSettingsService({ pathExists })
  const providerSwitchService = createProviderSwitchService({
    envFilePath: ENV_FILE_PATH,
    envFileService,
    claudeSettingsService,
    getProviderDefinitions: () => PROVIDER_DEFINITIONS,
    activeProviderEnvKey: ACTIVE_PROVIDER_ENV_KEY,
    claudeRuntimeEnvKeys: CLAUDE_RUNTIME_ENV_KEYS,
    managedClaudeEnvKeys: MANAGED_CLAUDE_ENV_KEYS,
  })

  // ==================== 供应商定义加载 ====================

  /**
   * 延迟加载自定义渠道定义
   */
  async function ensureProviderDefinitionsLoaded() {
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

  function resetProviderDefinitionsToBuiltin() {
    for (const providerKey of Object.keys(PROVIDER_DEFINITIONS)) {
      delete PROVIDER_DEFINITIONS[providerKey]
    }
    for (const [providerKey, definition] of Object.entries(BUILTIN_PROVIDER_DEFINITIONS)) {
      PROVIDER_DEFINITIONS[providerKey] = definition
    }
  }

  async function persistCustomProviderDefinitions() {
    return saveCustomProviderDefinitions({
      registryFilePath: PROVIDER_REGISTRY_FILE_PATH,
      providerDefinitions: PROVIDER_DEFINITIONS,
    })
  }

  /**
   * 加载合并后的供应商环境变量
   * @returns {Promise<Object>}
   */
  async function loadMergedEnv() {
    const managedKeys = [ACTIVE_PROVIDER_ENV_KEY]
    for (const definition of Object.values(PROVIDER_DEFINITIONS)) {
      if (definition.tokenEnvKey) managedKeys.push(definition.tokenEnvKey)
      if (definition.baseUrlEnvKey) managedKeys.push(definition.baseUrlEnvKey)
    }
    return envFileService.loadMergedProviderEnv(managedKeys)
  }

  // ==================== IPC Handlers ====================

  /**
   * IPC: 获取当前 Claude 供应商配置
   */
  ipcMain.handle('get-claude-provider', async () => {
    try {
      await ensureProviderDefinitionsLoaded()
      const { envSource, envExists, errorCode, error } = await loadMergedEnv()
      const providerProfiles = providerSwitchService.getProviderProfiles(envSource)

      if (errorCode) {
        return { success: false, current: 'official', profile: providerProfiles.official, isNew: false, corruptedBackup: null, error: error || '读取环境变量失败', errorCode }
      }

      const settingsReadResult = await claudeSettingsService.readClaudeSettingsFile()
      if (!settingsReadResult.success) {
        if (settingsReadResult.errorCode === 'CONFIG_CORRUPTED') {
          const fallbackCurrent = providerSwitchService.detectProviderFromEnv(envSource)
          return { success: true, current: fallbackCurrent, profile: providerProfiles[fallbackCurrent] || null, isNew: !envExists, corruptedBackup: settingsReadResult.backupPath || null, error: settingsReadResult.error, errorCode: settingsReadResult.errorCode }
        }
        return { success: false, current: 'official', profile: providerProfiles.official, isNew: false, corruptedBackup: settingsReadResult.backupPath || null, error: settingsReadResult.error || '读取 Claude settings.json 失败', errorCode: settingsReadResult.errorCode || 'READ_FAILED' }
      }

      const current = providerSwitchService.detectProviderFromSettings(settingsReadResult.data, providerProfiles)
      return { success: true, current, profile: providerProfiles[current] || null, isNew: !envExists && !settingsReadResult.exists, corruptedBackup: null, error: null, errorCode: null }
    } catch (error) {
      console.error('Error getting Claude provider:', error)
      const fallbackProfiles = providerSwitchService.getProviderProfiles({})
      return { success: false, current: 'official', profile: fallbackProfiles.official, isNew: false, corruptedBackup: null, error: `获取配置失败: ${error.message}`, errorCode: 'UNKNOWN_ERROR' }
    }
  })

  /**
   * IPC: 获取当前可用供应商定义
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
      return { success: false, providers: buildProviderCards(BUILTIN_PROVIDER_DEFINITIONS), registryPath: PROVIDER_REGISTRY_FILE_PATH, error: `读取渠道定义失败: ${error.message}`, errorCode: 'UNKNOWN_ERROR' }
    }
  })

  /**
   * IPC: 注册自定义供应商 manifest
   */
  ipcMain.handle('register-provider-manifest', async (event, manifest) => {
    try {
      await ensureProviderDefinitionsLoaded()

      const validation = validateProviderManifest(manifest, PROVIDER_DEFINITIONS)
      if (!validation.success || !validation.normalized) {
        return { success: false, provider: null, registryPath: PROVIDER_REGISTRY_FILE_PATH, error: validation.error || '渠道 manifest 非法', errorCode: validation.errorCode || 'INVALID_MANIFEST' }
      }

      const { id, definition } = createProviderDefinitionFromManifest(validation.normalized)
      PROVIDER_DEFINITIONS[id] = definition

      const saveResult = await persistCustomProviderDefinitions()
      if (!saveResult.success) {
        delete PROVIDER_DEFINITIONS[id]
        return { success: false, provider: null, registryPath: PROVIDER_REGISTRY_FILE_PATH, error: saveResult.error || '写入渠道注册表失败', errorCode: saveResult.errorCode || 'REGISTRY_WRITE_FAILED' }
      }

      return { success: true, provider: buildProviderCards({ [id]: definition })[0] || null, registryPath: PROVIDER_REGISTRY_FILE_PATH, error: null, errorCode: null }
    } catch (error) {
      console.error('Error registering provider manifest:', error)
      return { success: false, provider: null, registryPath: PROVIDER_REGISTRY_FILE_PATH, error: `注册渠道失败: ${error.message}`, errorCode: 'UNKNOWN_ERROR' }
    }
  })

  /**
   * IPC: 读取供应商 API Key 环境变量配置
   */
  ipcMain.handle('get-provider-env-config', async () => {
    try {
      await ensureProviderDefinitionsLoaded()
      const { envSource, envPath, errorCode, error } = await loadMergedEnv()
      const providerProfiles = providerSwitchService.getProviderProfiles(envSource)
      const providers = providerSwitchService.buildProviderTokenMap(providerProfiles)

      return { success: !errorCode, providers, envPath, error: errorCode ? error : null, errorCode }
    } catch (error) {
      console.error('Error getting provider env config:', error)
      return { success: false, providers: providerSwitchService.buildProviderTokenMap({}), envPath: ENV_FILE_PATH, error: `读取环境变量失败: ${error.message}`, errorCode: 'UNKNOWN_ERROR' }
    }
  })

  /**
   * IPC: 保存供应商 API Key 到 .env
   */
  ipcMain.handle('save-provider-token', async (event, providerKey, token) => {
    if (typeof providerKey !== 'string' || typeof token !== 'string') {
      return { success: false, envPath: ENV_FILE_PATH, error: '参数格式错误', errorCode: 'INVALID_ARGUMENT' }
    }

    try {
      await ensureProviderDefinitionsLoaded()
      return providerSwitchService.saveProviderTokenToEnv(providerKey, token)
    } catch (error) {
      return { success: false, envPath: ENV_FILE_PATH, error: `读取渠道定义失败: ${error.message}`, errorCode: 'REGISTRY_LOAD_FAILED' }
    }
  })

  /**
   * IPC: 切换 Claude 供应商
   */
  ipcMain.handle('switch-claude-provider', async (event, profileKey) => {
    try {
      await ensureProviderDefinitionsLoaded()

      if (typeof profileKey !== 'string' || !PROVIDER_DEFINITIONS[profileKey]) {
        return { success: false, backupPath: null, error: '无效的供应商档位', errorCode: 'INVALID_PROFILE_KEY' }
      }

      const { envSource, errorCode, error } = await loadMergedEnv()
      if (errorCode) {
        return { success: false, backupPath: null, error: error || '读取 .env 文件失败', errorCode }
      }
      const providerProfiles = providerSwitchService.getProviderProfiles(envSource)

      // 非官方档位要求必须已配置 API Key
      if (profileKey !== 'official' && !providerProfiles[profileKey].token) {
        return { success: false, backupPath: null, error: '请先为该供应商配置 API Key（保存到 .env）', errorCode: 'MISSING_API_KEY' }
      }

      const switchResult = await providerSwitchService.switchProviderInEnv(profileKey, providerProfiles)
      if (!switchResult.success) {
        const errorMap = {
          PERMISSION_DENIED: '写入失败：权限被拒绝，请检查 .env 文件写入权限',
          DISK_FULL: '写入失败：磁盘空间不足',
          CREATE_DIR_FAILED: `写入失败：无法创建目录 (${switchResult.error})`,
          WRITE_FAILED: `写入失败：无法写入临时文件 (${switchResult.error})`,
          RENAME_FAILED: `写入失败：无法完成配置替换 (${switchResult.error})`,
          READ_FAILED: switchResult.error || '读取 .env 文件失败',
        }
        return { success: false, backupPath: null, error: errorMap[switchResult.errorCode] || `切换失败: ${switchResult.error || '未知错误'}`, errorCode: switchResult.errorCode || 'UNKNOWN_ERROR' }
      }

      const settingsSwitchResult = await providerSwitchService.switchProviderInClaudeSettings(profileKey, providerProfiles)
      if (!settingsSwitchResult.success) {
        const rollbackResult = await providerSwitchService.restoreEnvSnapshot(
          switchResult.previousContent, switchResult.previousExists
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
          return { success: false, backupPath: settingsSwitchResult.backupPath || null, error: `${baseError}；同时回滚 .env 失败，请手动检查 .env 与 ~/.claude/settings.json`, errorCode: 'ROLLBACK_FAILED' }
        }

        return { success: false, backupPath: settingsSwitchResult.backupPath || null, error: `${baseError}；已自动回滚 .env，当前状态保持不变`, errorCode: settingsSwitchResult.errorCode || 'SETTINGS_SYNC_FAILED' }
      }

      return { success: true, backupPath: settingsSwitchResult.backupPath || null, error: null, errorCode: null }
    } catch (error) {
      console.error('Error switching Claude provider:', error)
      return { success: false, backupPath: null, error: `切换失败: ${error.message}`, errorCode: 'UNKNOWN_ERROR' }
    }
  })

}

module.exports = {
  registerProviderHandlers,
}
