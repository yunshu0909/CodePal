/**
 * Claude settings.json 文件操作服务
 *
 * 负责：
 * - 读取并解析 ~/.claude/settings.json
 * - 备份 settings 文件
 * - 确保 apiKeyHelper 脚本存在
 * - 将供应商配置应用到 settings
 *
 * @module electron/services/claudeSettingsService
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { normalizeEnvValue } = require('./envFileService')

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
 * 创建 Claude settings 服务实例
 * @param {Object} deps - 依赖注入
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 * @returns {Object} Claude settings 服务
 */
function createClaudeSettingsService({ pathExists }) {
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
        return { success: false, backupPath: null, errorCode: 'PERMISSION_DENIED', error: '无法写入 Claude settings 备份，请检查权限' }
      }
      if (error.code === 'ENOSPC') {
        return { success: false, backupPath: null, errorCode: 'DISK_FULL', error: '磁盘空间不足，无法写入 Claude settings 备份' }
      }
      return { success: false, backupPath: null, errorCode: 'WRITE_FAILED', error: `写入 Claude settings 备份失败: ${error.message}` }
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
      return { success: true, helperPath: CLAUDE_API_KEY_HELPER_PATH, errorCode: null, error: null }
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return { success: false, helperPath: null, errorCode: 'PERMISSION_DENIED', error: '无法写入 Claude apiKeyHelper 脚本，请检查权限' }
      }
      if (error.code === 'ENOSPC') {
        return { success: false, helperPath: null, errorCode: 'DISK_FULL', error: '磁盘空间不足，无法写入 Claude apiKeyHelper 脚本' }
      }
      return { success: false, helperPath: null, errorCode: 'WRITE_FAILED', error: `写入 Claude apiKeyHelper 脚本失败: ${error.message}` }
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
        return { success: true, exists: false, content: '', data: {}, errorCode: null, error: null, backupPath: null }
      }

      const content = await fs.readFile(CLAUDE_SETTINGS_FILE_PATH, 'utf-8')
      let data

      try {
        data = JSON.parse(content)
      } catch {
        const backupResult = await backupClaudeSettingsRaw(content, 'corrupted')
        const backupMessage = backupResult.success
          ? `已备份到 ${backupResult.backupPath}`
          : `备份失败（${backupResult.error || '未知错误'}）`
        return { success: false, exists: true, content, data: {}, errorCode: 'CONFIG_CORRUPTED', error: `Claude settings.json 已损坏，${backupMessage}`, backupPath: backupResult.backupPath || null }
      }

      if (!isPlainObject(data)) {
        const backupResult = await backupClaudeSettingsRaw(content, 'corrupted')
        const backupMessage = backupResult.success
          ? `已备份到 ${backupResult.backupPath}`
          : `备份失败（${backupResult.error || '未知错误'}）`
        return { success: false, exists: true, content, data: {}, errorCode: 'CONFIG_CORRUPTED', error: `Claude settings.json 结构异常，${backupMessage}`, backupPath: backupResult.backupPath || null }
      }

      return { success: true, exists: true, content, data, errorCode: null, error: null, backupPath: null }
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return { success: false, exists: false, content: '', data: {}, errorCode: 'PERMISSION_DENIED', error: '无法读取 Claude settings.json，请检查权限', backupPath: null }
      }
      return { success: false, exists: false, content: '', data: {}, errorCode: 'READ_FAILED', error: `读取 Claude settings.json 失败: ${error.message}`, backupPath: null }
    }
  }

  /**
   * 将供应商档应用到 Claude settings 数据
   * @param {Record<string, any>} settingsData - 原始 settings 数据
   * @param {{token: string|null, baseUrl: string|null, model: string, settingsEnv?: Record<string, string>}} profile - 目标供应商档
   * @param {string[]} managedEnvKeys - 需要清理的 env keys
   * @returns {Record<string, any>}
   */
  function applyProviderProfileToSettings(settingsData, profile, managedEnvKeys) {
    const source = isPlainObject(settingsData) ? settingsData : {}
    const updated = JSON.parse(JSON.stringify(source))
    const envObject = isPlainObject(updated.env) ? updated.env : {}

    for (const key of managedEnvKeys) {
      delete envObject[key]
    }

    if (profile.token) {
      // 仅写 API_KEY：避免将第三方 sk-* 误当作 OAuth token 走账号登录链路。
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

    updated.env = envObject
    if (profile.token) {
      // Claude CLI 登录判断优先读取 apiKeyHelper
      updated.apiKeyHelper = CLAUDE_API_KEY_HELPER_PATH
    } else {
      // Official 严格登录模式：无条件清理 apiKeyHelper
      delete updated.apiKeyHelper
    }
    updated.model = profile.model
    return updated
  }

  return {
    settingsFilePath: CLAUDE_SETTINGS_FILE_PATH,
    apiKeyHelperPath: CLAUDE_API_KEY_HELPER_PATH,
    backupClaudeSettingsRaw,
    ensureClaudeApiKeyHelperScript,
    readClaudeSettingsFile,
    applyProviderProfileToSettings,
    isPlainObject,
  }
}

module.exports = {
  isPlainObject,
  createClaudeSettingsService,
}
