/**
 * K28 状态灯服务
 *
 * 负责：
 * - 读取和保存全局 K28 状态灯配置
 * - 返回脱敏后的运行状态、活跃 session 和日志摘要
 * - 调用现有 K28 脚本执行语音测试、灯色测试和状态清理
 *
 * @module electron/services/k28StatusLightService
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { getK28AudioState } = require('./k28AudioGuardService')
// settings.json 写入统一走唯一 broker（V1.9.8 收口）；本模块局部 atomicWriteText 仅用于 Codex config / K28 conf
const { mutateClaudeSettingsFile, detectUnsupportedCustomRoot } = require('./claudeSettingsService')

const K28_DIR = path.join(os.homedir(), '.claude', 'k28-status-light')
const K28_TEMPLATE_DIR = path.resolve(__dirname, '..', '..', 'templates', 'k28-status-light')
const K28_CONF_PATH = path.join(K28_DIR, 'tts.conf')
const K28_STATES_DIR = path.join(K28_DIR, 'states')
const K28_TTS_LOG_PATH = path.join(K28_DIR, 'tts-debug.log')
const K28_CODEX_LOG_PATH = path.join(K28_DIR, 'codex-debug.log')
const K28_STATUS_SCRIPT = path.join(K28_DIR, 'k28_status.sh')
const K28_SET_SCRIPT = path.join(K28_DIR, 'k28_set.py')
const K28_TTS_SCRIPT = path.join(K28_DIR, 'tts_say.py')
const K28_RENDER_SCRIPT = path.join(K28_DIR, 'k28_render.py')
const K28_CODEX_NOTIFY_SCRIPT = path.join(K28_DIR, 'codex-notify.sh')
const K28_PYTHON = path.join(K28_DIR, '.venv', 'bin', 'python')
const K28_BACKUP_DIR = path.join(K28_DIR, 'backups')

const DEFAULT_CONFIG = Object.freeze({
  STATUS_LIGHT_ENABLED: '1',
  VOICE_ENABLED: '1',
  VOLC_API_KEY: '',
  VOLC_SPEAKER: 'zh_female_roumeinvyou_emo_v2_mars_bigtts',
  VOLC_RESOURCE_ID: 'seed-tts-1.0',
  VOLC_SPEED: '1.0',
  TTS_TIMEOUT_SECONDS: '30',
  OUTPUT_DEVICE: 'MacBook Air扬声器',
  AUDIO_GUARD_ENABLED: '1',
  LAST_SAFE_OUTPUT_DEVICE: '',
  LAST_SAFE_INPUT_DEVICE: '',
  TASK_SUMMARY_ENABLED: '1',
  TASK_SUMMARY_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DEEPSEEK_API_KEY: '',
})

const EXECUTABLE_TEMPLATE_FILES = new Set([
  'codex-delayed-clear.sh',
  'codex-hook.sh',
  'codex-notify.sh',
  'k28_monitor.sh',
  'k28_set.py',
  'k28_status.sh',
  'summarize_task.py',
  'tts_launchd_job.sh',
])

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml')

const PUBLIC_CONFIG_KEYS = [
  'STATUS_LIGHT_ENABLED',
  'VOICE_ENABLED',
  'VOLC_SPEAKER',
  'VOLC_RESOURCE_ID',
  'VOLC_SPEED',
  'TTS_TIMEOUT_SECONDS',
  'OUTPUT_DEVICE',
  'AUDIO_GUARD_ENABLED',
  'TASK_SUMMARY_ENABLED',
  'TASK_SUMMARY_MODEL',
  'DEEPSEEK_BASE_URL',
]

const SECRET_CONFIG_KEYS = new Set(['VOLC_API_KEY', 'DEEPSEEK_API_KEY'])
const VALID_LIGHT_STATES = new Set(['busy', 'done', 'attention', 'idle'])
const CLAUDE_WORKFLOW_FINISHED_STATUSES = new Set([
  'completed',
  'complete',
  'done',
  'failed',
  'failure',
  'error',
  'cancelled',
  'canceled',
  'aborted',
])
// 心跳活跃窗口：run 目录内任一文件 5 分钟内有写入才算"正在跑"
// （活跃 agent 的 .jsonl 会持续流式增长，崩溃/中断的僵尸 run 会很快超时掉出）
const CLAUDE_WORKFLOW_LIVE_MS = 5 * 60 * 1000
// 单次最多检查的 run 目录数（按目录新鲜度倒序后取头部，防历史目录全量读盘）
const CLAUDE_WORKFLOW_MAX_RUNS = 60
const K28_PYTHON_PACKAGES = [
  'bleak>=0.22,<1.2',
  'pyobjc-core<12',
  'pyobjc-framework-Cocoa<12',
  'pyobjc-framework-CoreBluetooth<12',
  'pyobjc-framework-libdispatch<12',
]

/**
 * 判断路径是否存在
 * @param {string} filePath - 文件或目录路径
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 解析 KEY=VALUE 配置文本
 * @param {string} content - 配置文件内容
 * @returns {Record<string, string>}
 */
function parseKeyValueConfig(content) {
  const config = {}
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key) config[key] = value
  }
  return config
}

/**
 * 在 config.toml 顶层写入 Codex notify 分发器
 * @param {string} content - 原始 TOML
 * @returns {string}
 */
function installCodexNotify(content) {
  const notifyLine = `notify = ["bash", "${K28_CODEX_NOTIFY_SCRIPT.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
  if (/^notify\s*=\s*\[\s*"bash"\s*,\s*"[^"]*k28-status-light\/codex-notify\.sh"\s*\]/m.test(content)) {
    return content
  }
  if (/^notify\s*=\s*\[[^\n]*\]/m.test(content)) {
    return content.replace(/^notify\s*=\s*\[[^\n]*\]/m, notifyLine)
  }

  const firstSectionIndex = content.search(/^\[/m)
  if (firstSectionIndex === -1) {
    return `${content.trimEnd()}\n${notifyLine}\n`
  }
  const before = content.slice(0, firstSectionIndex).trimEnd()
  const after = content.slice(firstSectionIndex)
  return `${before ? `${before}\n` : ''}${notifyLine}\n\n${after}`
}

/**
 * 读取原始 K28 配置，缺文件时返回默认配置
 * @returns {Promise<{config: Record<string, string>, exists: boolean, rawContent: string}>}
 */
async function readRawConfig() {
  try {
    const rawContent = await fs.readFile(K28_CONF_PATH, 'utf-8')
    return {
      config: { ...DEFAULT_CONFIG, ...parseKeyValueConfig(rawContent) },
      exists: true,
      rawContent,
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { config: { ...DEFAULT_CONFIG }, exists: false, rawContent: '' }
    }
    throw error
  }
}

/**
 * 生成配置文件内容
 * @param {Record<string, string>} config - 完整配置
 * @returns {string}
 */
function serializeConfig(config) {
  return `# 火山引擎豆包语音合成 (TTS) 配置 —— V3 新版控制台 / API Key 鉴权
# 由 CodePal K28 状态灯页面维护；敏感 key 只保存在本机，不回传到渲染层。
# 状态灯/语音开关只影响 hook 触发后的行为，不会删除 Claude/Codex hook 配置。

# 【开关】0=完全停用状态灯 hook 行为；1=启用屏幕渲染
STATUS_LIGHT_ENABLED=${config.STATUS_LIGHT_ENABLED || '1'}

# 【开关】0=只亮灯不播报；1=亮灯并播报
VOICE_ENABLED=${config.VOICE_ENABLED || '1'}

# 【必填】控制台「API 访问密钥 / 快速接入」里的 API Key
VOLC_API_KEY=${config.VOLC_API_KEY || ''}

# 【必填】音色 ID（speaker）。1.0 音色配 seed-tts-1.0，2.0 音色配 seed-tts-2.0。
VOLC_SPEAKER=${config.VOLC_SPEAKER || DEFAULT_CONFIG.VOLC_SPEAKER}

# 【必填】资源 ID / 计费版本
VOLC_RESOURCE_ID=${config.VOLC_RESOURCE_ID || DEFAULT_CONFIG.VOLC_RESOURCE_ID}

# 【选填】语速，1.0 正常（范围约 0.5~2.0，会换算成 -50~100）
VOLC_SPEED=${config.VOLC_SPEED || DEFAULT_CONFIG.VOLC_SPEED}

# 【选填】豆包合成超时秒数。失败时静默跳过，不回退 macOS 原声。
TTS_TIMEOUT_SECONDS=${config.TTS_TIMEOUT_SECONDS || DEFAULT_CONFIG.TTS_TIMEOUT_SECONDS}

# 【选填】播报输出设备：K28 只当显示屏，声音走本机扬声器。
OUTPUT_DEVICE=${config.OUTPUT_DEVICE || DEFAULT_CONFIG.OUTPUT_DEVICE}

# 【开关】0=允许 K28 当系统音频设备；1=CodePal 运行时防止 K28 抢默认输出
AUDIO_GUARD_ENABLED=${config.AUDIO_GUARD_ENABLED || '1'}
LAST_SAFE_OUTPUT_DEVICE=${config.LAST_SAFE_OUTPUT_DEVICE || ''}
LAST_SAFE_INPUT_DEVICE=${config.LAST_SAFE_INPUT_DEVICE || ''}

# 【选填】任务播报摘要：busy 时把原始 prompt 压成短任务名，done 时复用。
TASK_SUMMARY_ENABLED=${config.TASK_SUMMARY_ENABLED || '1'}
TASK_SUMMARY_MODEL=${config.TASK_SUMMARY_MODEL || DEFAULT_CONFIG.TASK_SUMMARY_MODEL}
DEEPSEEK_BASE_URL=${config.DEEPSEEK_BASE_URL || DEFAULT_CONFIG.DEEPSEEK_BASE_URL}
DEEPSEEK_API_KEY=${config.DEEPSEEK_API_KEY || ''}
`
}

/**
 * 原子写入文本文件
 * @param {string} filePath - 目标路径
 * @param {string} content - 内容
 * @returns {Promise<void>}
 */
async function atomicWriteText(filePath, content) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  try {
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    try { await fs.unlink(tmpPath) } catch {}
    throw error
  }
}

/**
 * 执行文件命令并等待结束
 * @param {string} command - 命令路径
 * @param {string[]} args - 参数
 * @param {object} options - child_process 选项
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runFile(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd || K28_DIR,
      timeout: options.timeout || 70000,
      env: { ...process.env, ...(options.env || {}) },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * 判断 K28 Python venv 是否已装好 BLE 依赖
 * @returns {Promise<boolean>}
 */
async function hasPythonBleDependency() {
  if (!(await pathExists(K28_PYTHON))) return false
  try {
    await runFile(K28_PYTHON, ['-c', 'import bleak'], {
      cwd: K28_DIR,
      timeout: 10000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * 把底层 Python/BLE 命令错误转成页面可读提示
 * @param {Error & {stdout?: string, stderr?: string}} error - execFile 错误
 * @returns {string}
 */
function formatK28CommandError(error) {
  const raw = `${error?.stderr || ''}\n${error?.stdout || ''}\n${error?.message || ''}`
  if (/No module named ['"]bleak['"]/.test(raw)) {
    return 'Python BLE 依赖缺失，请点击“安装 / 修复”补齐依赖后重试'
  }
  if (/Bluetooth device is turned off/i.test(raw)) {
    return '蓝牙当前关闭，请先打开 macOS 蓝牙后重试'
  }
  if (/未找到设备\s+ERAZER K28LED/i.test(raw) || /No device named ERAZER K28LED/i.test(raw)) {
    return '未找到 ERAZER K28LED，请确认设备已开机、在附近，并且可被蓝牙扫描到'
  }
  if (/not authorized|unauthorized|permission|denied/i.test(raw) && /bluetooth/i.test(raw)) {
    return '当前 Python 进程没有蓝牙权限，请在 macOS 系统设置里允许终端 / CodePal 使用蓝牙'
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.at(-1) || 'K28 命令执行失败'
}

/**
 * 备份原始配置文件
 * @param {string} rawContent - 原始配置内容
 * @returns {Promise<string|null>}
 */
async function backupConfig(rawContent) {
  if (!rawContent) return null
  await fs.mkdir(K28_BACKUP_DIR, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(K28_BACKUP_DIR, `tts-${timestamp}.conf`)
  await fs.writeFile(backupPath, rawContent, 'utf-8')
  return backupPath
}

/**
 * 复制内置 K28 模板到用户目录
 * @returns {Promise<void>}
 */
async function installTemplateFiles() {
  if (!(await pathExists(K28_TEMPLATE_DIR))) {
    throw new Error(`未找到内置 K28 模板: ${K28_TEMPLATE_DIR}`)
  }
  await fs.mkdir(K28_DIR, { recursive: true })
  await fs.mkdir(K28_STATES_DIR, { recursive: true })

  const entries = await fs.readdir(K28_TEMPLATE_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const source = path.join(K28_TEMPLATE_DIR, entry.name)
    const target = path.join(K28_DIR, entry.name)

    // 已有配置文件可能包含真实 key，安装/修复时不能覆盖。
    if (entry.name === 'tts.conf' && await pathExists(target)) continue

    await fs.copyFile(source, target)
    if (EXECUTABLE_TEMPLATE_FILES.has(entry.name)) {
      await fs.chmod(target, 0o755)
    }
  }
}

/**
 * 确保 Python venv 和 bleak 依赖可用
 * @returns {Promise<void>}
 */
async function ensurePythonEnvironment() {
  if (!(await pathExists(K28_PYTHON))) {
    await runFile('python3', ['-m', 'venv', path.join(K28_DIR, '.venv')], {
      cwd: K28_DIR,
      timeout: 120000,
    })
  }
  if (await hasPythonBleDependency()) return
  await runFile(K28_PYTHON, ['-m', 'pip', 'install', '--quiet', ...K28_PYTHON_PACKAGES], {
    cwd: K28_DIR,
    timeout: 180000,
  })
  if (!(await hasPythonBleDependency())) {
    throw new Error('Python 依赖安装后仍无法导入 bleak，请检查 pip 安装日志或本机 Python 环境')
  }
}

/**
 * 给 Claude settings 写入 K28 hooks
 * @returns {Promise<void>}
 */
async function installClaudeHooks() {
  // 配置根不支持时必须在任何副作用之前拒绝（前面已有脚本复制 / 依赖安装）
  const unsupportedRoot = detectUnsupportedCustomRoot()
  if (unsupportedRoot) {
    throw Object.assign(new Error(unsupportedRoot.error), { code: unsupportedRoot.errorCode })
  }
  // 单次事务：hooks 的构造必须基于**事务内最新** settings，
  // 否则会按旧快照重建，覆盖并发的其他 settings 改动。
  const writeResult = await mutateClaudeSettingsFile(({ data, kind, errorCode, error }) => {
    if (kind === 'corrupt' || kind === 'io_error') {
      // 历史行为：非 ENOENT 的读取/解析错误直接抛出，不自动修复
      return { ok: false, errorCode: errorCode || 'K28_SETTINGS_UNREADABLE', error: error || '无法读取 Claude settings.json' }
    }

    const next = { ...data }
    if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) next.hooks = {}
    else next.hooks = { ...next.hooks }

    const addHook = (eventName, command, matcher = null) => {
      const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : []
      const filteredGroups = groups
        .map((group) => ({
          ...group,
          hooks: Array.isArray(group.hooks)
            ? group.hooks.filter((hook) => !String(hook.command || '').includes('k28-status-light/k28_status.sh'))
            : [],
        }))
        .filter((group) => group.hooks.length > 0)

      const nextGroup = {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command }],
      }
      next.hooks[eventName] = [...filteredGroups, nextGroup]
    }

    addHook('SessionStart', `bash ${path.join(K28_DIR, 'k28_status.sh')} idle`)
    addHook('UserPromptSubmit', `bash ${path.join(K28_DIR, 'k28_status.sh')} busy`)
    addHook('PreToolUse', `bash ${path.join(K28_DIR, 'k28_status.sh')} attention`, 'AskUserQuestion')
    addHook('PostToolUse', `bash ${path.join(K28_DIR, 'k28_status.sh')} busy`, 'AskUserQuestion')
    addHook('Stop', `bash ${path.join(K28_DIR, 'k28_status.sh')} done`)
    addHook('SessionEnd', `bash ${path.join(K28_DIR, 'k28_status.sh')} clear`)

    return { ok: true, next, create: true }
  }, { backupSuffix: 'k28-hooks' })

  if (!writeResult.success) {
    // 结构化提交状态不能只留在 broker：抛错时一并带上，供上层区分"完全没写"与"已写入未验证"
    const error = new Error(writeResult.error || '写入 Claude settings.json 失败')
    error.code = writeResult.errorCode || 'WRITE_FAILED'
    error.committed = writeResult.committed === true
    error.durability = writeResult.durability || null
    throw error
  }
}

/**
 * 给 Codex config.toml 追加 K28 hooks；已有 K28 hooks 时只确保 features.hooks=true
 * @returns {Promise<void>}
 */
async function installCodexHooks() {
  let content = ''
  try {
    content = await fs.readFile(CODEX_CONFIG_PATH, 'utf-8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  let nextContent = content
  nextContent = installCodexNotify(nextContent)

  if (/\[features\]/.test(nextContent)) {
    if (/(\[features\][\s\S]*?)(?=\n\[|$)/.test(nextContent)) {
      nextContent = nextContent.replace(/(\[features\][\s\S]*?)(?=\n\[|$)/, (block) => {
        if (/^hooks\s*=/m.test(block)) {
          return block.replace(/^hooks\s*=.*$/m, 'hooks = true')
        }
        return `${block.trimEnd()}\nhooks = true\n`
      })
    }
  } else {
    nextContent = `${nextContent.trimEnd()}\n\n[features]\nhooks = true\n`
  }

  if (!nextContent.includes('k28-status-light/codex-hook.sh')) {
    nextContent = `${nextContent.trimEnd()}

# CodePal K28 status light hooks
[[hooks.SessionStart]]
matcher = "startup|resume|clear|compact"

[[hooks.SessionStart.hooks]]
type = "command"
command = "bash ${path.join(K28_DIR, 'codex-hook.sh')} idle"
timeout = 10
statusMessage = "K28 idle"

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "bash ${path.join(K28_DIR, 'codex-hook.sh')} busy"
timeout = 10
statusMessage = "K28 busy"

[[hooks.PermissionRequest]]

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "bash ${path.join(K28_DIR, 'codex-hook.sh')} attention"
timeout = 10
statusMessage = "K28 attention"

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "bash ${path.join(K28_DIR, 'codex-hook.sh')} done"
timeout = 10
statusMessage = "K28 done"
`
  }

  if (content) {
    const backupPath = `${CODEX_CONFIG_PATH}.k28.${Date.now()}.bak`
    await fs.writeFile(backupPath, content, 'utf-8')
  }
  await atomicWriteText(CODEX_CONFIG_PATH, `${nextContent.trimEnd()}\n`)
}

/**
 * 规范化布尔开关值
 * @param {boolean|string|number|undefined} value - 原始值
 * @param {string} fallback - 默认 0/1 字符串
 * @returns {'0'|'1'}
 */
function normalizeBooleanFlag(value, fallback = '1') {
  if (value === true || value === '1' || value === 1 || value === 'true') return '1'
  if (value === false || value === '0' || value === 0 || value === 'false') return '0'
  return fallback === '0' ? '0' : '1'
}

/**
 * 规范化有限范围数字字符串
 * @param {unknown} value - 原始值
 * @param {number} fallback - 默认值
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {string}
 */
function normalizeNumberString(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return String(fallback)
  return String(Math.min(max, Math.max(min, num)))
}

/**
 * 构造前端可见配置，敏感 key 只返回是否存在
 * @param {Record<string, string>} config - 原始配置
 * @returns {object}
 */
function toPublicConfig(config) {
  const publicConfig = {}
  for (const key of PUBLIC_CONFIG_KEYS) {
    publicConfig[key] = config[key] || DEFAULT_CONFIG[key] || ''
  }
  return {
    ...publicConfig,
    hasVolcApiKey: Boolean(config.VOLC_API_KEY),
    hasDeepSeekApiKey: Boolean(config.DEEPSEEK_API_KEY),
  }
}

/**
 * 读取文件最后若干行
 * @param {string} filePath - 文件路径
 * @param {number} lineCount - 行数
 * @returns {Promise<string[]>}
 */
async function tailFile(filePath, lineCount = 40) {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return content.split(/\r?\n/).filter(Boolean).slice(-lineCount)
  } catch {
    return []
  }
}

/**
 * 从 Claude workflow 脚本文本里提取 meta 字段
 * @param {string} script - workflow 脚本文本
 * @param {string} field - meta 字段名
 * @returns {string}
 */
function extractWorkflowMetaValue(script, field) {
  const match = String(script || '').match(new RegExp(`${field}:\\s*(['"\`])([\\s\\S]*?)\\1`))
  return match?.[2]?.trim() || ''
}

/**
 * 计算 run 目录的最近心跳：目录内任一文件的最大 mtime（毫秒）
 * 活跃工作流的 agent .jsonl 会持续流式写入，故用 max(mtime) 判断"是否仍在动"
 * @param {string} runDir - <session>/subagents/workflows/wf_<id> 目录
 * @returns {Promise<number>} 毫秒时间戳，读取失败返回 0
 */
async function readWorkflowRunHeartbeatMs(runDir) {
  let entries = []
  try {
    entries = await fs.readdir(runDir, { withFileTypes: true })
  } catch {
    return 0
  }
  let latestMs = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const stat = await fs.stat(path.join(runDir, entry.name))
      if (stat.mtimeMs > latestMs) latestMs = stat.mtimeMs
    } catch {}
  }
  return latestMs
}

/**
 * 判断 run 是否已结束
 * Claude Code 仅在工作流跑完时才把完成快照写到 <session>/workflows/<runId>.json，
 * 故快照出现即视为结束；仅当快照显式带「非终态」status 时才例外（防御未来格式变化）。
 * @param {string} sessionDir - 会话目录
 * @param {string} runId - 工作流 runId（wf_*）
 * @returns {Promise<boolean>}
 */
async function isClaudeWorkflowFinished(sessionDir, runId) {
  const snapshotPath = path.join(sessionDir, 'workflows', `${runId}.json`)
  let raw
  try {
    raw = await fs.readFile(snapshotPath, 'utf-8')
  } catch {
    return false
  }
  try {
    const status = String(JSON.parse(raw)?.status || '').trim().toLowerCase()
    if (status && !CLAUDE_WORKFLOW_FINISHED_STATUSES.has(status)) return false
  } catch {}
  return true
}

/**
 * 读取 run 对应工作流脚本的 meta（name / description）
 * 脚本落在 <session>/workflows/scripts/<slug>-<runId>.js
 * @param {string} sessionDir - 会话目录
 * @param {string} runId - 工作流 runId
 * @returns {Promise<{name: string, description: string}>}
 */
async function readClaudeWorkflowScriptMeta(sessionDir, runId) {
  const scriptsDir = path.join(sessionDir, 'workflows', 'scripts')
  let entries = []
  try {
    entries = await fs.readdir(scriptsDir)
  } catch {
    return { name: '', description: '' }
  }
  const scriptName = entries.find((name) => name.endsWith(`${runId}.js`))
    || entries.find((name) => name.includes(runId))
  if (!scriptName) return { name: '', description: '' }
  try {
    const script = await fs.readFile(path.join(scriptsDir, scriptName), 'utf-8')
    return {
      name: extractWorkflowMetaValue(script, 'name'),
      description: extractWorkflowMetaValue(script, 'description'),
    }
  } catch {
    return { name: '', description: '' }
  }
}

/**
 * 从 journal.jsonl 统计 agent 进度文案
 * 事件 started=已派发、result=已完成，按 agentId 去重；
 * 分母取「已派发数」（运行中无法预知最终总量，宁可如实反映已观测到的）
 * @param {string} runDir - run 目录
 * @returns {Promise<string>} 形如 "3/5 agents done"，无数据返回 ''
 */
async function readClaudeWorkflowProgressText(runDir) {
  let raw
  try {
    raw = await fs.readFile(path.join(runDir, 'journal.jsonl'), 'utf-8')
  } catch {
    return ''
  }
  const started = new Set()
  const done = new Set()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    const agentId = event?.agentId || event?.key
    if (!agentId) continue
    if (event.type === 'started') started.add(agentId)
    else if (event.type === 'result') done.add(agentId)
  }
  if (!started.size) return ''
  return `${done.size}/${started.size} agents done`
}

/**
 * 把一个正在跑的工作流 run 映射成 K28 活跃状态行
 * @param {object} run - run 描述
 * @param {string} run.runId - 工作流 runId
 * @param {number} run.heartbeatMs - 最近心跳毫秒时间戳
 * @param {{name: string, description: string}} run.meta - 脚本 meta
 * @param {string} run.progress - 进度文案
 * @returns {object}
 */
function toClaudeWorkflowState({ runId, heartbeatMs, meta, progress }) {
  const name = String(meta?.name || runId || 'Claude workflow').trim()
  const description = String(meta?.description || 'Claude dynamic workflow').trim()
  return {
    key: `claude-workflow:${runId}`,
    state: 'busy',
    epoch: Math.floor((heartbeatMs || 0) / 1000),
    name,
    task: progress ? `${description} · ${progress}` : description,
    source: 'Claude',
  }
}

/**
 * 收集 Claude Code dynamic workflow 的运行目录
 * 运行态实时落在 <session>/subagents/workflows/wf_<id>/，完成后才有 <session>/workflows/wf_<id>.json
 * @param {string} projectsDir - ~/.claude/projects 目录
 * @returns {Promise<Array<{runId: string, runDir: string, sessionDir: string}>>}
 */
async function collectClaudeWorkflowRuns(projectsDir) {
  const runs = []
  let projectEntries = []
  try {
    projectEntries = await fs.readdir(projectsDir, { withFileTypes: true })
  } catch {
    return runs
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectDir = path.join(projectsDir, projectEntry.name)
    let sessionEntries = []
    try {
      sessionEntries = await fs.readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue
      const sessionDir = path.join(projectDir, sessionEntry.name)
      const runsDir = path.join(sessionDir, 'subagents', 'workflows')
      let runEntries = []
      try {
        runEntries = await fs.readdir(runsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const runEntry of runEntries) {
        if (runEntry.isDirectory() && runEntry.name.startsWith('wf_')) {
          runs.push({
            runId: runEntry.name,
            runDir: path.join(runsDir, runEntry.name),
            sessionDir,
          })
        }
      }
    }
  }

  return runs
}

/**
 * 读取 Claude Code dynamic workflow 的活跃（进行中）状态
 * 判活两道独立信号：① 无完成快照；② run 目录心跳在 liveMs 内（防崩溃后的僵尸 run）
 * @param {object} options - 读取选项
 * @param {string} [options.projectsDir] - Claude projects 目录
 * @param {number} [options.nowMs] - 当前毫秒时间戳
 * @param {number} [options.liveMs] - 心跳活跃窗口
 * @returns {Promise<Array<{key: string, state: string, epoch: number, name: string, task: string, source: string}>>}
 */
async function readClaudeWorkflowStates({
  projectsDir = CLAUDE_PROJECTS_DIR,
  nowMs = Date.now(),
  liveMs = CLAUDE_WORKFLOW_LIVE_MS,
} = {}) {
  const runs = await collectClaudeWorkflowRuns(projectsDir)

  // 按 run 目录自身 mtime 粗排取头部，避免历史目录全量读盘
  const ranked = []
  for (const run of runs) {
    let dirMtimeMs = 0
    try {
      dirMtimeMs = (await fs.stat(run.runDir)).mtimeMs
    } catch {}
    ranked.push({ ...run, dirMtimeMs })
  }
  ranked.sort((a, b) => b.dirMtimeMs - a.dirMtimeMs)

  const states = []
  for (const run of ranked.slice(0, CLAUDE_WORKFLOW_MAX_RUNS)) {
    // 完成快照出现即结束，不再算进行中
    if (await isClaudeWorkflowFinished(run.sessionDir, run.runId)) continue
    // 心跳超时 = 崩溃/中断的僵尸 run，不显示
    const heartbeatMs = await readWorkflowRunHeartbeatMs(run.runDir)
    if (!heartbeatMs || nowMs - heartbeatMs > liveMs) continue
    const meta = await readClaudeWorkflowScriptMeta(run.sessionDir, run.runId)
    const progress = await readClaudeWorkflowProgressText(run.runDir)
    states.push(toClaudeWorkflowState({ runId: run.runId, heartbeatMs, meta, progress }))
  }

  return states
}

/**
 * 读取活跃状态文件
 * @returns {Promise<Array<{key: string, state: string, epoch: number, name: string, task: string}>>}
 */
async function readActiveStates() {
  let states = []
  try {
    const entries = await fs.readdir(K28_STATES_DIR, { withFileTypes: true })
    const textFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
    for (const entry of textFiles) {
      const key = entry.name.replace(/\.txt$/, '')
      const filePath = path.join(K28_STATES_DIR, entry.name)
      const taskPath = path.join(K28_STATES_DIR, `${key}.task`)
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        const [state = '', epochRaw = '', name = '', source = ''] = content.trim().split('\t')
        let task = ''
        try {
          task = (await fs.readFile(taskPath, 'utf-8')).trim()
        } catch {}
        states.push({
          key,
          state,
          epoch: Number(epochRaw) || 0,
          name,
          task,
          source,
        })
      } catch {}
    }
  } catch {}

  const workflowStates = await readClaudeWorkflowStates()
  states = [...states, ...workflowStates]
  return states.sort((a, b) => b.epoch - a.epoch)
}

/**
 * 获取 K28 状态灯当前状态
 * @returns {Promise<{success: boolean, data: object, error: string|null}>}
 */
async function getK28StatusLightState() {
  try {
    const [{ config, exists }, installed, audio, states, ttsLogs, codexLogs] = await Promise.all([
      readRawConfig(),
      pathExists(K28_DIR),
      getK28AudioState(),
      readActiveStates(),
      tailFile(K28_TTS_LOG_PATH, 40),
      tailFile(K28_CODEX_LOG_PATH, 20),
    ])

    const requiredFiles = {
      directory: installed,
      config: exists,
      statusScript: await pathExists(K28_STATUS_SCRIPT),
      setScript: await pathExists(K28_SET_SCRIPT),
      ttsScript: await pathExists(K28_TTS_SCRIPT),
      renderScript: await pathExists(K28_RENDER_SCRIPT),
      python: await pathExists(K28_PYTHON),
      pythonBle: await hasPythonBleDependency(),
    }

    return {
      success: true,
      data: {
        basePath: K28_DIR,
        configPath: K28_CONF_PATH,
        installed: requiredFiles.directory
          && requiredFiles.statusScript
          && requiredFiles.setScript
          && requiredFiles.ttsScript
          && requiredFiles.renderScript
          && requiredFiles.python
          && requiredFiles.pythonBle,
        requiredFiles,
        config: toPublicConfig(config),
        currentOutputDevice: audio.currentOutputDevice,
        audio,
        activeStates: states,
        logs: {
          tts: ttsLogs,
          codex: codexLogs,
        },
      },
      error: null,
    }
  } catch (error) {
    return { success: false, data: null, error: error.message }
  }
}

/**
 * 保存 K28 状态灯配置
 * @param {object} updates - 前端传入的配置变更
 * @returns {Promise<{success: boolean, data: object|null, backupPath: string|null, error: string|null}>}
 */
async function saveK28StatusLightConfig(updates = {}) {
  try {
    const { config, rawContent } = await readRawConfig()
    const nextConfig = { ...config }

    nextConfig.STATUS_LIGHT_ENABLED = normalizeBooleanFlag(updates.STATUS_LIGHT_ENABLED, config.STATUS_LIGHT_ENABLED)
    nextConfig.VOICE_ENABLED = normalizeBooleanFlag(updates.VOICE_ENABLED, config.VOICE_ENABLED)
    nextConfig.TASK_SUMMARY_ENABLED = normalizeBooleanFlag(updates.TASK_SUMMARY_ENABLED, config.TASK_SUMMARY_ENABLED)
    nextConfig.AUDIO_GUARD_ENABLED = normalizeBooleanFlag(updates.AUDIO_GUARD_ENABLED, config.AUDIO_GUARD_ENABLED)
    nextConfig.VOLC_SPEED = normalizeNumberString(updates.VOLC_SPEED ?? config.VOLC_SPEED, 1, 0.5, 2)
    nextConfig.TTS_TIMEOUT_SECONDS = normalizeNumberString(
      updates.TTS_TIMEOUT_SECONDS ?? config.TTS_TIMEOUT_SECONDS,
      30,
      3,
      60
    )
    for (const key of ['VOLC_SPEAKER', 'VOLC_RESOURCE_ID', 'OUTPUT_DEVICE', 'TASK_SUMMARY_MODEL', 'DEEPSEEK_BASE_URL']) {
      if (typeof updates[key] === 'string' && updates[key].trim()) {
        nextConfig[key] = updates[key].trim()
      }
    }

    // 空字符串表示保持旧 key；只有显式传入非空字符串才覆盖，避免渲染层拿到真实 key。
    for (const key of SECRET_CONFIG_KEYS) {
      if (typeof updates[key] === 'string' && updates[key].trim()) {
        nextConfig[key] = updates[key].trim()
      }
    }

    const backupPath = await backupConfig(rawContent)
    await atomicWriteText(K28_CONF_PATH, serializeConfig(nextConfig))

    return {
      success: true,
      data: toPublicConfig(nextConfig),
      backupPath,
      error: null,
    }
  } catch (error) {
    return { success: false, data: null, backupPath: null, error: error.message }
  }
}

/**
 * 一键安装/修复 K28 状态灯
 * @returns {Promise<{success: boolean, steps: Array, state?: object|null, error: string|null}>}
 */
async function installK28StatusLight() {
  const steps = []
  const runStep = async (id, label, task) => {
    try {
      await task()
      steps.push({ id, label, status: 'success', error: null })
    } catch (error) {
      steps.push({ id, label, status: 'error', error: error.message })
      throw error
    }
  }

  // 配置根不支持时必须在**任何副作用之前**拒绝：
  // 这里之后会 mkdir / 复制脚本 / 调子进程装依赖，事后再拒会留下半完成状态。
  // 守卫必须放在公开入口，不能只放在私有的 installClaudeHooks 里。
  const unsupportedRoot = detectUnsupportedCustomRoot()
  if (unsupportedRoot) {
    steps.push({ id: 'config-root', label: '检查配置根', status: 'error', error: unsupportedRoot.error })
    return { success: false, steps, state: null, error: unsupportedRoot.error, errorCode: unsupportedRoot.errorCode }
  }

  try {
    await runStep('copy-template', '复制内置脚本', installTemplateFiles)
    await runStep('python-env', '安装 Python 依赖', ensurePythonEnvironment)
    await runStep('claude-hooks', '配置 Claude hooks', installClaudeHooks)
    await runStep('codex-hooks', '配置 Codex hooks', installCodexHooks)

    const stateResult = await getK28StatusLightState()
    return {
      success: true,
      steps,
      state: stateResult.success ? stateResult.data : null,
      error: null,
    }
  } catch (error) {
    return { success: false, steps, state: null, error: error.message }
  }
}

/**
 * 测试 TTS 播报
 * @param {string} text - 测试文本
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function testK28Voice(text) {
  const safeText = String(text || 'CodePal 语音测试').trim().slice(0, 120)
  try {
    await runFile(K28_PYTHON, [K28_TTS_SCRIPT, safeText], {
      timeout: 75000,
      env: { K28_TTS_STRICT: '1' },
    })
    return { success: true, error: null }
  } catch (error) {
    return { success: false, error: formatK28CommandError(error) }
  }
}

/**
 * 测试 K28 灯色
 * @param {'busy'|'done'|'attention'|'idle'} state - 状态
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function testK28Light(state) {
  const safeState = VALID_LIGHT_STATES.has(state) ? state : 'done'
  try {
    await ensurePythonEnvironment()
    const color = safeState === 'idle' ? 'done' : safeState
    await runFile(K28_PYTHON, [K28_SET_SCRIPT, color], { timeout: 25000 })
    return { success: true, error: null }
  } catch (error) {
    return { success: false, error: formatK28CommandError(error) }
  }
}

/**
 * 清空 K28 状态文件并重渲染待机图案
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function clearK28States() {
  try {
    await fs.mkdir(K28_STATES_DIR, { recursive: true })
    const entries = await fs.readdir(K28_STATES_DIR, { withFileTypes: true })
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && (entry.name.endsWith('.txt') || entry.name.endsWith('.task')))
        .map((entry) => fs.unlink(path.join(K28_STATES_DIR, entry.name)).catch(() => {}))
    )
    if (await pathExists(K28_RENDER_SCRIPT)) {
      await ensurePythonEnvironment()
      await runFile(K28_PYTHON, [K28_RENDER_SCRIPT], { timeout: 15000 })
    }
    return { success: true, error: null }
  } catch (error) {
    return { success: false, error: formatK28CommandError(error) }
  }
}

/**
 * 打开 K28 工具目录
 * @param {import('electron').Shell} shell - Electron shell
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function openK28Directory(shell) {
  try {
    await shell.openPath(K28_DIR)
    return { success: true, error: null }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

module.exports = {
  getK28StatusLightState,
  installK28StatusLight,
  saveK28StatusLightConfig,
  testK28Voice,
  testK28Light,
  clearK28States,
  openK28Directory,
  _private: {
    readClaudeWorkflowStates,
    toClaudeWorkflowState,
    installClaudeHooks,
  },
}
