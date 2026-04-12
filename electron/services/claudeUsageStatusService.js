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
const MANAGED_STATUS_COMMAND = `bash "${STATUS_SCRIPT_PATH}"`
const LEGACY_MANAGED_STATUS_COMMAND = `bash ${STATUS_SCRIPT_PATH}`

// 脚本版本号：每次修改 buildStatusScriptContent() 时递增，
// 页面加载时自动检测版本不匹配就重写磁盘脚本。
const SCRIPT_VERSION = 3

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

/**
 * 构建状态栏脚本内容
 * @returns {string}
 */
function buildStatusScriptContent() {
  return `#!/usr/bin/env bash
# codepal-script-version: ${SCRIPT_VERSION}
# CodePal-managed Claude Code usage status line.
# Reads Claude Code's JSON stdin, writes a local snapshot, and prints
# a single status line based on the user's display mode.

input=$(cat)
CODEPAL_STATUS_PAYLOAD="$input" python3 - "${STATUS_CONFIG_PATH}" "${STATUS_SNAPSHOT_PATH}" <<'PY'
import json
import os
import sys
import tempfile
import time
from datetime import datetime

RESET = "\\033[0m"
DIM = "\\033[2m"
BOLD = "\\033[1m"
GREEN = "\\033[32m"
YELLOW = "\\033[33m"
RED = "\\033[31m"

DEFAULT_CONFIG = {
    "displayMode": "always",
    "fiveHourThreshold": 70,
    "sevenDayThreshold": 70,
}

config_path = sys.argv[1]
snapshot_path = sys.argv[2]
payload_raw = os.environ.get("CODEPAL_STATUS_PAYLOAD", "")

try:
    payload = json.loads(payload_raw) if payload_raw else {}
except Exception:
    payload = {}

def is_plain_object(value):
    return isinstance(value, dict)

def normalize_threshold(value, fallback):
    try:
        parsed = round(float(value))
    except Exception:
        return fallback
    return max(0, min(100, parsed))

def load_config():
    if not os.path.exists(config_path):
        return dict(DEFAULT_CONFIG)
    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return dict(DEFAULT_CONFIG)
    if not is_plain_object(data):
        return dict(DEFAULT_CONFIG)
    display_mode = data.get("displayMode")
    if display_mode not in ("always", "threshold", "off"):
        display_mode = DEFAULT_CONFIG["displayMode"]
    return {
        "displayMode": display_mode,
        "fiveHourThreshold": normalize_threshold(data.get("fiveHourThreshold"), DEFAULT_CONFIG["fiveHourThreshold"]),
        "sevenDayThreshold": normalize_threshold(data.get("sevenDayThreshold"), DEFAULT_CONFIG["sevenDayThreshold"]),
    }

def get_value(source, *keys, default=None):
    current = source
    for key in keys:
        if not is_plain_object(current):
            return default
        current = current.get(key)
        if current is None:
            return default
    return current

def color_pct(value):
    try:
        pct = float(value)
    except Exception:
        return f"{DIM}--{RESET}"
    color = GREEN if pct < 60 else YELLOW if pct < 85 else RED
    return f"{color}{pct:.0f}%{RESET}"

def should_render(config, five_pct, week_pct):
    if config["displayMode"] == "off":
        return False
    if config["displayMode"] == "always":
        return True
    try:
        five_match = five_pct is not None and float(five_pct) >= config["fiveHourThreshold"]
    except Exception:
        five_match = False
    try:
        week_match = week_pct is not None and float(week_pct) >= config["sevenDayThreshold"]
    except Exception:
        week_match = False
    return five_match or week_match

def write_snapshot(snapshot):
    directory = os.path.dirname(snapshot_path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix="codepal-usage-status-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, indent=2)
            handle.write("\\n")
        os.replace(tmp_path, snapshot_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

config = load_config()
model = get_value(payload, "model", "display_name", default="Claude Code")
five_pct = get_value(payload, "rate_limits", "five_hour", "used_percentage")
week_pct = get_value(payload, "rate_limits", "seven_day", "used_percentage")
resets_at = get_value(payload, "rate_limits", "five_hour", "resets_at")
week_resets_at = get_value(payload, "rate_limits", "seven_day", "resets_at")

# 初次启动：payload 里没有 rate_limits 字段，说明还没产生过真实 API 响应，
# 不写快照、不输出状态行，静默退出等待首次对话。
if "rate_limits" not in payload and five_pct is None and week_pct is None:
    raise SystemExit(0)

snapshot = {
    "source": "codepal-claude-statusline",
    "modelDisplayName": model,
    "fiveHourUsedPercentage": five_pct,
    "sevenDayUsedPercentage": week_pct,
    "resetsAt": resets_at,
    "sevenDayResetsAt": week_resets_at,
    "displayMode": config["displayMode"],
    "fiveHourThreshold": config["fiveHourThreshold"],
    "sevenDayThreshold": config["sevenDayThreshold"],
    "hasRateLimits": five_pct is not None or week_pct is not None,
    "updatedAt": int(time.time()),
}
write_snapshot(snapshot)

if not should_render(config, five_pct, week_pct):
    raise SystemExit(0)

sep = f"{DIM} | {RESET}"
line = f"{BOLD}{model}{RESET}"

if five_pct is None and week_pct is None:
    # v1.3.4: 针对非 Max 订阅 / 第三方后端 的账号(payload 里没有 rate_limits 字段),
    # 输出明确提示替代原来的 "usage data pending",避免用户误以为是 bug。
    # 前端通过 snapshot.updatedAt 做同样的"首次等待 vs 账号无数据"区分。
    print(f"{line}{sep}{YELLOW}no rate limits{RESET}{DIM} (非 Max 订阅或第三方后端){RESET}")
    raise SystemExit(0)

parts = []
parts.append(f"5h:{color_pct(five_pct)}" if five_pct is not None else f"{DIM}5h:--{RESET}")
parts.append(f"7d:{color_pct(week_pct)}" if week_pct is not None else f"{DIM}7d:--{RESET}")

if resets_at is not None:
    try:
        reset_dt = datetime.fromtimestamp(int(resets_at))
        now_dt = datetime.now()
        remaining_seconds = max(0, int((reset_dt - now_dt).total_seconds()))
        hours, remainder = divmod(remaining_seconds, 3600)
        minutes = remainder // 60
        reset_local = reset_dt.strftime("%H:%M")
        if hours > 0:
            reset_display = f"in {hours}h {minutes:02d}m"
        else:
            reset_display = f"in {minutes}m"
        parts.append(f"{DIM}resets {reset_display} ({reset_local}){RESET}")
    except Exception:
        pass

print(f"{line}{sep}" + f"{sep}".join(parts))
PY
`
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
  createClaudeUsageStatusService,
}
