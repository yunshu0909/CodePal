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

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { randomUUID } = require('crypto')
const Store = require('electron-store').default
const os = require('os')
const dotenv = require('dotenv')

// 加载环境变量（从 .env 文件）
const ENV_FILE_PATH = path.resolve(__dirname, '..', '.env')
dotenv.config({ path: ENV_FILE_PATH })

const { scanSkillDirectory, parseSkillMd } = require('./services/skillScanService')
const { registerSkillHandlers } = require('./handlers/registerSkillHandlers')
const { registerImportPageHandlers } = require('./handlers/registerImportPageHandlers')
const { registerAppUpdateHandlers } = require('./handlers/registerAppUpdateHandlers')
const { registerUsageAggregationHandlers } = require('./handlers/registerUsageAggregationHandlers')
const { registerProviderHandlers } = require('./handlers/registerProviderHandlers')
const { registerProjectInitHandlers } = require('./handlers/registerProjectInitHandlers')
const { registerPermissionModeHandlers } = require('./handlers/permissionModeHandlers')
const { registerModelConfigHandlers } = require('./handlers/modelConfigHandlers')
const { registerModelRegistryHandlers } = require('./handlers/registerModelRegistryHandlers')
const { registerPricingRegistryHandlers } = require('./handlers/registerPricingRegistryHandlers')
const {
  initRemoteConfig,
  refreshRemoteConfigInBackground,
} = require('./services/remoteConfigLoader')
const { modelRegistrySpec } = require('./services/registries/modelRegistry')
const { pricingRegistrySpec } = require('./services/registries/pricingRegistry')
const { registerClaudeUsageStatusHandlers } = require('./handlers/registerClaudeUsageStatusHandlers')
const { registerMcpHandlers } = require('./handlers/registerMcpHandlers')
const { registerNetworkDiagnosticsHandlers } = require('./handlers/registerNetworkDiagnosticsHandlers')
const { registerSessionBrowserHandlers } = require('./handlers/registerSessionBrowserHandlers')
const { registerSessionResumeHandlers } = require('./handlers/registerSessionResumeHandlers')
const { registerCodexAccountHandlers, stopCodexAccountWatcher } = require('./handlers/registerCodexAccountHandlers')
const { registerDocBrowserHandlers } = require('./handlers/registerDocBrowserHandlers')
const { initDocBrowserStore } = require('./services/docBrowserService')
const { startIpMonitor } = require('./services/networkDiagnosticsService')
const { registerRepoWatcherHandlers } = require('./handlers/registerRepoWatcherHandlers')
const { resolveProviderRegistryFilePath } = require('./services/providerRegistryPathService')
const { ensureBuiltinProviderRegistryInstalled } = require('./services/builtinMcpInstallerService')

const PROVIDER_REGISTRY_FILE_PATH = resolveProviderRegistryFilePath()
const PROVIDER_REGISTRY_MCP_SCRIPT_PATH = path.resolve(__dirname, '..', 'mcp', 'provider_registry_mcp.js')

const store = new Store()

// 初始化文档查阅服务的 store 引用
initDocBrowserStore(store)

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
// 中央仓库监听服务清理函数
let repoWatcherCleanup = null
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

  const appUpdateHandlers = registerAppUpdateHandlers({
    ipcMain,
    app,
    shell,
    getMainWindow: () => mainWindow,
  })

  // 加载所有远程配置（cache > packaged > hardcoded），IPC 就绪前必须完成
  // 每个 registry 独立失败隔离：一个坏不影响其他
  const remoteConfigSpecs = [modelRegistrySpec, pricingRegistrySpec]
  const getUserDataPath = () => app.getPath('userData')

  for (const spec of remoteConfigSpecs) {
    try {
      const initResult = await initRemoteConfig(spec, { getUserDataPath })
      console.log(`[${spec.name}] loaded from ${initResult.source}, version=${initResult.version}`)
    } catch (error) {
      console.warn(`[${spec.name}] init failed:`, error?.message || error)
    }
  }

  registerModelRegistryHandlers({ ipcMain })
  registerPricingRegistryHandlers({ ipcMain })

  createWindow()

  // 启动后异步后台刷新所有 registry（不阻塞启动；结果下次启动才生效，避免 UI 中途跳变）
  setTimeout(() => {
    for (const spec of remoteConfigSpecs) {
      refreshRemoteConfigInBackground(spec, { getUserDataPath })
        .then((result) => {
          if (result.success) {
            console.log(`[${spec.name}] refreshed from ${result.source}, version=${result.version}`)
          } else {
            console.warn(`[${spec.name}] refresh skipped: ${result.error}`)
          }
        })
        .catch((error) => {
          console.warn(`[${spec.name}] refresh unexpected failure:`, error?.message || error)
        })
    }
  }, 2000)

  // 启动即检查一次新版本，先做提醒式更新，不在应用内直接下载安装。
  appUpdateHandlers.checkForUpdates().catch((error) => {
    console.warn('[app-update] startup check failed:', error?.message || error)
  })

  // 启动 IP 后台监控（应用启动即运行，30 秒采样）
  startIpMonitor(() => mainWindow)

  // 启动中央仓库文件监听（方向 1：中央→工具自动推送）
  let initialRepoPath = '~/Documents/SkillManager/'
  try {
    const configPath = expandHome('~/Documents/SkillManager/.config.json')
    const configContent = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(configContent)
    if (config.repoPath) initialRepoPath = config.repoPath
  } catch {
    // 使用默认路径
  }

  repoWatcherCleanup = registerRepoWatcherHandlers({
    ipcMain,
    getMainWindow: () => mainWindow,
    expandHome,
    initialRepoPath,
  })
})

app.on('window-all-closed', () => {
  repoWatcherCleanup?.stopWatching().catch(() => {})
  stopCodexAccountWatcher().catch(() => {})
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

// parseSkillMd 已抽到 services/skillScanService.js（统一复用）

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
 * 扫描工具目录获取技能列表（委托给 skillScanService）
 */
ipcMain.handle('scan-tool-directory', async (event, toolPath) => {
  if (typeof toolPath !== 'string' || toolPath.length === 0) {
    return { success: false, error: 'INVALID_PATH', skills: [] }
  }

  try {
    const expandedPath = expandHome(toolPath)
    return await scanSkillDirectory(expandedPath)
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

// scan-preset-tools, scan-custom-path, check-path-exists, change-repo-path
// 已迁移到 handlers/registerImportPageHandlers.js

/**
 * 注册技能管理相关 IPC handlers
 */
registerSkillHandlers({
  ipcMain,
  expandHome,
  pathExists,
  parseSkillMd,
  isPathInAllowedDirs,
})

/**
 * 注册导入页面相关 IPC handlers（预设工具扫描、自定义路径、仓库迁移）
 */
registerImportPageHandlers({
  ipcMain,
  expandHome,
  pathExists,
})

/**
 * 注册 V0.9 新建项目初始化相关 IPC handlers
 */
registerProjectInitHandlers({
  ipcMain,
  expandHome,
  pathExists,
  templateBaseDir: path.resolve(__dirname, '..', 'templates', 'project-init-v1.2.5'),
})

registerUsageAggregationHandlers({
  ipcMain,
  expandHome,
  pathExists,
  homeDir: os.homedir(),
  nowFn: () => new Date()
})


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
 * 注册 V0.16 模型配置与推理等级 IPC handlers
 */
registerModelConfigHandlers({
  ipcMain,
  pathExists,
})

/**
 * 注册 Claude Code 会员额度状态相关 IPC handlers
 */
registerClaudeUsageStatusHandlers({
  ipcMain,
  pathExists,
})

/**
 * 注册 MCP 管理相关 IPC handlers
 */
registerMcpHandlers({
  ipcMain,
})

registerNetworkDiagnosticsHandlers({
  ipcMain,
})

registerSessionBrowserHandlers({
  ipcMain,
})

registerSessionResumeHandlers({
  ipcMain,
})

registerCodexAccountHandlers({
  ipcMain,
  getMainWindow: () => mainWindow,
})

registerDocBrowserHandlers({
  ipcMain,
  getMainWindow: () => mainWindow,
})
