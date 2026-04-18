/**
 * Claude Code 会员额度状态服务
 *
 * 负责：
 * - 检测本机是否安装 Claude Code
 * - 安装/修复 CodePal 管理的 Claude statusLine 配置
 * - 读写会员额度显示配置与本地快照
 * - 汇总前端展示所需的接入状态
 *
 * @module electron/services/claudeUsageStatusService
 */

const fs = require('fs/promises')
const { readFileSync } = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { backupClaudeSettingsRaw, atomicWriteText } = require('../handlers/permissionModeHandlers')

const execFileAsync = promisify(execFile)

const CLAUDE_DIR = path.join(os.homedir(), '.claude')
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json')
const STATUS_SCRIPT_PATH = path.join(CLAUDE_DIR, 'codepal-usage-statusline.sh')
const STATUS_CONFIG_PATH = path.join(CLAUDE_DIR, 'codepal-usage-status-config.json')
const STATUS_SNAPSHOT_PATH = path.join(CLAUDE_DIR, 'codepal-usage-status-snapshot.json')
// v1.4.1: 满载率趋势历史文件 — statusLine 脚本每次运行时更新，追踪 7d 周期峰值
const STATUS_HISTORY_PATH = path.join(CLAUDE_DIR, 'codepal-usage-history.json')
const MANAGED_STATUS_COMMAND = `bash "${STATUS_SCRIPT_PATH}"`
const LEGACY_MANAGED_STATUS_COMMAND = `bash ${STATUS_SCRIPT_PATH}`

// 脚本版本号：每次修改 buildStatusScriptContent() 时递增，
// 页面加载时自动检测版本不匹配就重写磁盘脚本。
// v4: 新增 7d 周期历史追踪（update_history 逻辑）
// v5: 新增当前上下文占用指示（bar + 百分比，默认开启不加配置）
// v6: update_history 区分异常跳变（Anthropic provider_reset）与正常周期完成
const SCRIPT_VERSION = 6

// v1.4.1: 满载率趋势最多保留的已完成周期数（约 3 个月）
const MAX_COMPLETED_CYCLES = 13

const VALID_DISPLAY_MODES = ['always', 'threshold', 'off']
const DEFAULT_STATUS_CONFIG = Object.freeze({
  displayMode: 'always',
  fiveHourThreshold: 70,
  sevenDayThreshold: 70,
})

/**
 * 判断是否为普通对象
 * @param {unknown} value - 待判断值
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 规范化阈值输入
 * @param {unknown} value - 原始值
 * @param {number} fallback - 默认值
 * @returns {number}
 */
function normalizeThreshold(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(100, Math.round(parsed)))
}

/**
 * 合并并校正显示配置
 * @param {unknown} source - 原始配置
 * @returns {{displayMode: 'always'|'threshold'|'off', fiveHourThreshold: number, sevenDayThreshold: number}}
 */
function normalizeStatusConfig(source) {
  const data = isPlainObject(source) ? source : {}
  const displayMode = VALID_DISPLAY_MODES.includes(data.displayMode)
    ? data.displayMode
    : DEFAULT_STATUS_CONFIG.displayMode

  return {
    displayMode,
    fiveHourThreshold: normalizeThreshold(data.fiveHourThreshold, DEFAULT_STATUS_CONFIG.fiveHourThreshold),
    sevenDayThreshold: normalizeThreshold(data.sevenDayThreshold, DEFAULT_STATUS_CONFIG.sevenDayThreshold),
  }
}

// v5: Python 模板抽离为独立文件。模块加载时一次性读入，避免每次构建脚本都做磁盘 IO。
// 占位符采用 __SNAKE_CASE__ 形式，不会与 bash / Python 语法冲突。
const SCRIPT_TEMPLATE_PATH = path.join(__dirname, 'claudeUsageStatusScript.tpl')
const SCRIPT_TEMPLATE = readFileSync(SCRIPT_TEMPLATE_PATH, 'utf-8')

/**
 * 转义路径，用于嵌入 bash 双引号字符串。
 * 防御极罕见但合法的家目录路径字符：反斜杠 / 双引号 / $（bash 变量展开）/ 反引号（命令替换）。
 * @param {string} value - 原始路径
 * @returns {string} 转义后可安全放入 "..." 的字符串
 */
function escapeForBashDoubleQuote(value) {
  return String(value).replace(/([\\$"`])/g, '\\$1')
}

/**
 * 把任意值强制规范为正整数字符串；无效值回退到 fallback。
 * 用于 Python 代码位置的占位符（`MAX_COMPLETED_CYCLES = __X__`），
 * 确保任何意外非数字不会让 Python 源码语法直接崩掉。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {string}
 */
function toIntegerString(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isInteger(n) && n > 0 ? String(n) : String(fallback)
}

/**
 * 构建状态栏脚本内容
 * @returns {string} 完全渲染后的 bash+Python 脚本
 */
function buildStatusScriptContent() {
  return SCRIPT_TEMPLATE
    .replace(/__SCRIPT_VERSION__/g, () => toIntegerString(SCRIPT_VERSION, 0))
    .replace(/__CONFIG_PATH__/g, () => escapeForBashDoubleQuote(STATUS_CONFIG_PATH))
    .replace(/__SNAPSHOT_PATH__/g, () => escapeForBashDoubleQuote(STATUS_SNAPSHOT_PATH))
    .replace(/__HISTORY_PATH__/g, () => escapeForBashDoubleQuote(STATUS_HISTORY_PATH))
    .replace(/__MAX_COMPLETED_CYCLES__/g, () => toIntegerString(MAX_COMPLETED_CYCLES, 13))
}

/**
 * 创建 Claude 会员额度状态服务
 * @param {Object} deps - 依赖注入
 * @param {(filepath: string) => Promise<boolean>} deps.pathExists - 路径存在检查
 * @param {Object} deps.claudeSettingsService - Claude settings 服务
 * @returns {Object}
 */
function createClaudeUsageStatusService({ pathExists, claudeSettingsService }) {
  /**
   * 读取 JSON 文件并兜底默认值
   * @param {string} filePath - 文件路径
   * @param {unknown} fallback - 回退值
   * @returns {Promise<unknown>}
   */
  async function readJsonFile(filePath, fallback) {
    try {
      if (!(await pathExists(filePath))) return fallback
      const content = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(content)
    } catch {
      return fallback
    }
  }

  /**
   * 原子写入 JSON 文件
   * @param {string} filePath - 文件路径
   * @param {object} data - 数据对象
   * @returns {Promise<{success: boolean, errorCode: string|null, error: string|null}>}
   */
  async function writeJsonFile(filePath, data) {
    const content = `${JSON.stringify(data, null, 2)}\n`
    const writeResult = await atomicWriteText(filePath, content)
    return {
      success: writeResult.success,
      errorCode: writeResult.success ? null : writeResult.error || 'WRITE_FAILED',
      error: writeResult.success ? null : writeResult.error || '写入失败',
    }
  }

  /**
   * 检测本机是否安装了 Claude 命令
   * @returns {Promise<boolean>}
   */
  async function isClaudeCommandAvailable() {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('where', ['claude'])
      } else {
        await execFileAsync('/bin/bash', ['-lc', 'command -v claude'])
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * 读取本地配置
   * @returns {Promise<{config: object, exists: boolean}>}
   */
  async function readStatusConfig() {
    const exists = await pathExists(STATUS_CONFIG_PATH)
    const raw = await readJsonFile(STATUS_CONFIG_PATH, DEFAULT_STATUS_CONFIG)
    return {
      config: normalizeStatusConfig(raw),
      exists,
    }
  }

  /**
   * 读取本地快照
   * @returns {Promise<{snapshot: object|null, exists: boolean}>}
   */
  async function readStatusSnapshot() {
    const exists = await pathExists(STATUS_SNAPSHOT_PATH)
    const raw = await readJsonFile(STATUS_SNAPSHOT_PATH, null)
    return {
      snapshot: isPlainObject(raw) ? raw : null,
      exists,
    }
  }

  /**
   * 判断当前 settings 是否已由 CodePal 管理
   * @param {object} settingsData - settings.json 对象
   * @returns {{usesManagedStatusLine: boolean, hasCustomStatusLine: boolean}}
   */
  function detectStatusLineOwnership(settingsData) {
    const statusLine = isPlainObject(settingsData?.statusLine) ? settingsData.statusLine : null
    const command = typeof statusLine?.command === 'string' ? statusLine.command.trim() : ''
    return {
      usesManagedStatusLine: command === MANAGED_STATUS_COMMAND || command === LEGACY_MANAGED_STATUS_COMMAND,
      hasCustomStatusLine: Boolean(command) && command !== MANAGED_STATUS_COMMAND && command !== LEGACY_MANAGED_STATUS_COMMAND,
    }
  }

  /**
   * 读取磁盘脚本的版本号
   * @returns {Promise<number>} 版本号，读取失败返回 0
   */
  async function readDeployedScriptVersion() {
    try {
      const content = await fs.readFile(STATUS_SCRIPT_PATH, 'utf-8')
      const match = content.match(/^# codepal-script-version:\s*(\d+)/m)
      return match ? parseInt(match[1], 10) : 1
    } catch {
      return 0
    }
  }

  /**
   * 汇总前端展示所需状态
   * @returns {Promise<object>}
   */
  async function getUsageStatusState() {
    const claudeCommandAvailable = await isClaudeCommandAvailable()
    const claudeDirExists = await pathExists(CLAUDE_DIR)
    const claudeInstalled = claudeCommandAvailable || claudeDirExists

    const { config } = await readStatusConfig()
    const { snapshot } = await readStatusSnapshot()

    if (!claudeInstalled) {
      return {
        success: true,
        claudeInstalled: false,
        integrationState: 'not_installed',
        message: '未检测到 Claude Code，可安装后重新接入。',
        config,
        snapshot: null,
        usesManagedStatusLine: false,
        hasCustomStatusLine: false,
        settingsPath: CLAUDE_SETTINGS_PATH,
        scriptPath: STATUS_SCRIPT_PATH,
        configPath: STATUS_CONFIG_PATH,
        snapshotPath: STATUS_SNAPSHOT_PATH,
      }
    }

    const settingsReadResult = await claudeSettingsService.readClaudeSettingsFile()
    const settingsData = settingsReadResult.success ? settingsReadResult.data : {}
    const ownership = detectStatusLineOwnership(settingsData)

    if (ownership.hasCustomStatusLine) {
      return {
        success: true,
        claudeInstalled: true,
        integrationState: 'conflict',
        message: '检测到用户已有自定义 Claude 状态栏，CodePal 暂不自动覆盖。',
        config,
        snapshot,
        settingsPath: CLAUDE_SETTINGS_PATH,
        scriptPath: STATUS_SCRIPT_PATH,
        configPath: STATUS_CONFIG_PATH,
        snapshotPath: STATUS_SNAPSHOT_PATH,
        ...ownership,
      }
    }

    const scriptExists = await pathExists(STATUS_SCRIPT_PATH)
    const installed = ownership.usesManagedStatusLine && scriptExists

    if (!installed) {
      return {
        success: true,
        claudeInstalled: true,
        integrationState: 'not_configured',
        message: 'Claude Code 已安装，但尚未接入会员额度状态。',
        config,
        snapshot,
        scriptOutdated: false,
        settingsPath: CLAUDE_SETTINGS_PATH,
        scriptPath: STATUS_SCRIPT_PATH,
        configPath: STATUS_CONFIG_PATH,
        snapshotPath: STATUS_SNAPSHOT_PATH,
        ...ownership,
      }
    }

    // 检测磁盘脚本版本，落后于当前代码版本时标记为过期
    const deployedVersion = await readDeployedScriptVersion()
    const scriptOutdated = deployedVersion < SCRIPT_VERSION

    if (!snapshot?.hasRateLimits) {
      return {
        success: true,
        claudeInstalled: true,
        integrationState: 'waiting_for_data',
        message: '已接入，等待 Claude Code 返回首个额度快照。',
        config,
        snapshot,
        scriptOutdated,
        settingsPath: CLAUDE_SETTINGS_PATH,
        scriptPath: STATUS_SCRIPT_PATH,
        configPath: STATUS_CONFIG_PATH,
        snapshotPath: STATUS_SNAPSHOT_PATH,
        ...ownership,
      }
    }

    return {
      success: true,
      claudeInstalled: true,
      integrationState: 'ready',
      message: 'Claude Code 会员额度状态已接入。',
      config,
      snapshot,
      scriptOutdated,
      settingsPath: CLAUDE_SETTINGS_PATH,
      scriptPath: STATUS_SCRIPT_PATH,
      configPath: STATUS_CONFIG_PATH,
      snapshotPath: STATUS_SNAPSHOT_PATH,
      ...ownership,
    }
  }

  /**
   * 安装或修复 CodePal 管理的 statusLine
   * @param {{force?: boolean}} [options] - 安装选项
   * @returns {Promise<object>}
   */
  async function ensureUsageStatusInstalled(options = {}) {
    const { force = false } = options
    const currentState = await getUsageStatusState()

    if (!currentState.claudeInstalled) {
      return currentState
    }

    if (currentState.hasCustomStatusLine && !force) {
      return currentState
    }

    const settingsReadResult = await claudeSettingsService.readClaudeSettingsFile()
    if (!settingsReadResult.success && settingsReadResult.errorCode !== 'CONFIG_CORRUPTED') {
      return {
        success: false,
        integrationState: 'setup_failed',
        error: settingsReadResult.error || '读取 Claude settings 失败',
        errorCode: settingsReadResult.errorCode || 'READ_FAILED',
      }
    }

    const settingsData = isPlainObject(settingsReadResult.data) ? settingsReadResult.data : {}
    const nextSettings = JSON.parse(JSON.stringify(settingsData))
    nextSettings.statusLine = {
      type: 'command',
      command: MANAGED_STATUS_COMMAND,
    }

    const { config } = await readStatusConfig()
    const configWriteResult = await writeJsonFile(STATUS_CONFIG_PATH, config)
    if (!configWriteResult.success) {
      return {
        success: false,
        integrationState: 'setup_failed',
        error: `写入 Claude 额度配置失败: ${configWriteResult.error}`,
        errorCode: configWriteResult.errorCode,
      }
    }

    const scriptWriteResult = await atomicWriteText(STATUS_SCRIPT_PATH, buildStatusScriptContent())
    if (!scriptWriteResult.success) {
      return {
        success: false,
        integrationState: 'setup_failed',
        error: `写入 Claude 状态栏脚本失败: ${scriptWriteResult.error}`,
        errorCode: scriptWriteResult.error || 'WRITE_FAILED',
      }
    }

    try {
      await fs.chmod(STATUS_SCRIPT_PATH, 0o700)
    } catch (error) {
      return {
        success: false,
        integrationState: 'setup_failed',
        error: `设置状态栏脚本权限失败: ${error.message}`,
        errorCode: 'CHMOD_FAILED',
      }
    }

    if (settingsReadResult.exists && settingsReadResult.content) {
      const backupResult = await backupClaudeSettingsRaw(settingsReadResult.content, 'codepal-usage-status')
      if (!backupResult.success) {
        return {
          success: false,
          integrationState: 'setup_failed',
          error: backupResult.error || '备份 Claude settings 失败',
          errorCode: backupResult.errorCode || 'BACKUP_FAILED',
        }
      }
    }

    const settingsWriteResult = await atomicWriteText(CLAUDE_SETTINGS_PATH, `${JSON.stringify(nextSettings, null, 2)}\n`)
    if (!settingsWriteResult.success) {
      return {
        success: false,
        integrationState: 'setup_failed',
        error: `写入 Claude settings 失败: ${settingsWriteResult.error}`,
        errorCode: settingsWriteResult.error || 'WRITE_FAILED',
      }
    }

    return getUsageStatusState()
  }

  /**
   * 读取 7d 周期满载率历史（供前端满载率趋势卡渲染）
   *
   * 返回结构：
   *   {
   *     success: true,
   *     exists: boolean,              // 历史文件是否存在
   *     currentCycle: object|null,    // 当前进行中周期
   *     completedCycles: Array,       // 已完成周期，最新在前
   *   }
   *
   * 文件损坏 / 解析失败时按"空数据"处理，返回 success=true 但 exists=false，
   * 避免阻塞前端渲染（趋势是次要信息，不能因为历史文件坏了把主页面卡住）
   *
   * @returns {Promise<object>}
   */
  async function getUsageHistory() {
    const exists = await pathExists(STATUS_HISTORY_PATH)
    if (!exists) {
      return {
        success: true,
        exists: false,
        currentCycle: null,
        completedCycles: [],
      }
    }

    const raw = await readJsonFile(STATUS_HISTORY_PATH, null)
    if (!isPlainObject(raw)) {
      return {
        success: true,
        exists: true,
        currentCycle: null,
        completedCycles: [],
      }
    }

    const currentCycle = isPlainObject(raw.currentCycle) ? raw.currentCycle : null
    const completedCycles = Array.isArray(raw.completedCycles)
      ? raw.completedCycles.filter((item) => isPlainObject(item))
      : []

    return {
      success: true,
      exists: true,
      currentCycle,
      completedCycles,
    }
  }

  /**
   * 保存会员额度状态配置
   * @param {object} configInput - 用户配置
   * @returns {Promise<object>}
   */
  async function saveUsageStatusConfig(configInput) {
    const config = normalizeStatusConfig(configInput)
    const writeResult = await writeJsonFile(STATUS_CONFIG_PATH, config)
    if (!writeResult.success) {
      return {
        success: false,
        error: `保存额度显示配置失败: ${writeResult.error}`,
        errorCode: writeResult.errorCode,
      }
    }

    return getUsageStatusState()
  }

  return {
    claudeDirPath: CLAUDE_DIR,
    settingsPath: CLAUDE_SETTINGS_PATH,
    scriptPath: STATUS_SCRIPT_PATH,
    configPath: STATUS_CONFIG_PATH,
    snapshotPath: STATUS_SNAPSHOT_PATH,
    historyPath: STATUS_HISTORY_PATH,
    managedCommand: MANAGED_STATUS_COMMAND,
    defaultConfig: DEFAULT_STATUS_CONFIG,
    validDisplayModes: VALID_DISPLAY_MODES,
    getUsageStatusState,
    ensureUsageStatusInstalled,
    saveUsageStatusConfig,
    getUsageHistory,
  }
}

module.exports = {
  CLAUDE_DIR,
  CLAUDE_SETTINGS_PATH,
  STATUS_SCRIPT_PATH,
  STATUS_CONFIG_PATH,
  STATUS_SNAPSHOT_PATH,
  STATUS_HISTORY_PATH,
  MANAGED_STATUS_COMMAND,
  LEGACY_MANAGED_STATUS_COMMAND,
  DEFAULT_STATUS_CONFIG,
  VALID_DISPLAY_MODES,
  SCRIPT_VERSION,
  MAX_COMPLETED_CYCLES,
  normalizeStatusConfig,
  createClaudeUsageStatusService,
}
