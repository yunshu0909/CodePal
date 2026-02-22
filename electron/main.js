/**
 * Electron 主进程
 *
 * 负责：
 * - 创建和管理应用窗口
 * - 处理 IPC 通信（文件系统操作、配置管理）
 * - 扫描和解析技能目录
 *
 * @module electron/main
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { randomUUID } = require('crypto')
const Store = require('electron-store').default
const os = require('os')
const dotenv = require('dotenv')

// 加载环境变量（从 .env 文件）
const ENV_FILE_PATH = path.resolve(__dirname, '..', '.env')
dotenv.config({ path: ENV_FILE_PATH })

const { scanLogFilesInRange } = require('./logScanner')
const { scanDroidSettingsInRange } = require('./droidLogScanner')
const { handleScanLogFiles } = require('./scanLogFilesHandler')
const { handleAggregateUsageRange } = require('./aggregateUsageRangeHandler')
const { registerSkillHandlers } = require('./handlers/registerSkillHandlers')
const { registerProviderHandlers } = require('./handlers/registerProviderHandlers')
const { registerProjectInitHandlers } = require('./handlers/registerProjectInitHandlers')
const { registerPermissionModeHandlers } = require('./handlers/permissionModeHandlers')
const { registerMcpHandlers } = require('./handlers/registerMcpHandlers')
const { resolveProviderRegistryFilePath } = require('./services/providerRegistryPathService')
const { ensureBuiltinProviderRegistryInstalled } = require('./services/builtinMcpInstallerService')

const PROVIDER_REGISTRY_FILE_PATH = resolveProviderRegistryFilePath()
const PROVIDER_REGISTRY_MCP_SCRIPT_PATH = path.resolve(__dirname, '..', 'mcp', 'provider_registry_mcp.js')

const store = new Store()
const DROID_CONFIG_DIR = path.join(os.homedir(), '.factory')
const DROID_CONFIG_PATH = path.join(DROID_CONFIG_DIR, 'config.json')
const DROID_ALLOWED_PROVIDERS = new Set(['anthropic', 'openai', 'openai-response', 'gemini', 'openrouter'])
const DROID_DUOJIE_TEMPLATE_MODELS = [
  { model_display_name: 'Opus 4.5 Kiro [duojie.games]', model: 'claude-opus-4-5-kiro', provider: 'anthropic', supports_vision: true, max_tokens: 8192 },
  { model_display_name: 'Opus 4.5 [duojie.games]', model: 'claude-opus-4-5-20251101', provider: 'anthropic', supports_vision: true, max_tokens: 8192 },
  { model_display_name: 'Opus 4.5 Max [duojie.games]', model: 'claude-opus-4-5-max', provider: 'anthropic', supports_vision: true, max_tokens: 8192 },
  { model_display_name: 'GLM-4.7 [duojie.games]', model: 'glm-4.7', provider: 'anthropic', supports_vision: true, max_tokens: 8192 },
  { model_display_name: 'GPT 5.2 Codex [duojie.games]', model: 'gpt-5.2-codex', provider: 'openai-response', supports_vision: true, max_tokens: 8192 },
  { model_display_name: 'Claude Haiku 4.5 [duojie.games]', model: 'claude-haiku-4-5', provider: 'anthropic', supports_vision: true, max_tokens: 8192 },
  { model_display_name: 'Sonnet 4.5 [duojie.games]', model: 'claude-sonnet-4-5', provider: 'anthropic', supports_vision: true, max_tokens: 8192 },
  { model_display_name: 'Gemini 3 Flash [duojie.games]', model: 'gemini-3-flash-preview', provider: 'anthropic', supports_vision: true, max_tokens: 8192 },
  { model_display_name: 'Gemini 3 Pro Image [duojie.games]', model: 'gemini-3-pro-image-preview', provider: 'anthropic', supports_vision: true, max_tokens: 8192 },
  { model_display_name: 'Gemini 3 Pro [duojie.games]', model: 'gemini-3-pro-preview', provider: 'anthropic', supports_vision: true, max_tokens: 8192 },
]

// 防止 EPIPE 错误导致崩溃（开发环境管道断开时）
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})

let mainWindow
/**
 * 配置文件写入队列（按文件路径串行）
 * 解决同一文件并发写入时的临时文件冲突与写入顺序不确定问题
 */
const fileWriteQueues = new Map()

/**
 * 按文件路径串行执行写入任务
 * @param {string} filePath - 目标文件路径
 * @param {() => Promise<void>} writeTask - 实际写入任务
 * @returns {Promise<void>}
 */
async function enqueueFileWrite(filePath, writeTask) {
  const previousTask = fileWriteQueues.get(filePath) || Promise.resolve()
  const nextTask = previousTask
    // 让队列继续流动，避免一次失败阻断后续写入
    .catch(() => {})
    .then(() => writeTask())

  fileWriteQueues.set(filePath, nextTask)

  try {
    await nextTask
  } finally {
    // 仅清理当前任务，避免误删新入队任务
    if (fileWriteQueues.get(filePath) === nextTask) {
      fileWriteQueues.delete(filePath)
    }
  }
}

/**
 * 读取 Droid 配置文件
 * @returns {Promise<{exists: boolean, data: {custom_models: Array}, error: string|null}>}
 */
async function readDroidConfigFile() {
  try {
    const content = await fs.readFile(DROID_CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(content)
    return {
      exists: true,
      data: normalizeDroidConfig(parsed),
      error: null,
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false, data: { custom_models: [] }, error: null }
    }
    if (error instanceof SyntaxError) {
      return { exists: true, data: { custom_models: [] }, error: 'CONFIG_PARSE_FAILED' }
    }
    return { exists: false, data: { custom_models: [] }, error: error.message }
  }
}

/**
 * 规范化 Droid config 结构
 * @param {any} raw - 原始配置
 * @returns {{custom_models: Array}}
 */
function normalizeDroidConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { custom_models: [] }
  }
  const models = Array.isArray(raw.custom_models) ? raw.custom_models : []
  return {
    ...raw,
    custom_models: models
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        model_display_name: String(item.model_display_name || '').trim(),
        model: String(item.model || '').trim(),
        base_url: String(item.base_url || '').trim(),
        api_key: String(item.api_key || '').trim(),
        provider: String(item.provider || '').trim(),
        supports_vision: typeof item.supports_vision === 'boolean' ? item.supports_vision : undefined,
        max_tokens: Number.isFinite(Number(item.max_tokens)) ? Math.floor(Number(item.max_tokens)) : undefined,
        supports_prompt_caching: typeof item.supports_prompt_caching === 'boolean'
          ? item.supports_prompt_caching
          : undefined,
      }))
      .filter((item) => item.model_display_name && item.model && item.base_url && item.api_key && item.provider)
  }
}

/**
 * 校验 Droid 模型配置
 * @param {any} model - 模型项
 * @returns {{ok: boolean, error?: string}}
 */
function validateDroidModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return { ok: false, error: '模型项必须是对象' }
  }
  const required = ['model_display_name', 'model', 'base_url', 'api_key', 'provider']
  for (const key of required) {
    const value = String(model[key] || '').trim()
    if (!value) return { ok: false, error: `缺少必填字段: ${key}` }
  }
  let parsedUrl
  try {
    parsedUrl = new URL(String(model.base_url).trim())
  } catch {
    return { ok: false, error: 'base_url 非法，仅支持 http/https' }
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, error: 'base_url 非法，仅支持 http/https' }
  }
  const provider = String(model.provider || '').trim().toLowerCase()
  if (!DROID_ALLOWED_PROVIDERS.has(provider)) {
    return { ok: false, error: `provider 非法: ${provider}` }
  }
  return { ok: true }
}

/**
 * 生成 duojie.games 模板
 * @param {string} apiKey - API key
 * @param {string} baseUrl - Base URL
 * @returns {{custom_models: Array}}
 */
function buildDroidDuojieTemplate(apiKey, baseUrl) {
  const normalizedKey = String(apiKey || '').trim()
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '') || 'https://api.duojie.games'
  return {
    custom_models: DROID_DUOJIE_TEMPLATE_MODELS.map((item) => ({
      ...item,
      base_url: normalizedBaseUrl,
      api_key: normalizedKey,
    }))
  }
}

/**
 * 递归收集目录下的 jsonl 文件
 * @param {string} dirPath - 目录路径
 * @param {Array<{path: string, mtimeMs: number}>} files - 结果容器
 * @param {number} depth - 当前递归深度
 * @returns {Promise<void>}
 */
async function collectJsonlFiles(dirPath, files, depth = 0) {
  if (depth > 6) return
  let entries = []
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, files, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const stat = await fs.stat(fullPath)
      files.push({ path: fullPath, mtimeMs: stat.mtimeMs })
    } catch {
      // ignore
    }
  }
}

/**
 * 读取 Codex 速率限制快照（5h / weekly）
 * 数据来源：~/.codex/sessions/*.jsonl 最新 token_count 事件
 * @returns {Promise<{success: boolean, data?: object, error?: string, errorCode?: string}>}
 */
async function readCodexRateLimitSnapshot() {
  const baseDir = path.join(os.homedir(), '.codex', 'sessions')
  const files = []
  await collectJsonlFiles(baseDir, files)
  if (files.length === 0) {
    return { success: false, errorCode: 'NO_SESSION_FILES', error: '未找到 Codex 会话日志' }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const candidates = files.slice(0, 40)

  for (const file of candidates) {
    let content = ''
    try {
      content = await fs.readFile(file.path, 'utf-8')
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let parsed
      try {
        parsed = JSON.parse(lines[i])
      } catch {
        continue
      }
      const rateLimits = parsed?.payload?.rate_limits
      if (parsed?.type !== 'event_msg' || parsed?.payload?.type !== 'token_count' || !rateLimits) {
        continue
      }

      const primaryUsed = Number(rateLimits?.primary?.used_percent)
      const secondaryUsed = Number(rateLimits?.secondary?.used_percent)
      const primaryRemaining = Number.isFinite(primaryUsed) ? Math.max(0, 100 - primaryUsed) : null
      const secondaryRemaining = Number.isFinite(secondaryUsed) ? Math.max(0, 100 - secondaryUsed) : null
      const usedTokens = Number(parsed?.payload?.info?.total_token_usage?.total_tokens)

      return {
        success: true,
        data: {
          primaryUsedPercent: Number.isFinite(primaryUsed) ? primaryUsed : null,
          weeklyUsedPercent: Number.isFinite(secondaryUsed) ? secondaryUsed : null,
          primaryRemainingPercent: primaryRemaining,
          weeklyRemainingPercent: secondaryRemaining,
          primaryResetsAt: rateLimits?.primary?.resets_at || null,
          weeklyResetsAt: rateLimits?.secondary?.resets_at || null,
          usedTokens: Number.isFinite(usedTokens) ? usedTokens : null,
          sourceFile: file.path,
        },
      }
    }
  }

  return {
    success: false,
    errorCode: 'NO_RATE_LIMIT_EVENT',
    error: '未在近期 Codex 日志中找到 rate_limits 数据',
  }
}

/**
 * 创建主窗口
 * @returns {BrowserWindow} 创建的窗口实例
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 720,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
  })

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(async () => {
  // 启动时自动 ensure 内置 provider_registry，避免用户先手动安装
  try {
    const ensureResult = await ensureBuiltinProviderRegistryInstalled({
      providerRegistryScriptPath: PROVIDER_REGISTRY_MCP_SCRIPT_PATH,
      providerRegistryFilePath: PROVIDER_REGISTRY_FILE_PATH,
      logger: console
    })

    if (!ensureResult.success) {
      console.warn('[builtin-mcp] ensure skipped:', ensureResult.error)
    }
  } catch (error) {
    console.warn('[builtin-mcp] ensure unexpected failure:', error?.message || error)
  }

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

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
 * 解析 SKILL.md 内容提取名称和描述
 * 优先从 YAML frontmatter 提取，如果没有则回退到 Markdown 标题
 * @param {string} content - SKILL.md 文件内容
 * @returns {{name: string, desc: string}} 提取的名称和描述
 */
function parseSkillMd(content) {
  let name = ''
  let desc = ''

  // Try to parse YAML frontmatter first
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1]

    // Extract name from frontmatter
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
    if (nameMatch) {
      name = nameMatch[1].trim()
    }

    // Extract description from frontmatter
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
    if (descMatch) {
      desc = descMatch[1].trim()
    }

    // If both found in frontmatter, return early
    if (name && desc) {
      return { name, desc }
    }
  }

  // Fallback: parse Markdown content
  const lines = content.split('\n')

  // First line starting with # is the name (if not found in frontmatter)
  if (!name) {
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('# ')) {
        name = trimmed.slice(2).trim()
        break
      }
    }
  }

  // First non-empty line after name that doesn't start with # is description (if not found in frontmatter)
  if (!desc) {
    let foundName = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (!foundName) {
        if (trimmed.startsWith('# ')) {
          foundName = true
        }
        continue
      }
      if (trimmed && !trimmed.startsWith('#')) {
        desc = trimmed
        break
      }
    }
  }

  // Fallback to folder name if no name found
  if (!name) {
    name = 'Unnamed Skill'
  }

  return { name, desc }
}

// IPC handlers for data persistence (legacy - for backward compatibility)

/**
 * 获取存储值（兼容旧版本）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} key - 存储键名
 * @returns {any} 存储的值
 */
ipcMain.handle('get-store', (event, key) => {
  return store.get(key)
})

/**
 * 设置存储值（兼容旧版本）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} key - 存储键名
 * @param {any} value - 要存储的值
 * @returns {boolean} 是否成功
 */
ipcMain.handle('set-store', (event, key, value) => {
  store.set(key, value)
  return true
})

/**
 * 删除存储值（兼容旧版本）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} key - 存储键名
 * @returns {boolean} 是否成功
 */
ipcMain.handle('delete-store', (event, key) => {
  store.delete(key)
  return true
})

// IPC handlers for file system operations

/**
 * 扫描工具目录获取技能列表
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} toolPath - 工具目录路径
 * @returns {Promise<{success: boolean, skills: Array, error: string|null}>} 扫描结果
 */
ipcMain.handle('scan-tool-directory', async (event, toolPath) => {
  // IPC 参数类型校验
  if (typeof toolPath !== 'string' || toolPath.length === 0) {
    return { success: false, error: 'INVALID_PATH', skills: [] }
  }

  try {
    const expandedPath = expandHome(toolPath)

    // Check if directory exists
    const exists = await pathExists(expandedPath)
    if (!exists) {
      return { success: true, skills: [], error: 'DIRECTORY_NOT_FOUND' }
    }

    // Check if it's a directory
    const stat = await fs.stat(expandedPath)
    if (!stat.isDirectory()) {
      return { success: false, error: 'NOT_A_DIRECTORY' }
    }

    // Read directory entries
    const entries = await fs.readdir(expandedPath, { withFileTypes: true })
    const skills = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = path.join(expandedPath, entry.name, 'SKILL.md')
        const skillMdExists = await pathExists(skillMdPath)

        if (skillMdExists) {
          try {
            const content = await fs.readFile(skillMdPath, 'utf-8')
            const { name, desc } = parseSkillMd(content)
            skills.push({
              name: entry.name,
              displayName: name || entry.name,
              desc: desc || ''
            })
          } catch (err) {
            // If we can't read SKILL.md, still include the skill with folder name
            skills.push({
              name: entry.name,
              displayName: entry.name,
              desc: ''
            })
          }
        }
      }
    }

    return { success: true, skills, error: null }
  } catch (error) {
    console.error('Error scanning tool directory:', error)
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED', skills: [] }
    }
    return { success: false, error: error.message, skills: [] }
  }
})

/**
 * 读取技能信息（从 SKILL.md）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} skillPath - 技能文件夹路径
 * @returns {Promise<{success: boolean, name: string, desc: string, error: string|null}>} 技能信息
 */
ipcMain.handle('read-skill-info', async (event, skillPath) => {
  try {
    const expandedPath = expandHome(skillPath)
    const skillMdPath = path.join(expandedPath, 'SKILL.md')

    if (!(await pathExists(skillMdPath))) {
      return { success: false, error: 'SKILL_MD_NOT_FOUND' }
    }

    const content = await fs.readFile(skillMdPath, 'utf-8')
    const { name, desc } = parseSkillMd(content)

    return {
      success: true,
      name: name || path.basename(expandedPath),
      desc,
      error: null
    }
  } catch (error) {
    console.error('Error reading skill info:', error)
    return { success: false, error: error.message }
  }
})

/**
 * 复制技能文件夹（用于导入和推送）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} sourcePath - 源路径
 * @param {string} targetPath - 目标路径
 * @param {Object} options - 复制选项
 * @param {boolean} options.force - 是否覆盖已存在的文件
 * @returns {Promise<{success: boolean, error: string|null}>} 复制结果
 */
ipcMain.handle('copy-skill', async (event, sourcePath, targetPath, options = {}) => {
  // IPC 参数类型校验
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    return { success: false, error: 'INVALID_SOURCE_PATH' }
  }
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { success: false, error: 'INVALID_TARGET_PATH' }
  }

  try {
    const expandedSource = expandHome(sourcePath)
    const expandedTarget = expandHome(targetPath)

    // Ensure source exists
    if (!(await pathExists(expandedSource))) {
      return { success: false, error: 'SOURCE_NOT_FOUND' }
    }

    // Ensure target parent directory exists
    const targetParent = path.dirname(expandedTarget)
    await fs.mkdir(targetParent, { recursive: true })

    // Copy with force option (overwrite if exists)
    await fs.cp(expandedSource, expandedTarget, {
      recursive: true,
      force: options.force !== false // default to true
    })

    return { success: true, error: null }
  } catch (error) {
    console.error('Error copying skill:', error)
    if (error.code === 'ENOSPC') {
      return { success: false, error: 'DISK_FULL' }
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED' }
    }
    return { success: false, error: error.message }
  }
})

/**
 * 允许删除操作的目录白名单（用于安全校验）
 * 所有删除操作的目标路径必须位于这些目录之下
 */
const ALLOWED_DELETE_DIRS = [
  '.claude/skills',
  '.codex/skills',
  '.cursor/skills',
  '.trae/skills',
  '.factory/skills',
  'Documents/SkillManager'
]

/**
 * 安全校验：检查路径是否在允许的目录范围内
 * 使用严格前缀匹配，防止路径遍历攻击（如 ~/.claude-malicious/skills/xxx）
 * @param {string} targetPath - 要检查的目标路径（已展开）
 * @returns {boolean} 是否允许操作
 */
function isPathInAllowedDirs(targetPath) {
  const homeDir = os.homedir()
  const normalized = path.normalize(targetPath)

  // 构建完整允许的目录路径并进行前缀匹配
  // 必须以允许目录路径 + 路径分隔符 开头，或者是允许目录本身
  return ALLOWED_DELETE_DIRS.some(dir => {
    const allowedFullPath = path.join(homeDir, dir)
    const normalizedAllowed = path.normalize(allowedFullPath)

    // 精确匹配或者是子目录（必须包含路径分隔符防止部分匹配）
    return normalized === normalizedAllowed ||
           normalized.startsWith(normalizedAllowed + path.sep)
  })
}

/**
 * 删除技能文件夹（用于取消推送）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} skillPath - 要删除的技能路径
 * @returns {Promise<{success: boolean, error: string|null}>} 删除结果
 */
ipcMain.handle('delete-skill', async (event, skillPath) => {
  // IPC 参数类型校验
  if (typeof skillPath !== 'string' || skillPath.length === 0) {
    return { success: false, error: 'INVALID_PATH' }
  }

  try {
    const expandedPath = expandHome(skillPath)

    // Check if path exists
    if (!(await pathExists(expandedPath))) {
      // Already deleted, consider it success
      return { success: true, error: null }
    }

    // 安全校验：检查路径是否在允许的目录范围内
    if (!isPathInAllowedDirs(expandedPath)) {
      console.error('Security: Blocked delete attempt for path:', expandedPath)
      return { success: false, error: 'UNSAFE_PATH' }
    }

    await fs.rm(expandedPath, { recursive: true, force: true })
    return { success: true, error: null }
  } catch (error) {
    console.error('Error deleting skill:', error)
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, error: 'PERMISSION_DENIED' }
    }
    return { success: false, error: error.message }
  }
})

/**
 * 确保目录存在（不存在则创建）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} dirPath - 目录路径
 * @returns {Promise<{success: boolean, error: string|null}>} 操作结果
 */
ipcMain.handle('ensure-dir', async (event, dirPath) => {
  try {
    const expandedPath = expandHome(dirPath)
    await fs.mkdir(expandedPath, { recursive: true })
    return { success: true, error: null }
  } catch (error) {
    console.error('Error ensuring directory:', error)
    return { success: false, error: error.message }
  }
})

/**
 * 检查路径是否存在
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} checkPath - 要检查的路径
 * @returns {Promise<{success: boolean, exists: boolean, error: string|null}>} 检查结果
 */
ipcMain.handle('path-exists', async (event, checkPath) => {
  try {
    const expandedPath = expandHome(checkPath)
    const exists = await pathExists(expandedPath)
    return { success: true, exists, error: null }
  } catch (error) {
    return { success: false, exists: false, error: error.message }
  }
})

/**
 * 备份损坏的配置文件
 * @param {string} configPath - 损坏的配置文件路径
 */
async function backupCorruptedConfig(configPath) {
  try {
    const timestamp = Date.now()
    const backupPath = `${configPath}.corrupted.${timestamp}.bak`
    await fs.rename(configPath, backupPath)
    console.log(`Corrupted config backed up to: ${backupPath}`)
  } catch (err) {
    console.error('Failed to backup corrupted config:', err)
  }
}

/**
 * 原子写入文件：先写入临时文件，再重命名，避免写入中断导致文件损坏
 * @param {string} filePath - 目标文件路径
 * @param {string} data - 要写入的数据
 */
async function atomicWriteFile(filePath, data) {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`
  try {
    // 确保目标目录存在
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(tempPath, data, 'utf-8')
    await fs.rename(tempPath, filePath)
  } catch (error) {
    // 清理临时文件
    try {
      await fs.unlink(tempPath)
    } catch {}
    throw error
  }
}

/**
 * 读取配置文件（.config.json）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} configPath - 配置文件路径
 * @returns {Promise<{success: boolean, data: Object, error: string|null}>} 配置数据
 */
ipcMain.handle('read-config', async (event, configPath) => {
  // IPC 参数类型校验
  if (typeof configPath !== 'string' || configPath.length === 0) {
    return { success: false, error: 'INVALID_PATH', data: null }
  }

  try {
    const expandedPath = expandHome(configPath)

    if (!(await pathExists(expandedPath))) {
      return {
        success: true,
        data: { version: '0.2', pushStatus: {} },
        error: null
      }
    }

    const content = await fs.readFile(expandedPath, 'utf-8')
    const data = JSON.parse(content)

    return { success: true, data, error: null }
  } catch (error) {
    console.error('Error reading config:', error)
    if (error instanceof SyntaxError) {
      // 配置文件损坏，先备份原文件，再返回默认配置
      const expandedPath = expandHome(configPath)
      await backupCorruptedConfig(expandedPath)

      return {
        success: true,
        data: { version: '0.2', pushStatus: {} },
        error: 'CORRUPTED_CONFIG_BACKUP_CREATED'
      }
    }
    return { success: false, error: error.message, data: null }
  }
})

/**
 * 写入配置文件（.config.json）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} configPath - 配置文件路径
 * @param {Object} data - 要写入的配置数据
 * @returns {Promise<{success: boolean, error: string|null}>} 写入结果
 */
ipcMain.handle('write-config', async (event, configPath, data) => {
  // IPC 参数类型校验
  if (typeof configPath !== 'string' || configPath.length === 0) {
    return { success: false, error: 'INVALID_PATH' }
  }
  if (typeof data !== 'object' || data === null) {
    return { success: false, error: 'INVALID_DATA' }
  }

  try {
    const expandedPath = expandHome(configPath)

    // Ensure parent directory exists
    const parentDir = path.dirname(expandedPath)
    await fs.mkdir(parentDir, { recursive: true })

    const content = JSON.stringify(data, null, 2)
    // 使用原子写入避免写入中断导致文件损坏
    await enqueueFileWrite(expandedPath, async () => atomicWriteFile(expandedPath, content))

    return { success: true, error: null }
  } catch (error) {
    console.error('Error writing config:', error)
    return { success: false, error: error.message }
  }
})

// IPC handlers for V0.3 import page

/**
 * 预设工具配置
 * 预设工具：Claude Code、CodeX、Cursor、Trae、Droid
 */
const PRESET_TOOLS = [
  { id: 'claude-code', name: 'Claude Code', icon: 'CC', iconClass: 'cc', path: '~/.claude/skills/' },
  { id: 'codex', name: 'CodeX', icon: 'CX', iconClass: 'cx', path: '~/.codex/skills/' },
  { id: 'cursor', name: 'Cursor', icon: 'CU', iconClass: 'cu', path: '~/.cursor/skills/' },
  { id: 'trae', name: 'Trae', icon: 'TR', iconClass: 'tr', path: '~/.trae/skills/' },
  { id: 'droid', name: 'Droid', icon: 'DR', iconClass: 'dr', path: '~/.factory/skills/' }
]

/**
 * 打开文件夹选择对话框
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @returns {Promise<{success: boolean, path: string, canceled: boolean, error: string|null}>} 选择结果
 */
ipcMain.handle('select-folder', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择文件夹',
      buttonLabel: '选择'
    })

    if (result.canceled) {
      return { success: true, path: null, canceled: true, error: null }
    }

    return { success: true, path: result.filePaths[0], canceled: false, error: null }
  } catch (error) {
    console.error('Error selecting folder:', error)
    return { success: false, path: null, canceled: false, error: error.message }
  }
})

/**
 * 扫描预设工具的 skills
 * 返回每个工具的技能数量和列表
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @returns {Promise<{success: boolean, tools: Array, error: string|null}>} 扫描结果
 */
ipcMain.handle('scan-preset-tools', async (event) => {
  try {
    const tools = []

    for (const tool of PRESET_TOOLS) {
      const expandedPath = expandHome(tool.path)
      const result = {
        id: tool.id,
        name: tool.name,
        icon: tool.icon,
        iconClass: tool.iconClass,
        path: tool.path,
        skills: 0
      }

      // 检查目录是否存在
      const exists = await pathExists(expandedPath)
      if (exists) {
        try {
          const entries = await fs.readdir(expandedPath, { withFileTypes: true })
          let skillCount = 0

          for (const entry of entries) {
            if (entry.isDirectory()) {
              const skillMdPath = path.join(expandedPath, entry.name, 'SKILL.md')
              const skillMdExists = await pathExists(skillMdPath)
              if (skillMdExists) {
                skillCount++
              }
            }
          }

          result.skills = skillCount
        } catch (err) {
          // 静默处理：无法读取目录时视为0个skill
          result.skills = 0
        }
      }

      tools.push(result)
    }

    return { success: true, tools, error: null }
  } catch (error) {
    console.error('Error scanning preset tools:', error)
    return { success: false, tools: [], error: error.message }
  }
})

/**
 * 扫描自定义路径下的 skills 分布
 * 扫描 .claude/skills/、.codex/skills/、.cursor/skills/、.trae/skills/、.factory/skills/ 子目录
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} customPath - 自定义路径
 * @returns {Promise<{success: boolean, skills: Object, error: string|null}>} 扫描结果
 * skills 格式: { claude: 5, codex: 3, ... }
 */
ipcMain.handle('scan-custom-path', async (event, customPath) => {
  try {
    const expandedPath = expandHome(customPath)

    // 检查路径是否存在
    const exists = await pathExists(expandedPath)
    if (!exists) {
      return { success: false, skills: {}, error: 'PATH_NOT_FOUND' }
    }

    // 检查是否为目录
    const stat = await fs.stat(expandedPath)
    if (!stat.isDirectory()) {
      return { success: false, skills: {}, error: 'NOT_A_DIRECTORY' }
    }

    // 扫描各工具子目录（key 必须与 toolDefinitions 中的 id 一致）
    const toolSubdirs = {
      'claude-code': '.claude/skills',
      'codex': '.codex/skills',
      'cursor': '.cursor/skills',
      'trae': '.trae/skills',
      'droid': '.factory/skills'
    }

    const skills = {}

    for (const [toolId, subdir] of Object.entries(toolSubdirs)) {
      const toolPath = path.join(expandedPath, subdir)
      const toolExists = await pathExists(toolPath)

      if (toolExists) {
        try {
          const entries = await fs.readdir(toolPath, { withFileTypes: true })
          let skillCount = 0

          for (const entry of entries) {
            if (entry.isDirectory()) {
              const skillMdPath = path.join(toolPath, entry.name, 'SKILL.md')
              const skillMdExists = await pathExists(skillMdPath)
              if (skillMdExists) {
                skillCount++
              }
            }
          }

          if (skillCount > 0) {
            skills[toolId] = skillCount
          }
        } catch (err) {
          // 静默处理：无法读取时跳过该工具
        }
      }
    }

    return { success: true, skills, error: null }
  } catch (error) {
    console.error('Error scanning custom path:', error)
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, skills: {}, error: 'PERMISSION_DENIED' }
    }
    return { success: false, skills: {}, error: error.message }
  }
})

/**
 * 检查路径是否已存在于自定义路径列表中
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} checkPath - 要检查的路径
 * @param {string[]} existingPaths - 现有路径列表
 * @returns {Promise<{success: boolean, exists: boolean, error: string|null}>} 检查结果
 */
ipcMain.handle('check-path-exists', async (event, checkPath, existingPaths = []) => {
  try {
    const expandedCheckPath = expandHome(checkPath)
    const normalizedCheckPath = path.normalize(expandedCheckPath)

    for (const existingPath of existingPaths) {
      const expandedExistingPath = expandHome(existingPath)
      const normalizedExistingPath = path.normalize(expandedExistingPath)

      if (normalizedCheckPath === normalizedExistingPath) {
        return { success: true, exists: true, error: null }
      }
    }

    return { success: true, exists: false, error: null }
  } catch (error) {
    console.error('Error checking path exists:', error)
    return { success: false, exists: false, error: error.message }
  }
})

/**
 * 更改中央仓库位置
 * 验证新路径是否可写，并迁移现有数据
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} newPath - 新仓库路径
 * @param {string} currentPath - 当前仓库路径（用于数据迁移）
 * @returns {Promise<{success: boolean, path: string, error: string|null}>} 更改结果
 */
ipcMain.handle('change-repo-path', async (event, newPath, currentPath = null) => {
  try {
    const expandedNewPath = expandHome(newPath)

    // 检查新路径是否存在，不存在则创建
    try {
      await fs.mkdir(expandedNewPath, { recursive: true })
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return { success: false, path: null, error: 'PERMISSION_DENIED' }
      }
      throw err
    }

    // 验证目录是否可写（尝试创建一个临时文件）
    const testFile = path.join(expandedNewPath, '.write-test')
    try {
      await fs.writeFile(testFile, '', 'utf-8')
      await fs.unlink(testFile)
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return { success: false, path: null, error: 'PERMISSION_DENIED' }
      }
      return { success: false, path: null, error: 'DIRECTORY_NOT_WRITABLE' }
    }

    // 如果需要迁移数据
    if (currentPath) {
      const expandedCurrentPath = expandHome(currentPath)
      const currentExists = await pathExists(expandedCurrentPath)

      if (currentExists) {
        try {
          // 读取当前仓库的所有 skill 文件夹
          const entries = await fs.readdir(expandedCurrentPath, { withFileTypes: true })

          for (const entry of entries) {
            if (entry.isDirectory()) {
              const skillMdPath = path.join(expandedCurrentPath, entry.name, 'SKILL.md')
              const skillMdExists = await pathExists(skillMdPath)

              if (skillMdExists) {
                const sourcePath = path.join(expandedCurrentPath, entry.name)
                const targetPath = path.join(expandedNewPath, entry.name)

                // 复制 skill 到新位置（覆盖已存在的）
                await fs.cp(sourcePath, targetPath, { recursive: true, force: true })
              }
            }
          }
        } catch (err) {
          console.error('Error migrating data:', err)
          // 迁移失败但不阻止更改路径
        }
      }
    }

    return { success: true, path: newPath, error: null }
  } catch (error) {
    console.error('Error changing repo path:', error)
    return { success: false, path: null, error: error.message }
  }
})

/**
 * 注册技能管理相关 IPC handlers
 */
registerSkillHandlers({
  ipcMain,
  expandHome,
  pathExists,
  parseSkillMd,
  PRESET_TOOLS,
  isPathInAllowedDirs,
})

/**
 * 注册 V0.9 新建项目初始化相关 IPC handlers
 */
registerProjectInitHandlers({
  ipcMain,
  expandHome,
  pathExists,
  templateBaseDir: path.resolve(__dirname, '..', 'templates', 'project-init-v0.9'),
})

// IPC handlers for V0.6 usage monitoring

/**
 * 扫描日志文件
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 扫描参数
 * @param {string} params.basePath - 基础目录路径
 * @param {string} params.pattern - 文件匹配模式
 * @param {string} params.start - 开始时间（ISO 字符串）
 * @param {string} params.end - 结束时间（ISO 字符串）
 * @returns {Promise<{success: boolean, files: Array, totalMatched: number, scannedCount: number, truncated: boolean, error: string|null}>} 扫描结果
 */
ipcMain.handle('scan-log-files', async (event, params) => {
  return handleScanLogFiles(params, {
    expandHomeFn: expandHome,
    pathExistsFn: pathExists,
    scanLogFilesInRangeFn: scanLogFilesInRange
  })
})

/**
 * 扫描 Droid (Kiro/Factory) settings.json 文件
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {{basePath?: string, start?: string, end?: string}} params - 扫描参数
 * @returns {Promise<{success: boolean, files: Array, totalMatched: number, scannedCount: number, truncated: boolean, error: string|null}>}
 */
ipcMain.handle('scan-droid-settings', async (event, params) => {
  try {
    const { basePath, start, end } = params || {}

    if (typeof basePath !== 'string' || !basePath) {
      return { success: false, files: [], totalMatched: 0, scannedCount: 0, truncated: false, error: 'INVALID_PATH' }
    }

    const expandedPath = expandHome(basePath)
    const startTime = new Date(start)
    const endTime = new Date(end)

    const exists = await pathExists(expandedPath)
    if (!exists) {
      return { success: true, files: [], totalMatched: 0, scannedCount: 0, truncated: false, error: null }
    }

    const scanResult = await scanDroidSettingsInRange(expandedPath, startTime, endTime)

    return {
      success: true,
      files: scanResult.files || [],
      totalMatched: scanResult.totalMatched || 0,
      scannedCount: scanResult.scannedCount || 0,
      truncated: Boolean(scanResult.truncated),
      error: null
    }
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, files: [], totalMatched: 0, scannedCount: 0, truncated: false, error: 'PERMISSION_DENIED' }
    }
    return { success: false, files: [], totalMatched: 0, scannedCount: 0, truncated: false, error: error.message }
  }
})

/**
 * 聚合自定义日期范围用量
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {{startDate?: string, endDate?: string, timezone?: string}} params - 聚合参数
 * @returns {Promise<{success: boolean, data?: object, meta?: object, error?: string}>}
 */
ipcMain.handle('aggregate-usage-range', async (event, params) => {
  return handleAggregateUsageRange(params, {
    nowFn: () => new Date(),
    homeDir: os.homedir(),
    scanLogFilesInRangeFn: scanLogFilesInRange
  })
})

/**
 * 读取 Codex 限额快照（5h / weekly）
 * @returns {Promise<{success: boolean, data?: object, error?: string, errorCode?: string}>}
 */
ipcMain.handle('get-codex-rate-limits', async () => {
  try {
    return await readCodexRateLimitSnapshot()
  } catch (error) {
    return {
      success: false,
      errorCode: 'UNKNOWN_ERROR',
      error: `读取 Codex 限额失败: ${error.message}`,
    }
  }
})

/**
 * 读取 Droid 配置（~/.factory/config.json）
 * @returns {Promise<{success: boolean, exists: boolean, config: object, configPath: string, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('get-droid-config', async () => {
  try {
    const result = await readDroidConfigFile()
    if (result.error === 'CONFIG_PARSE_FAILED') {
      return {
        success: false,
        exists: true,
        config: { custom_models: [] },
        configPath: DROID_CONFIG_PATH,
        error: 'Droid config.json JSON 格式错误',
        errorCode: 'CONFIG_PARSE_FAILED',
      }
    }
    if (result.error) {
      return {
        success: false,
        exists: false,
        config: { custom_models: [] },
        configPath: DROID_CONFIG_PATH,
        error: result.error,
        errorCode: 'READ_FAILED',
      }
    }
    return {
      success: true,
      exists: result.exists,
      config: result.data,
      configPath: DROID_CONFIG_PATH,
      error: null,
      errorCode: null,
    }
  } catch (error) {
    return {
      success: false,
      exists: false,
      config: { custom_models: [] },
      configPath: DROID_CONFIG_PATH,
      error: `读取 Droid 配置失败: ${error.message}`,
      errorCode: 'UNKNOWN_ERROR',
    }
  }
})

/**
 * 生成 Droid 示例模板（可编辑）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {{apiKey?: string, baseUrl?: string}} params - 模板参数
 * @returns {Promise<{success: boolean, config?: object, error?: string, errorCode?: string}>}
 */
ipcMain.handle('build-droid-template', async (event, params) => {
  const apiKey = String(params?.apiKey || '').trim()
  const baseUrl = String(params?.baseUrl || '').trim()
  if (!apiKey) {
    return { success: false, errorCode: 'INVALID_API_KEY', error: 'API Key 不能为空' }
  }
  if (!baseUrl) {
    return { success: false, errorCode: 'INVALID_BASE_URL', error: 'Base URL 不能为空' }
  }
  return {
    success: true,
    config: buildDroidDuojieTemplate(apiKey, baseUrl),
    error: null,
    errorCode: null,
  }
})

/**
 * 保存 Droid 配置（~/.factory/config.json）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {object} config - 配置对象
 * @returns {Promise<{success: boolean, configPath: string, error: string|null, errorCode: string|null}>}
 */
ipcMain.handle('save-droid-config', async (event, config) => {
  try {
    const normalized = normalizeDroidConfig(config)
    for (const model of normalized.custom_models) {
      const validation = validateDroidModel(model)
      if (!validation.ok) {
        return {
          success: false,
          configPath: DROID_CONFIG_PATH,
          error: validation.error || '模型配置不合法',
          errorCode: 'INVALID_MODEL_CONFIG',
        }
      }
    }

    await fs.mkdir(DROID_CONFIG_DIR, { recursive: true })
    const text = `${JSON.stringify(normalized, null, 2)}\n`
    await enqueueFileWrite(DROID_CONFIG_PATH, async () => atomicWriteFile(DROID_CONFIG_PATH, text))
    return {
      success: true,
      configPath: DROID_CONFIG_PATH,
      error: null,
      errorCode: null,
    }
  } catch (error) {
    return {
      success: false,
      configPath: DROID_CONFIG_PATH,
      error: `保存 Droid 配置失败: ${error.message}`,
      errorCode: 'WRITE_FAILED',
    }
  }
})

// IPC handler for aggregate usage (kept for compatibility, actual aggregation happens in renderer)
// The aggregation is done in renderer process to avoid bundling issues with ESM modules


/**
 * 注册 Claude 供应商相关 IPC handlers
 */
registerProviderHandlers({
  ipcMain,
  pathExists,
  envFilePath: ENV_FILE_PATH,
  providerRegistryFilePath: PROVIDER_REGISTRY_FILE_PATH,
})

/**
 * 注册权限模式（启动模式）相关 IPC handlers
 */
registerPermissionModeHandlers({
  ipcMain,
  pathExists,
  expandHome,
})

/**
 * 注册 MCP 管理相关 IPC handlers
 */
registerMcpHandlers({
  ipcMain,
})
