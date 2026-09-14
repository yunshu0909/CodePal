/**
 * 权限模式（启动模式）IPC 处理模块
 *
 * 负责：
 * - 读取 Claude Code 的权限模式配置（~/.claude/settings.json）
 * - 写入、删除和恢复 permissions.defaultMode 字段
 * - 备份原文件到 ~/.claude/backups/
 * - 原子写入避免配置文件损坏
 *
 * 支持的权限模式：
 * - plan: 只读规划（--plan）
 * - default: 每次询问（默认）
 * - acceptEdits: 自动编辑（--accept-edits）
 * - dontAsk: 仅执行预先授权的操作
 * - bypassPermissions: 全自动（--bypass-permissions）
 * - auto: 由 Claude 自动审批
 *
 * @module electron/handlers/permissionModeHandlers
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
// settings.json 写入统一走唯一 broker（V1.9.8 收口）；本模块的 atomicWriteText/backup 导出仅供历史测试
const { mutateClaudeSettingsFile } = require('../services/claudeSettingsService')

// 配置文件路径
const CLAUDE_SETTINGS_FILE_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_SETTINGS_BACKUP_DIR = path.join(os.homedir(), '.claude', 'backups')

// 有效的权限模式列表
const VALID_PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto']

// 模式中文映射
const MODE_DISPLAY_NAMES = {
  plan: '只读规划',
  default: '每次询问',
  acceptEdits: '自动编辑',
  dontAsk: '仅预先授权',
  bypassPermissions: '全自动',
  auto: '自动审批',
}

const PERMISSION_BACKUP_PREFIX = 'settings-permission-mode-'

/**
 * 找到最近一次权限模式事务生成的备份。
 * @returns {Promise<string|null>}
 */
async function findLatestPermissionModeBackup() {
  try {
    const entries = await fs.readdir(CLAUDE_SETTINGS_BACKUP_DIR, { withFileTypes: true })
    const backups = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(PERMISSION_BACKUP_PREFIX) && entry.name.endsWith('.json'))
      .map((entry) => {
        const tail = entry.name.slice(PERMISSION_BACKUP_PREFIX.length, -'.json'.length)
        const match = tail.match(/^(.*Z)(?:-(\d+))?$/)
        return {
          name: entry.name,
          timestamp: match?.[1] || tail,
          collision: Number(match?.[2] || 0),
        }
      })
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.collision - left.collision)
    return backups[0] ? path.join(CLAUDE_SETTINGS_BACKUP_DIR, backups[0].name) : null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 把 broker 失败统一映射为权限页契约。
 * @param {Object} writeResult - broker 返回值
 * @returns {Object}
 */
function mapPermissionWriteFailure(writeResult) {
  const errorMap = {
    PERMISSION_DENIED: '权限被拒绝：无法写入 Claude settings.json',
    DISK_FULL: '磁盘空间不足，无法保存配置',
    WRITE_FAILED: `写入失败: ${writeResult.error}`,
    READ_FAILED: '无法读取 Claude settings.json，请检查权限',
  }
  return {
    success: false,
    error: errorMap[writeResult.errorCode] || writeResult.error || `写入失败: ${writeResult.errorCode}`,
    errorCode: writeResult.errorCode === 'READ_FAILED' ? 'READ_ERROR' : (writeResult.errorCode || 'WRITE_ERROR'),
    committed: writeResult.committed === true,
    durability: writeResult.durability || null,
  }
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
    const restoreAvailable = Boolean(await findLatestPermissionModeBackup())
    const exists = await pathExists(CLAUDE_SETTINGS_FILE_PATH)

    // 文件不存在：视为未配置
    if (!exists) {
      return {
        success: true,
        mode: null,
        isConfigured: false,
        isKnownMode: true,
        restoreAvailable,
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
        isKnownMode: true,
        restoreAvailable,
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
      restoreAvailable,
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
 * @param {string} mode - 权限模式（plan/default/acceptEdits/dontAsk/bypassPermissions/auto）
 * @param {(filepath: string) => Promise<boolean>} pathExists - 路径存在检查函数
 * @returns {Promise<{success: boolean, backupPath?: string, error?: string, errorCode?: string}>}
 */
async function setPermissionMode(mode, pathExists, options = {}) {
  // 验证模式有效性
  if (!VALID_PERMISSION_MODES.includes(mode)) {
    return {
      success: false,
      error: `无效的权限模式: ${mode}。支持的值: ${VALID_PERMISSION_MODES.join(', ')}`,
      errorCode: 'INVALID_MODE',
    }
  }

  // 单次事务：读、判断损坏/权限、改字段、备份、提交都在 broker 的同一队列任务内完成。
  // 因此不再依赖调用方预先读取的快照，也不会覆盖并发的 model / skillOverrides 改动。
  // 企业 / 组织级托管设置优先级高于用户配置：被覆盖时必须告知，不能谎报「已生效」
  let managedOverride = false
  let managedUnknown = false
  const writeResult = await mutateClaudeSettingsFile(({ data, kind, isManagedField, managedUnknown: unknown }) => {
    managedOverride = typeof isManagedField === 'function' && isManagedField('permissions.defaultMode')
    managedUnknown = unknown === true
    if (kind === 'corrupt') {
      // 历史行为：JSON 损坏时备份原文件后以空对象重建
      return { ok: true, next: { permissions: { defaultMode: mode } }, allowCorruptRepair: true }
    }
    // 读取层的 io_error / 权限 / 符号链接由 broker 提前定性返回，不会走到这里；
    // broker 码 → 业务码的映射统一放在下方。
    const next = { ...data }
    if (!next.permissions || typeof next.permissions !== 'object' || Array.isArray(next.permissions)) next.permissions = {}
    else next.permissions = { ...next.permissions }
    next.permissions.defaultMode = mode
    return { ok: true, next, create: true }
  }, { backupSuffix: 'permission-mode', managedPaths: options.managedPaths || null })

  if (!writeResult.success) {
    return mapPermissionWriteFailure(writeResult)
  }

  return {
    success: true,
    backupPath: writeResult.backupPath,
    error: null,
    errorCode: null,
    committed: writeResult.committed === true,
    durability: writeResult.durability || null,
    managedOverride,
    managedUnknown,
    managedNotice: managedOverride
      ? '该设置已被企业 / 组织托管配置覆盖，本次写入不会生效'
      : (managedUnknown ? '无法确认该设置是否被托管配置覆盖，实际生效未验证' : null),
  }
}

/**
 * 删除用户级 defaultMode，让 Claude 使用客户端默认行为。
 * @returns {Promise<Object>}
 */
async function resetPermissionMode(_pathExists, options = {}) {
  let managedOverride = false
  let managedUnknown = false
  const writeResult = await mutateClaudeSettingsFile(({ data, kind, isManagedField, managedUnknown: unknown }) => {
    managedOverride = typeof isManagedField === 'function' && isManagedField('permissions.defaultMode')
    managedUnknown = unknown === true
    if (kind === 'missing' || !Object.prototype.hasOwnProperty.call(data?.permissions || {}, 'defaultMode')) {
      return { ok: true, noop: true }
    }
    const next = { ...data }
    if (next.permissions && typeof next.permissions === 'object' && !Array.isArray(next.permissions)) {
      next.permissions = { ...next.permissions }
      delete next.permissions.defaultMode
      if (Object.keys(next.permissions).length === 0) delete next.permissions
    }
    return { ok: true, next }
  }, { backupSuffix: 'permission-mode', managedPaths: options.managedPaths || null })

  if (!writeResult.success) return mapPermissionWriteFailure(writeResult)
  return {
    success: true,
    mode: null,
    isConfigured: false,
    restoreAvailable: Boolean(writeResult.backupPath || await findLatestPermissionModeBackup()),
    backupPath: writeResult.backupPath,
    committed: writeResult.committed === true,
    durability: writeResult.durability || null,
    managedOverride,
    managedUnknown,
    managedNotice: managedOverride
      ? '该设置已被企业 / 组织托管配置覆盖，本次重置不会改变实际生效值'
      : (managedUnknown ? '无法确认该设置是否被托管配置覆盖，实际生效未验证' : null),
  }
}

/**
 * 从最近一次权限事务备份中恢复 defaultMode，只改这一字段。
 * @returns {Promise<Object>}
 */
async function restorePermissionMode(_pathExists, options = {}) {
  let restoreSourcePath
  let previousMode
  let managedOverride = false
  let managedUnknown = false
  const writeResult = await mutateClaudeSettingsFile(async ({ data, isManagedField, managedUnknown: unknown }) => {
    managedOverride = typeof isManagedField === 'function' && isManagedField('permissions.defaultMode')
    managedUnknown = unknown === true
    try {
      // 备份选择和读取必须与 settings 的读取、写回共用 broker 队列，避免并发 set
      // 在两者之间生成更新的备份，导致恢复过期历史。
      restoreSourcePath = await findLatestPermissionModeBackup()
      if (!restoreSourcePath) {
        return { ok: false, error: '没有可恢复的权限模式备份', errorCode: 'NO_BACKUP' }
      }
      const backupData = JSON.parse(await fs.readFile(restoreSourcePath, 'utf-8'))
      previousMode = backupData?.permissions?.defaultMode
      if (previousMode !== undefined && typeof previousMode !== 'string') {
        return { ok: false, error: '权限模式备份格式无效', errorCode: 'RESTORE_FAILED' }
      }
    } catch (error) {
      return { ok: false, error: `读取权限模式备份失败: ${error.message}`, errorCode: 'RESTORE_FAILED' }
    }

    const next = { ...data }
    if (previousMode === undefined) {
      if (next.permissions && typeof next.permissions === 'object' && !Array.isArray(next.permissions)) {
        next.permissions = { ...next.permissions }
        delete next.permissions.defaultMode
        if (Object.keys(next.permissions).length === 0) delete next.permissions
      }
    } else {
      next.permissions = next.permissions && typeof next.permissions === 'object' && !Array.isArray(next.permissions)
        ? { ...next.permissions, defaultMode: previousMode }
        : { defaultMode: previousMode }
    }
    return { ok: true, next, create: true }
  }, { backupSuffix: 'permission-mode', managedPaths: options.managedPaths || null })

  if (!writeResult.success) return mapPermissionWriteFailure(writeResult)
  return {
    success: true,
    mode: previousMode ?? null,
    isConfigured: typeof previousMode === 'string',
    isKnownMode: previousMode === undefined || VALID_PERMISSION_MODES.includes(previousMode),
    restoreAvailable: true,
    backupPath: writeResult.backupPath,
    committed: writeResult.committed === true,
    durability: writeResult.durability || null,
    managedOverride,
    managedUnknown,
    managedNotice: managedOverride
      ? '该设置已被企业 / 组织托管配置覆盖，本次恢复不会改变实际生效值'
      : (managedUnknown ? '无法确认该设置是否被托管配置覆盖，实际生效未验证' : null),
    restoreSourcePath,
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

  ipcMain.handle('reset-permission-mode', async () => resetPermissionMode(pathExists))
  ipcMain.handle('restore-permission-mode', async () => restorePermissionMode(pathExists))
}

module.exports = {
  registerPermissionModeHandlers,
  getPermissionModeConfig,
  setPermissionMode,
  resetPermissionMode,
  restorePermissionMode,
  VALID_PERMISSION_MODES,
  MODE_DISPLAY_NAMES,
  // 共享工具函数，供其他 settings 处理模块复用
  backupClaudeSettingsRaw,
  atomicWriteText,
  CLAUDE_SETTINGS_FILE_PATH,
  CLAUDE_SETTINGS_BACKUP_DIR,
}
