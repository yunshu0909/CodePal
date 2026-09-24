/**
 * 渠道注册表路径服务
 *
 * 负责：
 * - 统一解析渠道注册表的运行时路径（App / MCP 共用）
 * - 支持环境变量覆盖，便于多环境部署
 * - 提供用户目录默认路径，避免写入打包产物目录
 *
 * @module electron/services/providerRegistryPathService
 */

const os = require('os')
const path = require('path')
const { PROVIDER_REGISTRY_FILE_NAME } = require('./providerRegistryService')

const REGISTRY_PATH_ENV_KEY = 'SKILL_MANAGER_PROVIDER_REGISTRY_PATH'
const SHARED_HOME_ENV_KEY = 'SKILL_MANAGER_SHARED_HOME'
const DEFAULT_SHARED_HOME_DIR = path.join(os.homedir(), 'Documents', 'SkillManager')

/**
 * 规范化可选路径字符串
 * @param {unknown} value - 原始输入
 * @returns {string|null}
 */
function normalizeOptionalPath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? path.resolve(trimmed) : null
}

/**
 * 解析渠道注册表文件路径
 * @param {Object} [options] - 可选参数
 * @param {Record<string, string|undefined>} [options.env] - 环境变量映射
 * @returns {string}
 */
function resolveProviderRegistryFilePath(options = {}) {
  const envMap = options.env || process.env

  const explicitRegistryPath = normalizeOptionalPath(envMap[REGISTRY_PATH_ENV_KEY])
  if (explicitRegistryPath) return explicitRegistryPath

  const sharedHomeDir = normalizeOptionalPath(envMap[SHARED_HOME_ENV_KEY]) || DEFAULT_SHARED_HOME_DIR
  return path.join(sharedHomeDir, PROVIDER_REGISTRY_FILE_NAME)
}

module.exports = {
  REGISTRY_PATH_ENV_KEY,
  SHARED_HOME_ENV_KEY,
  DEFAULT_SHARED_HOME_DIR,
  resolveProviderRegistryFilePath,
}
