/**
 * 权限模式（启动模式）IPC 处理模块
 *
 * 负责：
 * - 读取 Claude Code 的权限模式配置（~/.claude/settings.json）
 * - 写入 permissions.defaultMode 字段
 * - 备份原文件到 ~/.claude/backups/
 * - 原子写入避免配置文件损坏
 *
 * 支持的权限模式：
 * - plan: 只读规划（--plan）
 * - default: 每次询问（默认）
 * - acceptEdits: 自动编辑（--accept-edits）
 * - bypassPermissions: 全自动（--bypass-permissions）
 *
 * @module electron/handlers/permissionModeHandlers
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')

// 配置文件路径
const CLAUDE_SETTINGS_FILE_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_SETTINGS_BACKUP_DIR = path.join(os.homedir(), '.claude', 'backups')

// 有效的权限模式列表
const VALID_PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'bypassPermissions']

// 模式中文映射
const MODE_DISPLAY_NAMES = {
  plan: '只读规划',
  default: '每次询问',
  acceptEdits: '自动编辑',
  bypassPermissions: '全自动',
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
async function backupClaudeSettingsRaw(rawContent, suffix = 'permission-mode') {
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
      errorCode: 'BACKUP_FAILED',
      error: `备份 Claude settings 失败: ${error.message}`,
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
 * 读取权限模式配置
 * @param {(filepath: string) => Promise<boolean>} pathExists - 路径存在检查函数
 * @returns {Promise<{success: boolean, mode?: string, isConfigured?: boolean, modeName?: string, error?: string, errorCode?: string}>}
 */
async function getPermissionModeConfig(pathExists) {
  try {
    const exists = await pathExists(CLAUDE_SETTINGS_FILE_PATH)

    // 文件不存在：视为未配置
    if (!exists) {
      return {
        success: true,
        mode: null,
        isConfigured: false,
        modeName: null,
        error: null,
        errorCode: null,
      }
    }

    // 读取文件内容
    let content
    try {
      content = await fs.readFile(CLAUDE_SETTINGS_FILE_PATH, 'utf-8')
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return {
          success: false,
          error: '无法读取 Claude settings.json，请检查权限',
          errorCode: 'PERMISSION_DENIED',
        }
      }
      return {
        success: false,
        error: `读取 Claude settings.json 失败: ${error.message}`,
        errorCode: 'READ_ERROR',
      }
    }

    // 解析 JSON
    let data
    try {
      data = JSON.parse(content)
    } catch (error) {
      return {
        success: false,
        error: `settings.json JSON 解析错误: ${error.message}`,
        errorCode: 'JSON_PARSE_ERROR',
      }
    }

    // 检查 permissions.defaultMode 字段
    const mode = data?.permissions?.defaultMode

    if (typeof mode !== 'string') {
      // 字段不存在或不是字符串：视为未配置
      return {
        success: true,
        mode: null,
        isConfigured: false,
        modeName: null,
        error: null,
        errorCode: null,
      }
    }

    // 检查是否为已知模式
    const isKnownMode = VALID_PERMISSION_MODES.includes(mode)

    return {
      success: true,
      mode,
      isConfigured: true,
      isKnownMode,
      modeName: MODE_DISPLAY_NAMES[mode] || '未知模式',
      error: null,
      errorCode: null,
    }
  } catch (error) {
    return {
      success: false,
      error: `获取权限模式配置失败: ${error.message}`,
      errorCode: 'READ_ERROR',
    }
  }
}

/**
 * 设置权限模式
 * @param {string} mode - 权限模式（plan/default/acceptEdits/bypassPermissions）
 * @param {(filepath: string) => Promise<boolean>} pathExists - 路径存在检查函数
 * @returns {Promise<{success: boolean, backupPath?: string, error?: string, errorCode?: string}>}
 */
async function setPermissionMode(mode, pathExists) {
  // 验证模式有效性
  if (!VALID_PERMISSION_MODES.includes(mode)) {
    return {
      success: false,
      error: `无效的权限模式: ${mode}。支持的值: ${VALID_PERMISSION_MODES.join(', ')}`,
      errorCode: 'INVALID_MODE',
    }
  }

  try {
    // 读取现有配置（如果存在）
    let existingData = {}
    let existingContent = ''
    const exists = await pathExists(CLAUDE_SETTINGS_FILE_PATH)

    if (exists) {
      try {
        existingContent = await fs.readFile(CLAUDE_SETTINGS_FILE_PATH, 'utf-8')
        existingData = JSON.parse(existingContent)
      } catch (error) {
        // 如果解析失败，仍尝试写入（覆盖）
        if (error.name === 'SyntaxError') {
          // JSON 解析错误，先备份原文件
          const backupResult = await backupClaudeSettingsRaw(existingContent, 'corrupted')
          if (!backupResult.success) {
            return {
              success: false,
              error: `原文件 JSON 损坏且备份失败: ${backupResult.error}`,
              errorCode: backupResult.errorCode || 'BACKUP_FAILED',
            }
          }
          // 使用空对象重新开始
          existingData = {}
        } else if (error.code === 'EACCES' || error.code === 'EPERM') {
          return {
            success: false,
            error: '无法读取 Claude settings.json，请检查权限',
            errorCode: 'PERMISSION_DENIED',
          }
        } else {
          return {
            success: false,
            error: `读取 Claude settings.json 失败: ${error.message}`,
            errorCode: 'READ_ERROR',
          }
        }
      }
    }

    // 确保是对象类型
    if (typeof existingData !== 'object' || existingData === null) {
      existingData = {}
    }

    // 确保 permissions 对象存在
    if (!existingData.permissions || typeof existingData.permissions !== 'object') {
      existingData.permissions = {}
    }

    // 设置 defaultMode
    existingData.permissions.defaultMode = mode

    // 如果有原文件内容，先备份
    let backupPath = null
    if (exists && existingContent) {
      const backupResult = await backupClaudeSettingsRaw(existingContent, 'permission-mode')
      if (!backupResult.success) {
        return {
          success: false,
          error: `备份失败: ${backupResult.error}`,
          errorCode: backupResult.errorCode || 'BACKUP_FAILED',
        }
      }
      backupPath = backupResult.backupPath
    }

    // 原子写入新配置
    const newContent = `${JSON.stringify(existingData, null, 2)}\n`
    const writeResult = await atomicWriteText(CLAUDE_SETTINGS_FILE_PATH, newContent)

    if (!writeResult.success) {
      const errorMap = {
        PERMISSION_DENIED: '权限被拒绝：无法写入 Claude settings.json',
        DISK_FULL: '磁盘空间不足，无法保存配置',
        CREATE_DIR_FAILED: `创建目录失败: ${writeResult.error}`,
        WRITE_FAILED: `写入失败: ${writeResult.error}`,
        RENAME_FAILED: `更新配置文件失败: ${writeResult.error}`,
      }
      return {
        success: false,
        error: errorMap[writeResult.error] || `写入失败: ${writeResult.error}`,
        errorCode: writeResult.error || 'WRITE_ERROR',
      }
    }

    return {
      success: true,
      backupPath,
      error: null,
      errorCode: null,
    }
  } catch (error) {
    return {
      success: false,
      error: `设置权限模式失败: ${error.message}`,
      errorCode: 'WRITE_ERROR',
    }
  }
}

/**
 * 注册权限模式 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 * @param {(filepath: string) => string} deps.expandHome - 展开 home 目录路径
 */
function registerPermissionModeHandlers({ ipcMain, pathExists, expandHome }) {
  /**
   * IPC: 获取权限模式配置
   * @returns {Promise<{success: boolean, mode?: string, isConfigured?: boolean, isKnownMode?: boolean, modeName?: string, error?: string, errorCode?: string}>}
   */
  ipcMain.handle('get-permission-mode-config', async () => {
    return getPermissionModeConfig(pathExists)
  })

  /**
   * IPC: 设置权限模式
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {string} mode - 目标权限模式
   * @returns {Promise<{success: boolean, backupPath?: string, error?: string, errorCode?: string}>}
   */
  ipcMain.handle('set-permission-mode', async (event, mode) => {
    if (typeof mode !== 'string') {
      return {
        success: false,
        error: '参数错误：mode 必须是字符串',
        errorCode: 'INVALID_ARGUMENT',
      }
    }
    return setPermissionMode(mode, pathExists)
  })
}

module.exports = {
  registerPermissionModeHandlers,
  getPermissionModeConfig,
  setPermissionMode,
  VALID_PERMISSION_MODES,
  MODE_DISPLAY_NAMES,
}