/**
 * 内置 MCP 安装服务
 *
 * 负责：
 * - 启动时自动 ensure 安装内置 provider_registry MCP
 * - 按工具配置格式（Claude JSON / Codex TOML）执行幂等写入
 * - 仅在工具目录存在时写入，避免污染未安装工具环境
 *
 * @module electron/services/builtinMcpInstallerService
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const TOML = require('@iarna/toml')

const BUILTIN_MCP_ID = 'provider_registry'

const TOOL_DEFINITIONS = {
  claude: {
    configPath: path.join(os.homedir(), '.claude.json'),
    homePath: path.join(os.homedir(), '.claude'),
    containerKey: 'mcpServers',
    format: 'json',
  },
  codex: {
    configPath: path.join(os.homedir(), '.codex', 'config.toml'),
    homePath: path.join(os.homedir(), '.codex'),
    containerKey: 'mcp_servers',
    format: 'toml',
  }
}

/**
 * 判断路径是否存在
 * @param {string} targetPath - 目标路径
 * @returns {Promise<boolean>}
 */
async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

/**
 * 判断值是否为普通对象
 * @param {unknown} value - 待判断值
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 比较两个对象是否 JSON 语义一致
 * @param {unknown} left - 左值
 * @param {unknown} right - 右值
 * @returns {boolean}
 */
function isJsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * 构建 provider_registry 的标准配置
 * @param {string} scriptPath - MCP 服务脚本路径
 * @param {string} registryPath - 注册表文件路径
 * @returns {{command: string, args: string[], env: Record<string, string>}}
 */
function buildDesiredProviderRegistryEntry(scriptPath, registryPath) {
  return {
    command: 'node',
    args: [scriptPath],
    env: {
      SKILL_MANAGER_PROVIDER_REGISTRY_PATH: registryPath
    }
  }
}

/**
 * 合并已有配置与目标配置，保留未知字段
 * @param {unknown} existingEntry - 已有配置条目
 * @param {{command: string, args: string[], env: Record<string, string>}} desiredEntry - 目标配置条目
 * @returns {object}
 */
function buildNextProviderRegistryEntry(existingEntry, desiredEntry) {
  const safeExisting = isPlainObject(existingEntry) ? existingEntry : {}
  const existingEnv = isPlainObject(safeExisting.env) ? safeExisting.env : {}

  const nextEntry = {
    ...safeExisting,
    command: desiredEntry.command,
    args: [...desiredEntry.args],
    env: {
      ...existingEnv,
      ...desiredEntry.env
    }
  }

  // provider_registry 固定走 stdio，去掉历史 http 字段避免歧义
  delete nextEntry.url

  return nextEntry
}

/**
 * 读取工具配置文件；不存在时返回空对象
 * @param {'claude'|'codex'} tool - 工具类型
 * @returns {Promise<{data: object, exists: boolean}>}
 */
async function readToolConfig(tool) {
  const definition = TOOL_DEFINITIONS[tool]
  const { configPath, format } = definition

  if (!(await pathExists(configPath))) {
    return { data: {}, exists: false }
  }

  const raw = await fs.readFile(configPath, 'utf-8')
  if (format === 'json') {
    const parsed = JSON.parse(raw)
    if (!isPlainObject(parsed)) {
      throw new Error(`${tool} 配置根节点不是对象`)
    }
    return { data: parsed, exists: true }
  }

  const parsed = TOML.parse(raw)
  if (!isPlainObject(parsed)) {
    throw new Error(`${tool} 配置根节点不是对象`)
  }
  return { data: parsed, exists: true }
}

/**
 * 原子写入配置文件
 * @param {'claude'|'codex'} tool - 工具类型
 * @param {object} data - 配置对象
 * @returns {Promise<void>}
 */
async function writeToolConfig(tool, data) {
  const definition = TOOL_DEFINITIONS[tool]
  const { configPath, format } = definition
  const parentDir = path.dirname(configPath)
  const tempPath = `${configPath}.tmp.${process.pid}.${Date.now()}`
  const content = format === 'json'
    ? `${JSON.stringify(data, null, 2)}\n`
    : TOML.stringify(data)

  await fs.mkdir(parentDir, { recursive: true })

  try {
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, configPath)
  } catch (error) {
    try {
      await fs.unlink(tempPath)
    } catch {}
    throw error
  }
}

/**
 * 判断工具是否应执行自动安装
 * @param {'claude'|'codex'} tool - 工具类型
 * @returns {Promise<boolean>}
 */
async function shouldEnsureForTool(tool) {
  const definition = TOOL_DEFINITIONS[tool]
  const [hasConfig, hasHomeDir] = await Promise.all([
    pathExists(definition.configPath),
    pathExists(definition.homePath)
  ])

  return hasConfig || hasHomeDir
}

/**
 * 对单个工具执行内置 MCP ensure 安装
 * @param {'claude'|'codex'} tool - 工具类型
 * @param {{command: string, args: string[], env: Record<string, string>}} desiredEntry - 目标配置条目
 * @returns {Promise<{tool: 'claude'|'codex', status: 'skipped'|'unchanged'|'updated'|'created', reason?: string}>}
 */
async function ensureForTool(tool, desiredEntry) {
  const shouldEnsure = await shouldEnsureForTool(tool)
  if (!shouldEnsure) {
    return {
      tool,
      status: 'skipped',
      reason: 'TOOL_HOME_NOT_FOUND'
    }
  }

  const definition = TOOL_DEFINITIONS[tool]
  const { data, exists } = await readToolConfig(tool)
  const containerKey = definition.containerKey

  if (!isPlainObject(data[containerKey])) {
    data[containerKey] = {}
  }

  const existingEntry = data[containerKey][BUILTIN_MCP_ID]
  const nextEntry = buildNextProviderRegistryEntry(existingEntry, desiredEntry)

  if (isPlainObject(existingEntry) && isJsonEqual(existingEntry, nextEntry)) {
    return { tool, status: 'unchanged' }
  }

  data[containerKey][BUILTIN_MCP_ID] = nextEntry
  await writeToolConfig(tool, data)

  return {
    tool,
    status: exists ? 'updated' : 'created'
  }
}

/**
 * 启动时确保内置 provider_registry 已安装到工具配置
 * @param {Object} options - 参数
 * @param {string} options.providerRegistryScriptPath - provider_registry_mcp.js 绝对路径
 * @param {string} options.providerRegistryFilePath - provider registry 数据文件路径
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger] - 日志接口
 * @returns {Promise<{success: boolean, results: Array, error: string|null}>}
 */
async function ensureBuiltinProviderRegistryInstalled(options) {
  const {
    providerRegistryScriptPath,
    providerRegistryFilePath,
    logger = console
  } = options

  if (!providerRegistryScriptPath || !providerRegistryFilePath) {
    return {
      success: false,
      results: [],
      error: 'MISSING_REQUIRED_PATHS'
    }
  }

  if (!(await pathExists(providerRegistryScriptPath))) {
    return {
      success: false,
      results: [],
      error: `MCP_SCRIPT_NOT_FOUND: ${providerRegistryScriptPath}`
    }
  }

  const desiredEntry = buildDesiredProviderRegistryEntry(
    providerRegistryScriptPath,
    providerRegistryFilePath
  )

  const results = []
  for (const tool of ['claude', 'codex']) {
    try {
      const result = await ensureForTool(tool, desiredEntry)
      results.push(result)
    } catch (error) {
      // 单工具失败不应阻断应用启动
      const message = error?.message || String(error)
      logger.warn?.(`[builtin-mcp] ensure failed for ${tool}: ${message}`)
      results.push({
        tool,
        status: 'skipped',
        reason: `ENSURE_FAILED: ${message}`
      })
    }
  }

  return {
    success: true,
    results,
    error: null
  }
}

module.exports = {
  BUILTIN_MCP_ID,
  ensureBuiltinProviderRegistryInstalled,
}
