/**
 * MCP 管理 IPC 处理器
 *
 * 负责：
 * - 读取 ~/.claude.json、~/.codex/config.toml、~/.cursor/mcp.json、~/.factory/mcp.json 配置文件
 * - 解析 JSON/TOML 格式的 MCP 配置
 * - 写入 MCP 配置（read-modify-write 模式）
 * - 检测配置文件外部修改并自动重载
 *
 * @module electron/handlers/registerMcpHandlers
 */

const path = require('path')
const fs = require('fs/promises')
const os = require('os')
const TOML = require('@iarna/toml')

/**
 * 配置文件路径
 * @type {Object<string, string>}
 */
const CONFIG_PATHS = {
  claude: '~/.claude.json',
  codex: '~/.codex/config.toml',
  cursor: '~/.cursor/mcp.json',
  droidMcp: '~/.factory/mcp.json',
  droidConfig: '~/.factory/config.json'
}

const CONFIG_ERROR_MESSAGES = {
  TOOLS_NOT_INSTALLED: '未找到 Claude Code、Codex、Cursor 或 Droid 的配置文件',
  CONFIG_PARSE_FAILED: '配置文件解析失败'
}

const WRITE_ERROR_MAP = {
  EACCES: { errorCode: 'PERMISSION_DENIED', error: '权限不足' },
  EPERM: { errorCode: 'PERMISSION_DENIED', error: '权限不足' },
  ENOSPC: { errorCode: 'DISK_FULL', error: '磁盘空间不足' },
  EBUSY: { errorCode: 'FILE_LOCKED', error: '文件被锁定' },
  EAGAIN: { errorCode: 'FILE_LOCKED', error: '文件被锁定' }
}

/**
 * 将路径中的 ~ 展开为用户主目录
 * @param {string} filepath - 原始路径
 * @returns {string} 展开后的绝对路径
 */
function expandHome(filepath) {
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2))
  }
  return filepath
}

/**
 * 检查路径是否存在
 * @param {string} filepath - 要检查的路径
 * @returns {Promise<boolean>} 是否存在
 */
async function pathExists(filepath) {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

/**
 * 检查工具是否安装（通过配置文件是否存在）
 * @returns {Promise<{claude: boolean, codex: boolean, cursor: boolean, droid: boolean}>}
 */
async function checkToolsInstalled() {
  const claudePath = expandHome(CONFIG_PATHS.claude)
  const codexPath = expandHome(CONFIG_PATHS.codex)
  const cursorPath = expandHome(CONFIG_PATHS.cursor)
  const droidMcpPath = expandHome(CONFIG_PATHS.droidMcp)
  const droidConfigPath = expandHome(CONFIG_PATHS.droidConfig)

  const [claudeExists, codexExists, cursorExists, droidMcpExists, droidConfigExists] = await Promise.all([
    pathExists(claudePath),
    pathExists(codexPath),
    pathExists(cursorPath),
    pathExists(droidMcpPath),
    pathExists(droidConfigPath)
  ])

  return {
    claude: claudeExists,
    codex: codexExists,
    cursor: cursorExists,
    droid: droidMcpExists || droidConfigExists
  }
}

/**
 * 获取文件版本（mtimeMs）
 * @param {string} filePath - 文件路径
 * @returns {Promise<number|null>} 文件版本；文件不存在时返回 null
 */
async function getFileVersion(filePath) {
  try {
    const stat = await fs.stat(filePath)
    return stat.mtimeMs
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * 原子写入配置文件：先写临时文件再 rename
 * @param {string} configPath - 目标配置文件路径
 * @param {string} content - 配置文件内容
 */
async function atomicWriteConfig(configPath, content) {
  const parentDir = path.dirname(configPath)
  const tempPath = `${configPath}.tmp.${process.pid}.${Date.now()}`

  try {
    await fs.mkdir(parentDir, { recursive: true })
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
 * 统一构造写入错误结果
 * @param {Error} error - 原始错误
 * @returns {{success: false, error: string, errorCode: string}}
 */
function buildWriteErrorResult(error) {
  const mapped = WRITE_ERROR_MAP[error.code]
  if (mapped) {
    return {
      success: false,
      error: mapped.error,
      errorCode: mapped.errorCode
    }
  }

  return {
    success: false,
    error: error.message || '写入失败',
    errorCode: 'WRITE_FAILED'
  }
}

/**
 * 读取 Claude Code 配置文件（JSON 格式）
 * @returns {Promise<{success: boolean, data: Object|null, version: number|null, filePath: string, error: string|null, errorCode: string|null}>}
 */
async function readClaudeConfig() {
  const configPath = expandHome(CONFIG_PATHS.claude)

  try {
    if (!(await pathExists(configPath))) {
      return {
        success: true,
        data: { mcpServers: {} },
        version: null,
        filePath: configPath,
        error: null,
        errorCode: null
      }
    }

    const version = await getFileVersion(configPath)
    const content = await fs.readFile(configPath, 'utf-8')
    const data = JSON.parse(content)

    return {
      success: true,
      data,
      version,
      filePath: configPath,
      error: null,
      errorCode: null
    }
  } catch (error) {
    console.error('Error reading Claude config:', error)
    if (error instanceof SyntaxError) {
      return {
        success: false,
        data: null,
        version: null,
        filePath: configPath,
        error: `Claude Code 配置文件解析失败: ${error.message}`,
        errorCode: 'INVALID_JSON_FORMAT'
      }
    }

    return {
      success: false,
      data: null,
      version: null,
      filePath: configPath,
      error: error.message,
      errorCode: 'READ_FAILED'
    }
  }
}

/**
 * 写入 Claude Code 配置文件（JSON 格式）
 * @param {Object} data - 配置数据
 * @returns {Promise<{success: boolean, error: string|null, errorCode: string|null}>}
 */
async function writeClaudeConfig(data) {
  const configPath = expandHome(CONFIG_PATHS.claude)

  try {
    await atomicWriteConfig(configPath, JSON.stringify(data, null, 2))
    return { success: true, error: null, errorCode: null }
  } catch (error) {
    console.error('Error writing Claude config:', error)
    return buildWriteErrorResult(error)
  }
}

/**
 * 读取 Codex 配置文件（TOML 格式）
 * @returns {Promise<{success: boolean, data: Object|null, version: number|null, filePath: string, error: string|null, errorCode: string|null}>}
 */
async function readCodexConfig() {
  const configPath = expandHome(CONFIG_PATHS.codex)

  try {
    if (!(await pathExists(configPath))) {
      return {
        success: true,
        data: { mcp_servers: {} },
        version: null,
        filePath: configPath,
        error: null,
        errorCode: null
      }
    }

    const version = await getFileVersion(configPath)
    const content = await fs.readFile(configPath, 'utf-8')
    const data = TOML.parse(content)

    return {
      success: true,
      data,
      version,
      filePath: configPath,
      error: null,
      errorCode: null
    }
  } catch (error) {
    console.error('Error reading Codex config:', error)
    return {
      success: false,
      data: null,
      version: null,
      filePath: configPath,
      error: `Codex 配置文件解析失败: ${error.message}`,
      errorCode: error.name === 'ParserError' ? 'INVALID_TOML_FORMAT' : 'READ_FAILED'
    }
  }
}

/**
 * 写入 Codex 配置文件（TOML 格式）
 * @param {Object} data - 配置数据
 * @returns {Promise<{success: boolean, error: string|null, errorCode: string|null}>}
 */
async function writeCodexConfig(data) {
  const configPath = expandHome(CONFIG_PATHS.codex)

  try {
    await atomicWriteConfig(configPath, TOML.stringify(data))
    return { success: true, error: null, errorCode: null }
  } catch (error) {
    console.error('Error writing Codex config:', error)
    return buildWriteErrorResult(error)
  }
}

/**
 * 读取 Cursor 配置文件（JSON 格式）
 * @returns {Promise<{success: boolean, data: Object|null, version: number|null, filePath: string, error: string|null, errorCode: string|null}>}
 */
async function readCursorConfig() {
  const configPath = expandHome(CONFIG_PATHS.cursor)

  try {
    if (!(await pathExists(configPath))) {
      return {
        success: true,
        data: { mcpServers: {} },
        version: null,
        filePath: configPath,
        error: null,
        errorCode: null
      }
    }

    const version = await getFileVersion(configPath)
    const content = await fs.readFile(configPath, 'utf-8')
    const data = JSON.parse(content)

    return {
      success: true,
      data,
      version,
      filePath: configPath,
      error: null,
      errorCode: null
    }
  } catch (error) {
    console.error('Error reading Cursor config:', error)
    if (error instanceof SyntaxError) {
      return {
        success: false,
        data: null,
        version: null,
        filePath: configPath,
        error: `Cursor 配置文件解析失败: ${error.message}`,
        errorCode: 'INVALID_JSON_FORMAT'
      }
    }

    return {
      success: false,
      data: null,
      version: null,
      filePath: configPath,
      error: error.message,
      errorCode: 'READ_FAILED'
    }
  }
}

/**
 * 写入 Cursor 配置文件（JSON 格式）
 * @param {Object} data - 配置数据
 * @returns {Promise<{success: boolean, error: string|null, errorCode: string|null}>}
 */
async function writeCursorConfig(data) {
  const configPath = expandHome(CONFIG_PATHS.cursor)

  try {
    await atomicWriteConfig(configPath, JSON.stringify(data, null, 2))
    return { success: true, error: null, errorCode: null }
  } catch (error) {
    console.error('Error writing Cursor config:', error)
    return buildWriteErrorResult(error)
  }
}

/**
 * 读取 Droid 配置文件（JSON 格式）
 * 优先使用 ~/.factory/mcp.json；若不存在则回退 ~/.factory/config.json
 * @returns {Promise<{success: boolean, data: Object|null, version: number|null, filePath: string, error: string|null, errorCode: string|null}>}
 */
async function readDroidConfig() {
  const mcpPath = expandHome(CONFIG_PATHS.droidMcp)
  const configPath = expandHome(CONFIG_PATHS.droidConfig)

  try {
    const usePath = (await pathExists(mcpPath))
      ? mcpPath
      : ((await pathExists(configPath)) ? configPath : mcpPath)

    if (!(await pathExists(usePath))) {
      return {
        success: true,
        data: { mcpServers: {} },
        version: null,
        filePath: usePath,
        error: null,
        errorCode: null
      }
    }

    const version = await getFileVersion(usePath)
    const content = await fs.readFile(usePath, 'utf-8')
    const data = JSON.parse(content)

    return {
      success: true,
      data,
      version,
      filePath: usePath,
      error: null,
      errorCode: null
    }
  } catch (error) {
    console.error('Error reading Droid config:', error)
    if (error instanceof SyntaxError) {
      return {
        success: false,
        data: null,
        version: null,
        filePath: mcpPath,
        error: `Droid 配置文件解析失败: ${error.message}`,
        errorCode: 'INVALID_JSON_FORMAT'
      }
    }

    return {
      success: false,
      data: null,
      version: null,
      filePath: mcpPath,
      error: error.message,
      errorCode: 'READ_FAILED'
    }
  }
}

/**
 * 写入 Droid 配置文件（JSON 格式）
 * @param {Object} data - 配置数据
 * @param {string} filePath - 配置路径
 * @returns {Promise<{success: boolean, error: string|null, errorCode: string|null}>}
 */
async function writeDroidConfig(data, filePath) {
  try {
    await atomicWriteConfig(filePath, JSON.stringify(data, null, 2))
    return { success: true, error: null, errorCode: null }
  } catch (error) {
    console.error('Error writing Droid config:', error)
    return buildWriteErrorResult(error)
  }
}

/**
 * 从 Claude Code 配置中提取 MCP 列表
 * @param {Object} config - Claude Code 配置
 * @returns {Object} MCP 映射表 { mcpName: mcpConfig }
 */
function extractClaudeMcpServers(config) {
  if (!config || !config.mcpServers) {
    return {}
  }
  return config.mcpServers
}

/**
 * 从 Codex 配置中提取 MCP 列表
 * @param {Object} config - Codex 配置
 * @returns {Object} MCP 映射表 { mcpName: mcpConfig }
 */
function extractCodexMcpServers(config) {
  if (!config || !config.mcp_servers) {
    return {}
  }
  return config.mcp_servers
}

/**
 * 从 Cursor 配置中提取 MCP 列表
 * @param {Object} config - Cursor 配置
 * @returns {Object} MCP 映射表 { mcpName: mcpConfig }
 */
function extractCursorMcpServers(config) {
  if (!config || !config.mcpServers) {
    return {}
  }
  return config.mcpServers
}

/**
 * 从 Droid 配置中提取 MCP 列表
 * 支持 mcpServers / mcp_servers 两种键
 * @param {Object} config - Droid 配置
 * @returns {Object} MCP 映射表 { mcpName: mcpConfig }
 */
function extractDroidMcpServers(config) {
  if (!config || typeof config !== 'object') {
    return {}
  }
  if (config.mcpServers && typeof config.mcpServers === 'object') {
    return config.mcpServers
  }
  if (config.mcp_servers && typeof config.mcp_servers === 'object') {
    return config.mcp_servers
  }
  return {}
}

/**
 * 转换 MCP 配置为统一格式
 * @param {string} name - MCP 名称
 * @param {Object} config - 原始配置
 * @param {string} source - 来源工具（claude/codex/cursor/droid）
 * @returns {Object} 统一格式的 MCP 配置
 */
function normalizeMcpConfig(name, config, source) {
  const normalized = {
    id: name,
    name,
    type: 'stdio',
    command: '',
    url: '',
    env: {},
      installedIn: {
        claude: false,
        codex: false,
        cursor: false,
        droid: false
      }
  }

  // 两边字段形状接近，但后续若出现差异可在 source 分支中扩展
  if (source === 'claude' || source === 'codex' || source === 'cursor' || source === 'droid') {
    if (config.url) {
      normalized.type = 'http'
      normalized.url = config.url
    } else if (config.command) {
      normalized.type = 'stdio'
      normalized.command = config.command
      if (config.args && Array.isArray(config.args)) {
        normalized.command += ` ${config.args.join(' ')}`
      }
    }

    if (config.env) {
      normalized.env = config.env
    }
  }

  return normalized
}

/**
 * 合并两个工具的 MCP 配置
 * @param {Object} claudeMcps - Claude Code 的 MCP 配置
 * @param {Object} codexMcps - Codex 的 MCP 配置
 * @param {Object} cursorMcps - Cursor 的 MCP 配置
 * @param {Object} droidMcps - Droid 的 MCP 配置
 * @returns {Array} 合并后的 MCP 列表
 */
function mergeMcpConfigs(claudeMcps, codexMcps, cursorMcps, droidMcps) {
  const mcpMap = new Map()

  for (const [name, config] of Object.entries(claudeMcps)) {
    const normalized = normalizeMcpConfig(name, config, 'claude')
    normalized.installedIn.claude = true
    mcpMap.set(name, normalized)
  }

  for (const [name, config] of Object.entries(codexMcps)) {
    if (mcpMap.has(name)) {
      mcpMap.get(name).installedIn.codex = true
    } else {
      const normalized = normalizeMcpConfig(name, config, 'codex')
      normalized.installedIn.codex = true
      mcpMap.set(name, normalized)
    }
  }

  for (const [name, config] of Object.entries(cursorMcps)) {
    if (mcpMap.has(name)) {
      mcpMap.get(name).installedIn.cursor = true
    } else {
      const normalized = normalizeMcpConfig(name, config, 'cursor')
      normalized.installedIn.cursor = true
      mcpMap.set(name, normalized)
    }
  }

  for (const [name, config] of Object.entries(droidMcps)) {
    if (mcpMap.has(name)) {
      mcpMap.get(name).installedIn.droid = true
    } else {
      const normalized = normalizeMcpConfig(name, config, 'droid')
      normalized.installedIn.droid = true
      mcpMap.set(name, normalized)
    }
  }

  // PRD 要求按 MCP 名称升序展示
  return Array.from(mcpMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
}

/**
 * 转换 MCP 配置格式（Claude/Codex/Cursor）
 * @param {Object} config - 原始配置
 * @param {string} targetTool - 目标工具（claude/codex/cursor）
 * @returns {Object} 转换后的配置
 */
function convertMcpConfig(config, targetTool) {
  const converted = {}

  if (config.command) {
    converted.command = config.command
  }
  if (config.args && Array.isArray(config.args)) {
    converted.args = config.args
  }
  if (config.url) {
    converted.url = config.url
  }
  if (config.env && typeof config.env === 'object') {
    converted.env = config.env
  }

  return converted
}

/**
 * 判断是否为占位 MCP 配置（无可用实际命令）
 * @param {Object|null|undefined} config - MCP 配置
 * @returns {boolean}
 */
function isPlaceholderMcpConfig(config) {
  if (!config || typeof config !== 'object') {
    return true
  }

  const command = typeof config.command === 'string' ? config.command.trim() : ''
  const args = Array.isArray(config.args) ? config.args : []
  const hasUrl = typeof config.url === 'string' && config.url.trim().length > 0

  if (hasUrl) {
    return false
  }

  if (!command) {
    return true
  }

  // 历史占位写法：echo not configured
  if (command === 'echo' && args.length === 1 && String(args[0]).trim() === 'not configured') {
    return true
  }

  return false
}

/**
 * 将 MCP 写入 Claude 配置对象
 * @param {Object} config - Claude 配置对象
 * @param {string} mcpId - MCP 名称
 * @param {boolean} enable - 是否启用
 * @param {Object|null} sourceConfig - 来源配置（用于跨工具复制）
 */
function applyClaudeToggle(config, mcpId, enable, sourceConfig) {
  if (!config.mcpServers) {
    config.mcpServers = {}
  }

  if (enable) {
    config.mcpServers[mcpId] = convertMcpConfig(sourceConfig, 'claude')
    return
  }

  delete config.mcpServers[mcpId]
}

/**
 * 将 MCP 写入 Codex 配置对象
 * @param {Object} config - Codex 配置对象
 * @param {string} mcpId - MCP 名称
 * @param {boolean} enable - 是否启用
 * @param {Object|null} sourceConfig - 来源配置（用于跨工具复制）
 */
function applyCodexToggle(config, mcpId, enable, sourceConfig) {
  if (!config.mcp_servers) {
    config.mcp_servers = {}
  }

  if (enable) {
    config.mcp_servers[mcpId] = convertMcpConfig(sourceConfig, 'codex')
    return
  }

  delete config.mcp_servers[mcpId]
}

/**
 * 将 MCP 写入 Cursor 配置对象
 * @param {Object} config - Cursor 配置对象
 * @param {string} mcpId - MCP 名称
 * @param {boolean} enable - 是否启用
 * @param {Object|null} sourceConfig - 来源配置（用于跨工具复制）
 */
function applyCursorToggle(config, mcpId, enable, sourceConfig) {
  if (!config.mcpServers) {
    config.mcpServers = {}
  }

  if (enable) {
    config.mcpServers[mcpId] = convertMcpConfig(sourceConfig, 'cursor')
    return
  }

  delete config.mcpServers[mcpId]
}

/**
 * 将 MCP 写入 Droid 配置对象
 * 优先保持原键风格（mcpServers / mcp_servers）
 * @param {Object} config - Droid 配置对象
 * @param {string} mcpId - MCP 名称
 * @param {boolean} enable - 是否启用
 * @param {Object|null} sourceConfig - 来源配置（用于跨工具复制）
 */
function applyDroidToggle(config, mcpId, enable, sourceConfig) {
  const key = (config && typeof config === 'object' && config.mcp_servers && !config.mcpServers)
    ? 'mcp_servers'
    : 'mcpServers'

  if (!config[key]) {
    config[key] = {}
  }

  if (enable) {
    config[key][mcpId] = convertMcpConfig(sourceConfig, 'droid')
    return
  }

  delete config[key][mcpId]
}

/**
 * 按候选工具顺序查找可复制的来源 MCP 配置
 * @param {string} mcpId - MCP 名称
 * @param {string[]} candidates - 候选工具
 * @returns {Promise<Object|null>}
 */
async function pickSourceConfig(mcpId, candidates) {
  for (const candidate of candidates) {
    if (candidate === 'claude') {
      const result = await readClaudeConfig()
      if (!result.success) continue
      const config = extractClaudeMcpServers(result.data || {})[mcpId] || null
      if (!isPlaceholderMcpConfig(config)) {
        return config
      }
      continue
    }

    if (candidate === 'codex') {
      const result = await readCodexConfig()
      if (!result.success) continue
      const config = extractCodexMcpServers(result.data || {})[mcpId] || null
      if (!isPlaceholderMcpConfig(config)) {
        return config
      }
      continue
    }

    if (candidate === 'cursor') {
      const result = await readCursorConfig()
      if (!result.success) continue
      const config = extractCursorMcpServers(result.data || {})[mcpId] || null
      if (!isPlaceholderMcpConfig(config)) {
        return config
      }
      continue
    }

    if (candidate === 'droid') {
      const result = await readDroidConfig()
      if (!result.success) continue
      const config = extractDroidMcpServers(result.data || {})[mcpId] || null
      if (!isPlaceholderMcpConfig(config)) {
        return config
      }
    }
  }

  return null
}

/**
 * 注册 MCP 相关的 IPC handlers
 * @param {Object} params - 参数对象
 * @param {Electron.IpcMain} params.ipcMain - Electron IPC main 实例
 */
function registerMcpHandlers({ ipcMain }) {
  /**
   * 扫描工具配置文件，返回 MCP 列表和工具安装状态
   * @returns {Promise<{success: boolean, mcpList: Array, toolsInstalled: Object, warnings?: string[], error: string|null, errorCode: string|null}>}
   */
  ipcMain.handle('mcp:scanConfigs', async () => {
    try {
      const detectedTools = await checkToolsInstalled()

      if (!detectedTools.claude && !detectedTools.codex && !detectedTools.cursor && !detectedTools.droid) {
        return {
          success: false,
          mcpList: [],
          toolsInstalled: detectedTools,
          error: CONFIG_ERROR_MESSAGES.TOOLS_NOT_INSTALLED,
          errorCode: 'TOOLS_NOT_INSTALLED'
        }
      }

      const [claudeResult, codexResult, cursorResult, droidResult] = await Promise.all([
        detectedTools.claude ? readClaudeConfig() : { success: true, data: { mcpServers: {} }, error: null },
        detectedTools.codex ? readCodexConfig() : { success: true, data: { mcp_servers: {} }, error: null },
        detectedTools.cursor ? readCursorConfig() : { success: true, data: { mcpServers: {} }, error: null },
        detectedTools.droid ? readDroidConfig() : { success: true, data: { mcpServers: {} }, error: null }
      ])

      const loadableTools = {
        claude: detectedTools.claude && claudeResult.success,
        codex: detectedTools.codex && codexResult.success,
        cursor: detectedTools.cursor && cursorResult.success,
        droid: detectedTools.droid && droidResult.success
      }

      const warnings = []
      if (detectedTools.claude && !claudeResult.success) {
        warnings.push(claudeResult.error || 'Claude Code 配置读取失败')
      }
      if (detectedTools.codex && !codexResult.success) {
        warnings.push(codexResult.error || 'Codex 配置读取失败')
      }
      if (detectedTools.cursor && !cursorResult.success) {
        warnings.push(cursorResult.error || 'Cursor 配置读取失败')
      }
      if (detectedTools.droid && !droidResult.success) {
        warnings.push(droidResult.error || 'Droid 配置读取失败')
      }

      if (!loadableTools.claude && !loadableTools.codex && !loadableTools.cursor && !loadableTools.droid) {
        return {
          success: false,
          mcpList: [],
          toolsInstalled: loadableTools,
          error: `${CONFIG_ERROR_MESSAGES.CONFIG_PARSE_FAILED}：${warnings.join('；')}`,
          errorCode: 'CONFIG_PARSE_FAILED'
        }
      }

      const claudeMcps = loadableTools.claude
        ? extractClaudeMcpServers(claudeResult.data)
        : {}
      const codexMcps = loadableTools.codex
        ? extractCodexMcpServers(codexResult.data)
        : {}
      const cursorMcps = loadableTools.cursor
        ? extractCursorMcpServers(cursorResult.data)
        : {}
      const droidMcps = loadableTools.droid
        ? extractDroidMcpServers(droidResult.data)
        : {}

      return {
        success: true,
        mcpList: mergeMcpConfigs(claudeMcps, codexMcps, cursorMcps, droidMcps),
        toolsInstalled: loadableTools,
        warnings,
        error: null,
        errorCode: null
      }
    } catch (error) {
      console.error('Error scanning MCP configs:', error)
      return {
        success: false,
        mcpList: [],
        toolsInstalled: { claude: false, codex: false, cursor: false, droid: false },
        error: error.message,
        errorCode: 'SCAN_FAILED'
      }
    }
  })

  /**
   * 启用/停用指定 MCP 到指定工具
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {string} mcpId - MCP 标识符（名称）
   * @param {string} tool - 目标工具（claude/codex/cursor/droid）
   * @param {boolean} enable - 是否启用
   * @returns {Promise<{success: boolean, error: string|null, errorCode: string|null, warningCode?: string|null, warning?: string|null}>}
   */
  ipcMain.handle('mcp:toggleMcp', async (event, mcpId, tool, enable) => {
    try {
      if (!['claude', 'codex', 'cursor', 'droid'].includes(tool)) {
        return { success: false, error: '无效工具类型', errorCode: 'INVALID_TOOL' }
      }

      if (tool === 'claude') {
        const readResult = await readClaudeConfig()
        if (!readResult.success) {
          return { success: false, error: readResult.error, errorCode: readResult.errorCode }
        }

        let sourceConfig = null
        if (enable) {
          sourceConfig = await pickSourceConfig(mcpId, ['codex', 'cursor', 'droid'])
          if (!sourceConfig) {
            return {
              success: false,
              error: '未找到可复制的 MCP 配置，请先在另一工具中完成有效配置',
              errorCode: 'SOURCE_CONFIG_NOT_FOUND'
            }
          }
        }

        applyClaudeToggle(readResult.data, mcpId, enable, sourceConfig)

        let warningCode = null
        const latestVersion = await getFileVersion(readResult.filePath)
        if (latestVersion !== readResult.version) {
          // 为什么重读：避免覆盖用户在外部刚修改的配置
          const reloadedResult = await readClaudeConfig()
          if (!reloadedResult.success) {
            return { success: false, error: reloadedResult.error, errorCode: reloadedResult.errorCode }
          }
          applyClaudeToggle(reloadedResult.data, mcpId, enable, sourceConfig)
          readResult.data = reloadedResult.data
          warningCode = 'CONFIG_RELOADED'
        }

        const writeResult = await writeClaudeConfig(readResult.data)
        if (!writeResult.success) {
          return writeResult
        }

        return {
          success: true,
          error: null,
          errorCode: null,
          warningCode,
          warning: warningCode ? '配置已重新加载' : null
        }
      }

      if (tool === 'codex') {
        const readResult = await readCodexConfig()
        if (!readResult.success) {
          return { success: false, error: readResult.error, errorCode: readResult.errorCode }
        }

        let sourceConfig = null
        if (enable) {
          sourceConfig = await pickSourceConfig(mcpId, ['claude', 'cursor', 'droid'])
          if (!sourceConfig) {
            return {
              success: false,
              error: '未找到可复制的 MCP 配置，请先在另一工具中完成有效配置',
              errorCode: 'SOURCE_CONFIG_NOT_FOUND'
            }
          }
        }

        applyCodexToggle(readResult.data, mcpId, enable, sourceConfig)

        let warningCode = null
        const latestVersion = await getFileVersion(readResult.filePath)
        if (latestVersion !== readResult.version) {
          const reloadedResult = await readCodexConfig()
          if (!reloadedResult.success) {
            return { success: false, error: reloadedResult.error, errorCode: reloadedResult.errorCode }
          }
          applyCodexToggle(reloadedResult.data, mcpId, enable, sourceConfig)
          readResult.data = reloadedResult.data
          warningCode = 'CONFIG_RELOADED'
        }

        const writeResult = await writeCodexConfig(readResult.data)
        if (!writeResult.success) {
          return writeResult
        }

        return {
          success: true,
          error: null,
          errorCode: null,
          warningCode,
          warning: warningCode ? '配置已重新加载' : null
        }
      }

      if (tool === 'droid') {
        const readResult = await readDroidConfig()
        if (!readResult.success) {
          return { success: false, error: readResult.error, errorCode: readResult.errorCode }
        }

        let sourceConfig = null
        if (enable) {
          sourceConfig = await pickSourceConfig(mcpId, ['claude', 'codex', 'cursor'])
          if (!sourceConfig) {
            return {
              success: false,
              error: '未找到可复制的 MCP 配置，请先在另一工具中完成有效配置',
              errorCode: 'SOURCE_CONFIG_NOT_FOUND'
            }
          }
        }

        applyDroidToggle(readResult.data, mcpId, enable, sourceConfig)

        let warningCode = null
        const latestVersion = await getFileVersion(readResult.filePath)
        if (latestVersion !== readResult.version) {
          const reloadedResult = await readDroidConfig()
          if (!reloadedResult.success) {
            return { success: false, error: reloadedResult.error, errorCode: reloadedResult.errorCode }
          }
          applyDroidToggle(reloadedResult.data, mcpId, enable, sourceConfig)
          readResult.data = reloadedResult.data
          readResult.filePath = reloadedResult.filePath
          warningCode = 'CONFIG_RELOADED'
        }

        const writeResult = await writeDroidConfig(readResult.data, readResult.filePath)
        if (!writeResult.success) {
          return writeResult
        }

        return {
          success: true,
          error: null,
          errorCode: null,
          warningCode,
          warning: warningCode ? '配置已重新加载' : null
        }
      }

      const readResult = await readCursorConfig()
      if (!readResult.success) {
        return { success: false, error: readResult.error, errorCode: readResult.errorCode }
      }

      let sourceConfig = null
      if (enable) {
        sourceConfig = await pickSourceConfig(mcpId, ['claude', 'codex', 'droid'])
        if (!sourceConfig) {
          return {
            success: false,
            error: '未找到可复制的 MCP 配置，请先在另一工具中完成有效配置',
            errorCode: 'SOURCE_CONFIG_NOT_FOUND'
          }
        }
      }

      applyCursorToggle(readResult.data, mcpId, enable, sourceConfig)

      let warningCode = null
      const latestVersion = await getFileVersion(readResult.filePath)
      if (latestVersion !== readResult.version) {
        const reloadedResult = await readCursorConfig()
        if (!reloadedResult.success) {
          return { success: false, error: reloadedResult.error, errorCode: reloadedResult.errorCode }
        }
        applyCursorToggle(reloadedResult.data, mcpId, enable, sourceConfig)
        readResult.data = reloadedResult.data
        warningCode = 'CONFIG_RELOADED'
      }

      const writeResult = await writeCursorConfig(readResult.data)
      if (!writeResult.success) {
        return writeResult
      }

      return {
        success: true,
        error: null,
        errorCode: null,
        warningCode,
        warning: warningCode ? '配置已重新加载' : null
      }
    } catch (error) {
      console.error('Error toggling MCP:', error)
      return { success: false, error: error.message, errorCode: 'TOGGLE_FAILED' }
    }
  })

  /**
   * 检查 Claude Code、Codex、Cursor 和 Droid 是否安装
   * @returns {Promise<{success: boolean, toolsInstalled: Object, error: string|null}>}
   */
  ipcMain.handle('mcp:checkToolsInstalled', async () => {
    try {
      const toolsInstalled = await checkToolsInstalled()
      return { success: true, toolsInstalled, error: null }
    } catch (error) {
      console.error('Error checking tools installed:', error)
      return { success: false, toolsInstalled: { claude: false, codex: false, cursor: false, droid: false }, error: error.message }
    }
  })
}

module.exports = { registerMcpHandlers }
