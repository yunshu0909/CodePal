/**
 * 模型配置与推理等级 IPC 处理模块
 *
 * 负责：
 * - 读取 Claude Code 的模型配置（~/.claude/settings.json）
 * - 写入 model 和 effortLevel 字段
 * - 复用 permissionModeHandlers 的备份和原子写入基础设施
 *
 * 支持的字段：
 * - model: 模型别名或完整模型名（如 opus、claude-opus-4-6）
 * - effortLevel: 推理等级（low / medium / high）
 *
 * @module electron/handlers/modelConfigHandlers
 */

const fs = require('fs/promises')
const {
  backupClaudeSettingsRaw,
  atomicWriteText,
  CLAUDE_SETTINGS_FILE_PATH,
} = require('./permissionModeHandlers')

// effortLevel 的基础格式校验：只允许小写字母/数字/短横线/下划线，长度 1-32
// 不做值白名单 —— 新值（如 Claude 4.7 的 xhigh、未来可能的新档位）由 Claude Code 自己判定有效性
const EFFORT_LEVEL_PATTERN = /^[a-z0-9_-]{1,32}$/

// 推理等级中文映射（仅用于提示文案，非业务白名单）
const EFFORT_DISPLAY_NAMES = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
}

/**
 * 读取模型配置
 * @param {(filepath: string) => Promise<boolean>} pathExists - 路径存在检查函数
 * @returns {Promise<{success: boolean, model?: string|null, effortLevel?: string|null, isModelConfigured?: boolean, isEffortConfigured?: boolean, error?: string, errorCode?: string}>}
 */
async function getModelConfig(pathExists) {
  try {
    const exists = await pathExists(CLAUDE_SETTINGS_FILE_PATH)

    if (!exists) {
      return {
        success: true,
        model: null,
        effortLevel: null,
        isModelConfigured: false,
        isEffortConfigured: false,
        error: null,
        errorCode: null,
      }
    }

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

    const model = data?.model
    const effortLevel = data?.effortLevel

    // 空字符串视为未配置（"跟随账户默认"）
    const modelConfigured = typeof model === 'string' && model !== ''
    const effortConfigured = typeof effortLevel === 'string' && effortLevel !== ''

    return {
      success: true,
      model: modelConfigured ? model : null,
      effortLevel: effortConfigured ? effortLevel : null,
      isModelConfigured: modelConfigured,
      isEffortConfigured: effortConfigured,
      error: null,
      errorCode: null,
    }
  } catch (error) {
    return {
      success: false,
      error: `获取模型配置失败: ${error.message}`,
      errorCode: 'READ_ERROR',
    }
  }
}

/**
 * 设置模型配置（model 或 effortLevel）
 * @param {string} field - 要设置的字段（model 或 effortLevel）
 * @param {string} value - 字段值
 * @param {(filepath: string) => Promise<boolean>} pathExists - 路径存在检查函数
 * @returns {Promise<{success: boolean, backupPath?: string|null, error?: string, errorCode?: string}>}
 */
async function setModelConfig(field, value, pathExists) {
  // 验证字段名
  if (field !== 'model' && field !== 'effortLevel') {
    return {
      success: false,
      error: `无效的字段: ${field}。支持的字段: model, effortLevel`,
      errorCode: 'INVALID_FIELD',
    }
  }

  // 验证值（model 允许空字符串，表示"跟随账户默认"）
  if (typeof value !== 'string') {
    return {
      success: false,
      error: '参数错误：value 必须是字符串',
      errorCode: 'INVALID_VALUE',
    }
  }
  // model 允许显式传入空字符串表示“跟随账户默认”，但不接受纯空白字符。
  if (field === 'model' && value !== '' && value.trim() === '') {
    return {
      success: false,
      error: '参数错误：model 不能是纯空白字符',
      errorCode: 'INVALID_VALUE',
    }
  }
  if (field !== 'model' && value.trim() === '') {
    return {
      success: false,
      error: '参数错误：value 必须是非空字符串',
      errorCode: 'INVALID_VALUE',
    }
  }

  // effortLevel 做基础格式校验：只接受合法字符，具体"值是否有效"由 Claude Code 自己判定
  // 这样未来 Claude 升级新增推理档位（如 4.7 的 xhigh）不用改后端代码
  if (field === 'effortLevel' && !EFFORT_LEVEL_PATTERN.test(value)) {
    return {
      success: false,
      error: `无效的推理等级格式: ${value}。仅允许小写字母、数字、短横线和下划线，长度 1-32`,
      errorCode: 'INVALID_EFFORT_LEVEL',
    }
  }

  try {
    // 读取现有配置
    let existingData = {}
    let existingContent = ''
    const exists = await pathExists(CLAUDE_SETTINGS_FILE_PATH)

    if (exists) {
      try {
        existingContent = await fs.readFile(CLAUDE_SETTINGS_FILE_PATH, 'utf-8')
        existingData = JSON.parse(existingContent)
      } catch (error) {
        if (error.name === 'SyntaxError') {
          const backupResult = await backupClaudeSettingsRaw(existingContent, 'corrupted')
          if (!backupResult.success) {
            return {
              success: false,
              error: `原文件 JSON 损坏且备份失败: ${backupResult.error}`,
              errorCode: backupResult.errorCode || 'BACKUP_FAILED',
            }
          }
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

    if (typeof existingData !== 'object' || existingData === null) {
      existingData = {}
    }

    // 设置字段值
    existingData[field] = value

    // 备份原文件
    let backupPath = null
    if (exists && existingContent) {
      const backupResult = await backupClaudeSettingsRaw(existingContent, 'model-config')
      if (!backupResult.success) {
        return {
          success: false,
          error: `备份失败: ${backupResult.error}`,
          errorCode: backupResult.errorCode || 'BACKUP_FAILED',
        }
      }
      backupPath = backupResult.backupPath
    }

    // 原子写入
    const newContent = `${JSON.stringify(existingData, null, 2)}\n`
    const writeResult = await atomicWriteText(CLAUDE_SETTINGS_FILE_PATH, newContent)

    if (!writeResult.success) {
      const errorMap = {
        PERMISSION_DENIED: '权限被拒绝：无法写入 Claude settings.json',
        DISK_FULL: '磁盘空间不足，无法保存配置',
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
      error: `设置模型配置失败: ${error.message}`,
      errorCode: 'WRITE_ERROR',
    }
  }
}

/**
 * 注册模型配置 IPC handlers
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 */
function registerModelConfigHandlers({ ipcMain, pathExists }) {
  /**
   * IPC: 获取模型配置
   */
  ipcMain.handle('get-model-config', async () => {
    return getModelConfig(pathExists)
  })

  /**
   * IPC: 设置模型配置
   * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
   * @param {string} field - 字段名（model 或 effortLevel）
   * @param {string} value - 字段值
   */
  ipcMain.handle('set-model-config', async (event, field, value) => {
    if (typeof field !== 'string' || typeof value !== 'string') {
      return {
        success: false,
        error: '参数错误：field 和 value 必须是字符串',
        errorCode: 'INVALID_ARGUMENT',
      }
    }
    return setModelConfig(field, value, pathExists)
  })
}

module.exports = {
  registerModelConfigHandlers,
  getModelConfig,
  setModelConfig,
  EFFORT_LEVEL_PATTERN,
  EFFORT_DISPLAY_NAMES,
}
