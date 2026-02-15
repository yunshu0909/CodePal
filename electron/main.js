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
const Store = require('electron-store').default
const os = require('os')
const dotenv = require('dotenv')

// 加载环境变量（从 .env 文件）
const ENV_FILE_PATH = path.resolve(__dirname, '..', '.env')
dotenv.config({ path: ENV_FILE_PATH })

const { scanLogFilesInRange } = require('./logScanner')
const { handleScanLogFiles } = require('./scanLogFilesHandler')

const store = new Store()

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

app.whenReady().then(createWindow)

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
  const tempPath = `${filePath}.tmp.${Date.now()}`
  try {
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
    await atomicWriteFile(expandedPath, content)

    return { success: true, error: null }
  } catch (error) {
    console.error('Error writing config:', error)
    return { success: false, error: error.message }
  }
})

// IPC handlers for V0.3 import page

/**
 * 预设工具配置
 * 固定4个工具：Claude Code、CodeX、Cursor、Trae
 */
const PRESET_TOOLS = [
  { id: 'claude-code', name: 'Claude Code', icon: 'CC', iconClass: 'cc', path: '~/.claude/skills/' },
  { id: 'codex', name: 'CodeX', icon: 'CX', iconClass: 'cx', path: '~/.codex/skills/' },
  { id: 'cursor', name: 'Cursor', icon: 'CU', iconClass: 'cu', path: '~/.cursor/skills/' },
  { id: 'trae', name: 'Trae', icon: 'TR', iconClass: 'tr', path: '~/.trae/skills/' }
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
 * 扫描 .claude/skills/、.codex/skills/、.cursor/skills/、.trae/skills/ 子目录
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
      'trae': '.trae/skills'
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
 * 执行导入操作
 * 将选中的来源 skills 去重合并到中央仓库
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 导入参数
 * @param {string[]} params.presetTools - 选中的预设工具ID列表
 * @param {Array<{path: string, skills: Object}>} params.customPaths - 选中的自定义路径列表
 * @param {string} params.repoPath - 中央仓库路径
 * @returns {Promise<{success: boolean, importedCount: number, errors: Array, error: string|null}>} 导入结果
 */
ipcMain.handle('import-skills', async (event, { presetTools = [], customPaths = [], repoPath }) => {
  // IPC 参数类型校验
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    return {
      success: false,
      importedCount: 0,
      errors: [{ error: 'INVALID_REPO_PATH' }],
      error: 'INVALID_REPO_PATH'
    }
  }
  if (!Array.isArray(presetTools) || !Array.isArray(customPaths)) {
    return {
      success: false,
      importedCount: 0,
      errors: [{ error: 'INVALID_PARAMETERS' }],
      error: 'INVALID_PARAMETERS'
    }
  }

  const errors = []
  let importedCount = 0

  try {
    const expandedRepoPath = expandHome(repoPath)

    // 确保中央仓库目录存在
    await fs.mkdir(expandedRepoPath, { recursive: true })

    // 收集所有要导入的 skills（按来源分组）
    const skillsToImport = []

    // 1. 收集预设工具的 skills
    for (const toolId of presetTools) {
      const tool = PRESET_TOOLS.find(t => t.id === toolId)
      if (!tool) continue

      const expandedToolPath = expandHome(tool.path)
      const exists = await pathExists(expandedToolPath)

      if (!exists) {
        errors.push({ source: tool.name, error: 'DIRECTORY_NOT_FOUND' })
        continue
      }

      try {
        const entries = await fs.readdir(expandedToolPath, { withFileTypes: true })

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMdPath = path.join(expandedToolPath, entry.name, 'SKILL.md')
            const skillMdExists = await pathExists(skillMdPath)

            if (skillMdExists) {
              skillsToImport.push({
                sourceName: tool.name,
                sourcePath: path.join(expandedToolPath, entry.name),
                skillName: entry.name,
                source: 'preset'
              })
            }
          }
        }
      } catch (err) {
        errors.push({ source: tool.name, error: err.code === 'EACCES' ? 'PERMISSION_DENIED' : err.message })
      }
    }

    // 2. 收集自定义路径的 skills
    for (const customPath of customPaths) {
      const expandedCustomPath = expandHome(customPath.path)
      const exists = await pathExists(expandedCustomPath)

      if (!exists) {
        errors.push({ source: customPath.path, error: 'PATH_NOT_FOUND' })
        continue
      }

      const toolSubdirs = {
        claude: '.claude/skills',
        codex: '.codex/skills',
        cursor: '.cursor/skills',
        trae: '.trae/skills'
      }

      for (const [toolId, subdir] of Object.entries(toolSubdirs)) {
        const toolPath = path.join(expandedCustomPath, subdir)
        const toolExists = await pathExists(toolPath)

        if (!toolExists) continue

        try {
          const entries = await fs.readdir(toolPath, { withFileTypes: true })

          for (const entry of entries) {
            if (entry.isDirectory()) {
              const skillMdPath = path.join(toolPath, entry.name, 'SKILL.md')
              const skillMdExists = await pathExists(skillMdPath)

              if (skillMdExists) {
                skillsToImport.push({
                  sourceName: `${path.basename(customPath.path)}/${toolId}`,
                  sourcePath: path.join(toolPath, entry.name),
                  skillName: entry.name,
                  source: 'custom'
                })
              }
            }
          }
        } catch (err) {
          errors.push({ source: `${customPath.path}/${toolId}`, error: err.code === 'EACCES' ? 'PERMISSION_DENIED' : err.message })
        }
      }
    }

    // 3. 执行导入（去重：后覆盖先）
    for (const skill of skillsToImport) {
      try {
        const targetPath = path.join(expandedRepoPath, skill.skillName)

        // 复制 skill 到中央仓库（覆盖已存在的）
        await fs.cp(skill.sourcePath, targetPath, { recursive: true, force: true })
        importedCount++
      } catch (err) {
        errors.push({
          source: skill.sourceName,
          skill: skill.skillName,
          error: err.code === 'EACCES' ? 'PERMISSION_DENIED' : err.message
        })
      }
    }

    // 如果有错误但整体成功，返回部分成功
    if (errors.length > 0 && importedCount > 0) {
      return {
        success: true,
        importedCount,
        errors,
        error: 'PARTIAL_SUCCESS'
      }
    }

    // 如果完全失败
    if (importedCount === 0 && errors.length > 0) {
      return {
        success: false,
        importedCount: 0,
        errors,
        error: 'IMPORT_FAILED'
      }
    }

    return {
      success: true,
      importedCount,
      errors: [],
      error: null
    }
  } catch (error) {
    console.error('Error importing skills:', error)
    return {
      success: false,
      importedCount,
      errors,
      error: error.message
    }
  }
})

// IPC handlers for V0.4 manage page

/**
 * 获取中央仓库所有技能
 * 扫描中央仓库目录，返回所有包含 SKILL.md 的技能文件夹
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} repoPath - 中央仓库路径
 * @returns {Promise<{success: boolean, skills: Array, error: string|null}>} 技能列表
 */
ipcMain.handle('get-central-skills', async (event, repoPath) => {
  try {
    const expandedRepoPath = expandHome(repoPath)

    // 检查目录是否存在
    const exists = await pathExists(expandedRepoPath)
    if (!exists) {
      return { success: true, skills: [], error: null }
    }

    // 读取目录内容
    const entries = await fs.readdir(expandedRepoPath, { withFileTypes: true })
    const skills = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = path.join(expandedRepoPath, entry.name, 'SKILL.md')
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
            // 静默处理：无法读取 SKILL.md 时仍包含该技能
            skills.push({
              name: entry.name,
              displayName: entry.name,
              desc: ''
            })
          }
        }
      }
    }

    // 按名称排序
    skills.sort((a, b) => a.displayName.localeCompare(b.displayName))

    return { success: true, skills, error: null }
  } catch (error) {
    console.error('Error getting central skills:', error)
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return { success: false, skills: [], error: 'PERMISSION_DENIED' }
    }
    return { success: false, skills: [], error: error.message }
  }
})

/**
 * 获取工具的推送状态
 * 检查每个工具目录中是否存在指定的技能
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string[]} skillNames - 技能名称列表
 * @returns {Promise<{success: boolean, status: Object, error: string|null}>} 推送状态
 * status 格式: { skillName: { 'claude-code': boolean, 'codex': boolean, ... } }
 */
ipcMain.handle('get-tool-status', async (event, skillNames) => {
  try {
    const status = {}

    // 初始化每个技能的状态
    for (const skillName of skillNames) {
      status[skillName] = {}
    }

    // 检查每个工具的推送状态
    for (const tool of PRESET_TOOLS) {
      const expandedToolPath = expandHome(tool.path)
      const toolExists = await pathExists(expandedToolPath)

      if (toolExists) {
        for (const skillName of skillNames) {
          const skillPath = path.join(expandedToolPath, skillName)
          const skillMdPath = path.join(skillPath, 'SKILL.md')
          status[skillName][tool.id] = await pathExists(skillMdPath)
        }
      } else {
        // 工具目录不存在，所有技能都标记为未推送
        for (const skillName of skillNames) {
          status[skillName][tool.id] = false
        }
      }
    }

    return { success: true, status, error: null }
  } catch (error) {
    console.error('Error getting tool status:', error)
    return { success: false, status: {}, error: error.message }
  }
})

/**
 * 推送技能到工具
 * 将中央仓库中的技能复制到指定工具的 skills 目录
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 推送参数
 * @param {string} params.repoPath - 中央仓库路径
 * @param {string[]} params.skillNames - 要推送的技能名称列表
 * @param {string[]} params.toolIds - 目标工具 ID 列表
 * @returns {Promise<{success: boolean, results: Array, error: string|null}>} 推送结果
 */
ipcMain.handle('push-skills', async (event, { repoPath, skillNames, toolIds }) => {
  // IPC 参数类型校验
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    return {
      success: false,
      results: [],
      errors: [{ error: 'INVALID_REPO_PATH' }],
      error: 'INVALID_REPO_PATH'
    }
  }
  if (!Array.isArray(skillNames) || !Array.isArray(toolIds)) {
    return {
      success: false,
      results: [],
      errors: [{ error: 'INVALID_PARAMETERS' }],
      error: 'INVALID_PARAMETERS'
    }
  }

  const results = []
  const errors = []

  try {
    const expandedRepoPath = expandHome(repoPath)

    for (const skillName of skillNames) {
      const sourcePath = path.join(expandedRepoPath, skillName)
      const skillMdPath = path.join(sourcePath, 'SKILL.md')

      // 验证源技能存在
      if (!(await pathExists(skillMdPath))) {
        errors.push({ skill: skillName, error: 'SKILL_NOT_FOUND' })
        continue
      }

      for (const toolId of toolIds) {
        const tool = PRESET_TOOLS.find(t => t.id === toolId)
        if (!tool) {
          errors.push({ skill: skillName, tool: toolId, error: 'TOOL_NOT_FOUND' })
          continue
        }

        const expandedToolPath = expandHome(tool.path)
        const targetPath = path.join(expandedToolPath, skillName)

        try {
          // 确保工具目录存在
          await fs.mkdir(expandedToolPath, { recursive: true })

          // 复制技能到工具目录
          await fs.cp(sourcePath, targetPath, { recursive: true, force: true })
          results.push({ skill: skillName, tool: toolId, success: true })
        } catch (err) {
          const errorCode = err.code === 'EACCES' || err.code === 'EPERM' ? 'PERMISSION_DENIED' : err.message
          errors.push({ skill: skillName, tool: toolId, error: errorCode })
        }
      }
    }

    // 如果有错误但整体有成功，返回部分成功
    if (errors.length > 0 && results.length > 0) {
      return {
        success: true,
        results,
        errors,
        error: 'PARTIAL_SUCCESS'
      }
    }

    // 如果完全失败
    if (results.length === 0 && errors.length > 0) {
      return {
        success: false,
        results: [],
        errors,
        error: 'PUSH_FAILED'
      }
    }

    return { success: true, results, errors: [], error: null }
  } catch (error) {
    console.error('Error pushing skills:', error)
    return { success: false, results, errors, error: error.message }
  }
})

/**
 * 停用技能（从工具目录删除）
 * 从指定工具的 skills 目录中删除技能
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 停用参数
 * @param {string[]} params.skillNames - 要停用的技能名称列表
 * @param {string[]} params.toolIds - 目标工具 ID 列表
 * @returns {Promise<{success: boolean, results: Array, error: string|null}>} 停用结果
 */
ipcMain.handle('unpush-skills', async (event, { skillNames, toolIds }) => {
  // IPC 参数类型校验
  if (!Array.isArray(skillNames) || !Array.isArray(toolIds)) {
    return {
      success: false,
      results: [],
      errors: [{ error: 'INVALID_PARAMETERS' }],
      error: 'INVALID_PARAMETERS'
    }
  }

  const results = []
  const errors = []

  try {
    for (const skillName of skillNames) {
      for (const toolId of toolIds) {
        const tool = PRESET_TOOLS.find(t => t.id === toolId)
        if (!tool) {
          errors.push({ skill: skillName, tool: toolId, error: 'TOOL_NOT_FOUND' })
          continue
        }

        const expandedToolPath = expandHome(tool.path)
        const skillPath = path.join(expandedToolPath, skillName)

        try {
          // 检查技能是否存在
          if (!(await pathExists(skillPath))) {
            // 已不存在，视为成功
            results.push({ skill: skillName, tool: toolId, success: true })
            continue
          }

          // 安全校验：检查路径是否在允许的目录范围内
          if (!isPathInAllowedDirs(expandedToolPath)) {
            console.error('Security: Blocked unpush attempt for path:', expandedToolPath)
            errors.push({ skill: skillName, tool: toolId, error: 'UNSAFE_PATH' })
            continue
          }

          // 删除技能目录
          await fs.rm(skillPath, { recursive: true, force: true })
          results.push({ skill: skillName, tool: toolId, success: true })
        } catch (err) {
          const errorCode = err.code === 'EACCES' || err.code === 'EPERM' ? 'PERMISSION_DENIED' : err.message
          errors.push({ skill: skillName, tool: toolId, error: errorCode })
        }
      }
    }

    // 如果有错误但整体有成功，返回部分成功
    if (errors.length > 0 && results.length > 0) {
      return {
        success: true,
        results,
        errors,
        error: 'PARTIAL_SUCCESS'
      }
    }

    // 如果完全失败
    if (results.length === 0 && errors.length > 0) {
      return {
        success: false,
        results: [],
        errors,
        error: 'UNPUSH_FAILED'
      }
    }

    return { success: true, results, errors: [], error: null }
  } catch (error) {
    console.error('Error unpushing skills:', error)
    return { success: false, results, errors, error: error.message }
  }
})

/**
 * 增量导入 - 仅新增不覆盖
 * 从自定义路径扫描技能，仅导入中央仓库中不存在的技能
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {Object} params - 导入参数
 * @param {string[]} params.customPathIds - 自定义路径 ID 列表（实际为路径字符串）
 * @param {string} params.repoPath - 中央仓库路径
 * @returns {Promise<{success: boolean, added: number, skipped: number, errors: string[]}>} 导入结果
 */
ipcMain.handle('incremental-import', async (event, { customPathIds, repoPath }) => {
  let added = 0
  let skipped = 0
  const errors = []

  try {
    const expandedRepoPath = expandHome(repoPath)

    // 1. 确保中央仓库目录存在
    await fs.mkdir(expandedRepoPath, { recursive: true })

    // 2. 获取中央仓库现有技能名称集合（用于去重）
    const existingSkills = new Set()
    try {
      const entries = await fs.readdir(expandedRepoPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMdPath = path.join(expandedRepoPath, entry.name, 'SKILL.md')
          if (await pathExists(skillMdPath)) {
            existingSkills.add(entry.name)
          }
        }
      }
    } catch (err) {
      // 目录不存在或无法读取时，视为空仓库
    }

    // 3. 遍历自定义路径
    for (const customPathId of customPathIds) {
      const expandedCustomPath = expandHome(customPathId)
      const pathExists_result = await pathExists(expandedCustomPath)

      if (!pathExists_result) {
        errors.push(`Path not found: ${customPathId}`)
        continue
      }

      // 4. 扫描该路径下的技能
      const scanResult = await scanCustomPathForSkills(expandedCustomPath)

      if (!scanResult.success) {
        errors.push(`Failed to scan ${customPathId}: ${scanResult.error}`)
        continue
      }

      // 5. 处理扫描到的技能
      for (const skill of scanResult.skills) {
        if (existingSkills.has(skill.name)) {
          // 中央仓库已存在，跳过
          skipped++
        } else {
          // 中央仓库不存在，复制
          try {
            const targetPath = path.join(expandedRepoPath, skill.name)
            await fs.cp(skill.sourcePath, targetPath, { recursive: true, force: false })
            added++
            existingSkills.add(skill.name) // 添加到集合防止同一批次重复导入
          } catch (err) {
            errors.push(`Failed to copy ${skill.name}: ${err.message}`)
          }
        }
      }
    }

    // 6. 返回统计结果
    const hasErrors = errors.length > 0
    const hasSuccess = added > 0 || skipped > 0

    if (hasErrors && !hasSuccess) {
      return { success: false, added, skipped, errors }
    }

    return { success: true, added, skipped, errors }
  } catch (error) {
    console.error('Error in incremental import:', error)
    return { success: false, added, skipped, errors: [...errors, error.message] }
  }
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

// IPC handler for aggregate usage (kept for compatibility, actual aggregation happens in renderer)
// The aggregation is done in renderer process to avoid bundling issues with ESM modules

/**
 * 扫描自定义路径下的所有技能
 * 辅助函数：扫描指定路径下的所有工具子目录，收集技能信息
 * @param {string} customPath - 自定义路径（已展开）
 * @returns {Promise<{success: boolean, skills: Array, error: string|null}>} 扫描结果
 */
async function scanCustomPathForSkills(customPath) {
  const skills = []

  const toolSubdirs = {
    'claude-code': '.claude/skills',
    'codex': '.codex/skills',
    'cursor': '.cursor/skills',
    'trae': '.trae/skills'
  }

  try {
    for (const [toolId, subdir] of Object.entries(toolSubdirs)) {
      const toolPath = path.join(customPath, subdir)
      const toolExists = await pathExists(toolPath)

      if (!toolExists) continue

      const entries = await fs.readdir(toolPath, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMdPath = path.join(toolPath, entry.name, 'SKILL.md')
          const skillMdExists = await pathExists(skillMdPath)

          if (skillMdExists) {
            skills.push({
              name: entry.name,
              sourcePath: path.join(toolPath, entry.name),
              toolId
            })
          }
        }
      }
    }

    return { success: true, skills, error: null }
  } catch (error) {
    console.error('Error scanning custom path for skills:', error)
    return { success: false, skills: [], error: error.message }
  }
}

// ==================== V0.7 供应商切换 ====================

const PROVIDER_DEFINITIONS = {
  official: {
    name: 'Claude Official',
    model: 'opus',
    tokenEnvKey: null,
    baseUrlEnvKey: null,
    defaultBaseUrl: null,
  },
  kimi: {
    name: 'Kimi For Coding',
    model: 'opus',
    tokenEnvKey: 'KIMI_API_KEY',
    baseUrlEnvKey: 'KIMI_BASE_URL',
    defaultBaseUrl: 'https://api.kimi.com/coding/',
  },
  aicodemirror: {
    name: 'AICodeMirror',
    model: 'opus',
    tokenEnvKey: 'AICODEMIRROR_API_KEY',
    baseUrlEnvKey: 'AICODEMIRROR_BASE_URL',
    defaultBaseUrl: 'https://api.aicodemirror.com/api/claudecode',
  },
}
const ACTIVE_PROVIDER_ENV_KEY = 'CLAUDE_CODE_PROVIDER'
const CLAUDE_SETTINGS_FILE_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_SETTINGS_BACKUP_DIR = path.join(os.homedir(), '.claude', 'backups')
const MANAGED_CLAUDE_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
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
 * @returns {Record<string, {name: string, token: string|null, baseUrl: string|null, model: string}>}
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
    ANTHROPIC_AUTH_TOKEN: null,
    ANTHROPIC_BASE_URL: null,
    ANTHROPIC_API_KEY: null,
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
 * @returns {string} official | kimi | aicodemirror | custom
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
 * @returns {string} official | kimi | aicodemirror | custom
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
 * @param {{token: string|null, baseUrl: string|null, model: string}} profile - 目标供应商档
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
    ANTHROPIC_AUTH_TOKEN: null,
    ANTHROPIC_BASE_URL: null,
    ANTHROPIC_API_KEY: null,
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
