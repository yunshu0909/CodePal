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
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml')

const PUBLIC_CONFIG_KEYS = [
  'STATUS_LIGHT_ENABLED',
  'VOICE_ENABLED',
  'VOLC_SPEAKER',
  'VOLC_RESOURCE_ID',
  'VOLC_SPEED',
  'TTS_TIMEOUT_SECONDS',
  'OUTPUT_DEVICE',
  'TASK_SUMMARY_ENABLED',
  'TASK_SUMMARY_MODEL',
  'DEEPSEEK_BASE_URL',
]

const SECRET_CONFIG_KEYS = new Set(['VOLC_API_KEY', 'DEEPSEEK_API_KEY'])
const VALID_LIGHT_STATES = new Set(['busy', 'done', 'attention', 'idle'])
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
  let settings = {}
  let rawContent = ''
  try {
    rawContent = await fs.readFile(CLAUDE_SETTINGS_PATH, 'utf-8')
    settings = JSON.parse(rawContent)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    settings = {}
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {}
  }

  const addHook = (eventName, command, matcher = null) => {
    const groups = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : []
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
    settings.hooks[eventName] = [...filteredGroups, nextGroup]
  }

  addHook('SessionStart', `bash ${path.join(K28_DIR, 'k28_status.sh')} idle`)
  addHook('UserPromptSubmit', `bash ${path.join(K28_DIR, 'k28_status.sh')} busy`)
  addHook('PreToolUse', `bash ${path.join(K28_DIR, 'k28_status.sh')} attention`, 'AskUserQuestion')
  addHook('PostToolUse', `bash ${path.join(K28_DIR, 'k28_status.sh')} busy`, 'AskUserQuestion')
  addHook('Stop', `bash ${path.join(K28_DIR, 'k28_status.sh')} done`)
  addHook('SessionEnd', `bash ${path.join(K28_DIR, 'k28_status.sh')} clear`)

  if (rawContent) {
    const backupPath = path.join(path.dirname(CLAUDE_SETTINGS_PATH), `settings-k28-${Date.now()}.json`)
    await fs.writeFile(backupPath, rawContent, 'utf-8')
  }
  await atomicWriteText(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`)
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
 * 获取当前音频输出设备
 * @returns {Promise<string|null>}
 */
function getCurrentOutputDevice() {
  return new Promise((resolve) => {
    execFile('SwitchAudioSource', ['-c'], { timeout: 2000 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      resolve(String(stdout || '').trim() || null)
    })
  })
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
 * 读取活跃状态文件
 * @returns {Promise<Array<{key: string, state: string, epoch: number, name: string, task: string}>>}
 */
async function readActiveStates() {
  try {
    const entries = await fs.readdir(K28_STATES_DIR, { withFileTypes: true })
    const textFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
    const states = []
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
    return states.sort((a, b) => b.epoch - a.epoch)
  } catch {
    return []
  }
}

/**
 * 获取 K28 状态灯当前状态
 * @returns {Promise<{success: boolean, data: object, error: string|null}>}
 */
async function getK28StatusLightState() {
  try {
    const [{ config, exists }, installed, currentOutputDevice, states, ttsLogs, codexLogs] = await Promise.all([
      readRawConfig(),
      pathExists(K28_DIR),
      getCurrentOutputDevice(),
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
        currentOutputDevice,
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
}
