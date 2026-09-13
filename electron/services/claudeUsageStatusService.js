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
// 服务层不再反向依赖 handler 层：atomicWriteText 用于脚本/config 等非 settings 文件（settings 写走注入的 claudeSettingsService）
const { atomicWriteText } = require('./envFileService')

const execFileAsync = promisify(execFile)

/**
 * 构造"检测到用户自定义状态栏、取消静默维护"的统一结果
 *
 * 预读与事务内两处都要用同一形状返回，抽出来避免两处漂移。
 * @param {object} currentState - 当前状态快照
 * @param {{usesManagedStatusLine: boolean, hasCustomStatusLine: boolean}} ownership - 所有权判定
 * @returns {object}
 */
function buildOwnershipConflictResult(currentState, ownership) {
  return {
    ...currentState,
    success: true,
    integrationState: 'conflict',
    message: '检测到用户已更改 Claude 状态栏，CodePal 已取消本次静默维护。',
    ...ownership,
  }
}

const CLAUDE_DIR = path.join(os.homedir(), '.claude')
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json')
const STATUS_SCRIPT_PATH = path.join(CLAUDE_DIR, 'codepal-usage-statusline.sh')
const STATUS_CONFIG_PATH = path.join(CLAUDE_DIR, 'codepal-usage-status-config.json')
const STATUS_SNAPSHOT_PATH = path.join(CLAUDE_DIR, 'codepal-usage-status-snapshot.json')
const MANAGED_STATUS_COMMAND = `bash "${STATUS_SCRIPT_PATH}"`
const LEGACY_MANAGED_STATUS_COMMAND = `bash ${STATUS_SCRIPT_PATH}`

// 脚本版本号：每次修改 buildStatusScriptContent() 时递增，
// 页面加载时自动检测版本不匹配就重写磁盘脚本。
// v4: 新增 7d 周期历史追踪（update_history 逻辑）
// v5: 新增当前上下文占用指示（bar + 百分比，默认开启不加配置）
// v6: update_history 区分异常跳变（Anthropic provider_reset）与正常周期完成
// v7: 新增第二行 Git 信息（git:<分支>@<最近tag><脏标记>），与额度第一行耦合
// v8: 下线满载率趋势，不再采集或写入 7d 周期历史
// v9: 上下文窗口改用 statusLine payload 的 context_window 权威字段，
//     原生 1M 模型（Opus 5 等）不再被按 200k 误算；transcript + 模型名启发式降为回退
const SCRIPT_VERSION = 9

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
 * 用于脚本版本占位符，确保任何意外非数字不会让脚本版本判断失效。
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
  async function computeUsageStatusState() {
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
   * 读取会员额度状态（在原始状态上附加托管事实）
   *
   * 托管事实必须随状态一起返回：否则"已接入"的 UI 提示在刷新后会消失，
   * 用户会以为 CodePal 的设置真的生效了。
   * @returns {Promise<object>}
   */
  async function getUsageStatusState() {
    const state = await computeUsageStatusState()
    const managedInfo = claudeSettingsService.readManagedSettings
      ? await claudeSettingsService.readManagedSettings()
      : { data: null, unknown: false }
    const managedOverride = claudeSettingsService.isManagedField
      ? claudeSettingsService.isManagedField(managedInfo.data, 'statusLine')
      : false
    const managedUnknown = managedInfo.unknown === true
    return {
      ...state,
      managedOverride,
      managedUnknown,
      managedNotice: managedOverride
        ? '该状态栏已被企业 / 组织托管配置覆盖，CodePal 的设置实际不会生效'
        : (managedUnknown ? '无法确认该状态栏是否被托管配置覆盖，实际生效未验证' : null),
    }
  }

  /**
   * 安装或修复 CodePal 管理的 statusLine
   *
   * `intent` 区分两种来源，二者对"文件不存在"的权限不同：
   * - `'silent'`（默认，启动维护 / 脚本静默升级）：**只维护已存在且仍归 CodePal 管的文件**，
   *   绝不在文件不存在时把它建出来——用户删掉 settings.json 就是撤销配置，不得复活。
   * - `'explicit'`（用户点击「立即接入」/「接管」）：允许创建。
   *
   * @param {{force?: boolean, intent?: 'silent'|'explicit'}} [options] - 安装选项
   * @returns {Promise<object>}
   */
  async function ensureUsageStatusInstalled(options = {}) {
    const { force = false, intent = 'silent' } = options
    const allowCreate = intent === 'explicit'

    // 配置根不支持时必须在**任何副作用之前**拒绝：
    // 否则脚本 / config 已经落盘，settings 才被拒，会留下半完成状态。
    const unsupportedRoot = claudeSettingsService.detectUnsupportedCustomRoot
      ? claudeSettingsService.detectUnsupportedCustomRoot()
      : null
    if (unsupportedRoot) {
      return {
        success: false,
        integrationState: 'setup_failed',
        error: unsupportedRoot.error,
        errorCode: unsupportedRoot.errorCode,
      }
    }

    const currentState = await getUsageStatusState()

    if (!currentState.claudeInstalled) {
      return currentState
    }

    if (currentState.hasCustomStatusLine && !force) {
      return currentState
    }

    // 预读仅用于尽早提示；**最终决定以事务内检查为准**（见下方 mutator）。
    // 预读与事务读之间用户仍可能改写 statusLine，所以这里不能作为唯一依据。
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
    const latestOwnership = detectStatusLineOwnership(settingsData)
    if (!force && latestOwnership.hasCustomStatusLine) {
      return buildOwnershipConflictResult(currentState, latestOwnership)
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

    // settings 写必须保持在脚本落盘 + chmod 之后（statusLine.command 指向的脚本先就位）。
    // 走事务入口：所有权检查在 mutator 内基于**事务内最新** settings 重新判定，
    // 因此"预读认为可接管、随后用户改成自定义 statusLine"的窗口被关闭。
    // 拒绝时把**事务内实际看到的所有权事实**带出来给 UI——不再用调用方读去重读，
    // 那样等于让呈现又回到可能过时的路径上。
    let ownershipAtCommit = null
    let managedOverride = false
    let managedUnknown = false
    const settingsWriteResult = await claudeSettingsService.mutateClaudeSettingsFile(({ data, kind, isManagedField, managedUnknown: unknown }) => {
      managedOverride = typeof isManagedField === 'function' && isManagedField('statusLine')
      managedUnknown = unknown === true
      if (kind === 'corrupt') {
        return { ok: false, errorCode: 'CONFIG_CORRUPTED', error: 'Claude settings.json 已损坏' }
      }
      // 静默维护不得从"文件不存在"创建：用户删除 settings.json 即表示撤销配置。
      // 只有用户显式接入（intent='explicit'）才允许创建。读取层的其他失败由 broker 提前返回。
      if (kind === 'missing' && !allowCreate) {
        return { ok: false, errorCode: 'USAGE_STATUS_SILENT_NO_CREATE', error: 'settings.json 不存在，静默维护不创建' }
      }
      const ownership = detectStatusLineOwnership(data)
      ownershipAtCommit = ownership
      if (!force && ownership.hasCustomStatusLine) {
        // 事务内复判：用户已改为自定义状态栏 → 取消本次静默维护，绝不覆盖
        return { ok: false, errorCode: 'USAGE_STATUS_OWNERSHIP_CONFLICT', error: '检测到用户已更改 Claude 状态栏' }
      }
      // 静默维护只作用于「当前确实由 CodePal 托管」的状态栏：
      // 用户只删掉 statusLine 字段（或留空对象）同样是撤销配置，不得借静默维护写回去。
      // force=true 是"用户在二次确认弹窗里同意接管"的显式路径，不受此限。
      if (!force && !allowCreate && !ownership.usesManagedStatusLine) {
        return { ok: false, errorCode: 'USAGE_STATUS_NOT_MANAGED', error: '静默维护仅作用于已由 CodePal 托管的状态栏' }
      }
      const next = { ...data, statusLine: { type: 'command', command: MANAGED_STATUS_COMMAND } }
      return { ok: true, next, create: allowCreate }
    }, { backupSuffix: 'codepal-usage-status' })

    if (!settingsWriteResult.success) {
      if (settingsWriteResult.errorCode === 'USAGE_STATUS_SILENT_NO_CREATE'
        || settingsWriteResult.errorCode === 'USAGE_STATUS_NOT_MANAGED') {
        // 不是错误：文件不存在 / 已被用户撤销接入。如实返回未接入状态，不写回。
        return getUsageStatusState()
      }
      if (settingsWriteResult.errorCode === 'USAGE_STATUS_OWNERSHIP_CONFLICT') {
        // 权威事实来自事务读；ownershipAtCommit 为 null 说明是异常路径，按"自定义"保守呈现
        return buildOwnershipConflictResult(
          currentState,
          ownershipAtCommit || { usesManagedStatusLine: false, hasCustomStatusLine: true },
        )
      }
      return {
        success: false,
        integrationState: 'setup_failed',
        error: `写入 Claude settings 失败: ${settingsWriteResult.error}`,
        errorCode: settingsWriteResult.errorCode || 'WRITE_FAILED',
        // 已提交但校验/持久化未达成的状态必须上报，调用方不能当成"完全没写"
        committed: settingsWriteResult.committed === true,
        durability: settingsWriteResult.durability || null,
      }
    }

    // 托管配置优先级更高：写入成功也可能不生效，必须如实带上，UI 不得宣称已接入
    const finalState = await getUsageStatusState()
    return {
      ...finalState,
      committed: settingsWriteResult.committed === true,
      durability: settingsWriteResult.durability || null,
      managedOverride,
      managedUnknown,
      managedNotice: managedOverride
        ? '该状态栏已被企业 / 组织托管配置覆盖，本次接入实际不会生效'
        : (managedUnknown ? '无法确认该状态栏是否被托管配置覆盖，实际生效未验证' : null),
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
    managedCommand: MANAGED_STATUS_COMMAND,
    defaultConfig: DEFAULT_STATUS_CONFIG,
    validDisplayModes: VALID_DISPLAY_MODES,
    getUsageStatusState,
    ensureUsageStatusInstalled,
    saveUsageStatusConfig,
  }
}

module.exports = {
  CLAUDE_DIR,
  CLAUDE_SETTINGS_PATH,
  STATUS_SCRIPT_PATH,
  STATUS_CONFIG_PATH,
  STATUS_SNAPSHOT_PATH,
  MANAGED_STATUS_COMMAND,
  LEGACY_MANAGED_STATUS_COMMAND,
  DEFAULT_STATUS_CONFIG,
  VALID_DISPLAY_MODES,
  SCRIPT_VERSION,
  normalizeStatusConfig,
  buildStatusScriptContent,
  createClaudeUsageStatusService,
}
