/**
 * Plugin 控制中心领域服务
 *
 * 负责：
 * - 通过 Codex / Claude 官方 CLI 读取并归一化 Plugin 状态
 * - 用固定 argv 执行白名单生命周期操作
 * - 保留式更新 Codex Plugin enabled 配置
 * - 写后重读原生状态，并对 renderer 脱敏
 *
 * @module electron/services/pluginControlService
 */

const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)
const TOOL_NAMES = Object.freeze({ codex: 'Codex', 'claude-code': 'Claude Code' })
const ACTIONS = Object.freeze({
  codex: new Set(['install', 'enable', 'disable', 'uninstall']),
  'claude-code': new Set(['install', 'enable', 'disable', 'update', 'uninstall']),
})
const CLAUDE_SCOPES = new Set(['user', 'project', 'local'])
const SAFE_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$/
const SAFE_ERROR_CODES = new Set([
  'PLUGIN_MANAGED_OR_PROTECTED',
  'AUTH_REQUIRED',
  'PLUGIN_NOT_FOUND',
  'CLI_NOT_AVAILABLE',
  'PERMISSION_DENIED',
  'CLI_TIMEOUT',
  'CLI_INVALID_JSON',
  'CLI_COMMAND_FAILED',
])
let codexConfigWriteQueue = Promise.resolve()

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function safeErrorCode(error) {
  if (SAFE_ERROR_CODES.has(error?.code)) return error.code
  const diagnostic = `${error?.stderr || ''} ${error?.message || ''}`.toLowerCase()
  if (/managed|administrator|policy|protected|cannot (?:remove|disable|uninstall)/.test(diagnostic)) return 'PLUGIN_MANAGED_OR_PROTECTED'
  if (/authentication|authenticate|authorization|login required|not logged in/.test(diagnostic)) return 'AUTH_REQUIRED'
  if (/plugin.*not found|unknown plugin|no such plugin/.test(diagnostic)) return 'PLUGIN_NOT_FOUND'
  if (error?.code === 'ENOENT') return 'CLI_NOT_AVAILABLE'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'PERMISSION_DENIED'
  if (error?.code === 'ETIMEDOUT') return 'CLI_TIMEOUT'
  return 'CLI_COMMAND_FAILED'
}

async function runPluginCli(runCommand, binary, args, options) {
  try {
    return await runCommand(binary, args, options)
  } catch (error) {
    throw codedError(safeErrorCode(error))
  }
}

async function defaultRunCommand(binary, args, options = {}) {
  const result = await execFileAsync(binary, args, {
    cwd: options.cwd,
    timeout: options.timeout || 30_000,
    maxBuffer: 20 * 1024 * 1024,
    encoding: 'utf8',
    shell: false,
  })
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: 0 }
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '').trim() || 'null') } catch { throw codedError('CLI_INVALID_JSON') }
}

function countValue(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}

function capabilities(item) {
  return {
    skills: countValue(item.skills),
    commands: countValue(item.commands),
    agents: countValue(item.agents),
    mcp: countValue(item.mcpServers || item.mcp),
    hooks: countValue(item.hooks),
    connectors: countValue(item.connectors || item.apps),
  }
}

function normalizePlugin(item, toolId, installedFallback = true) {
  const id = item.pluginId || item.id || (item.marketplaceName ? `${item.name}@${item.marketplaceName}` : item.name)
  return {
    id,
    name: item.name || String(id || '').split('@')[0],
    toolId,
    installed: item.installed ?? installedFallback,
    enabled: item.enabled ?? (item.installed ?? installedFallback),
    version: item.version || item.installedVersion || '—',
    latestVersion: item.latestVersion || null,
    updateAvailable: Boolean(item.updateAvailable || (item.latestVersion && item.version && item.latestVersion !== item.version)),
    marketplace: item.marketplaceName || item.marketplace || String(id || '').split('@')[1] || 'unknown',
    scope: item.scope || item.installScope || 'user',
    description: item.description || '',
    sourceType: item.source?.source || item.source?.sourceType || (typeof item.source === 'string' ? 'marketplace' : 'unknown'),
    installPolicy: item.installPolicy || null,
    auth: {
      policy: item.authPolicy || item.auth?.policy || 'UNKNOWN',
      status: item.authStatus || item.auth?.status || (item.authPolicy === 'ON_INSTALL' ? 'required-on-install' : item.authPolicy === 'ON_USE' ? 'on-use' : 'unknown'),
    },
    capabilities: capabilities(item),
    dependencies: Array.isArray(item.dependencies) ? item.dependencies.map((entry) => typeof entry === 'string' ? entry : entry.name).filter(Boolean) : [],
  }
}

async function countDirectory(rootPath, name) {
  try {
    const entries = await fs.readdir(path.join(rootPath, name), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() || entry.isFile()).length
  } catch { return 0 }
}

async function enrichLocalInventory(plugin, rawItem) {
  if (!plugin.installed) return plugin
  const rootPath = rawItem.source?.path || rawItem.installPath || rawItem.cachePath
  if (!rootPath || !path.isAbsolute(rootPath)) return plugin
  const [skills, commands, agents, mcpFolders, hooks, connectors] = await Promise.all([
    countDirectory(rootPath, 'skills'),
    countDirectory(rootPath, 'commands'),
    countDirectory(rootPath, 'agents'),
    countDirectory(rootPath, 'mcp'),
    countDirectory(rootPath, 'hooks'),
    countDirectory(rootPath, 'connectors'),
  ])
  return {
    ...plugin,
    capabilities: {
      skills: Math.max(plugin.capabilities.skills, skills),
      commands: Math.max(plugin.capabilities.commands, commands),
      agents: Math.max(plugin.capabilities.agents, agents),
      mcp: Math.max(plugin.capabilities.mcp, mcpFolders),
      hooks: Math.max(plugin.capabilities.hooks, hooks),
      connectors: Math.max(plugin.capabilities.connectors, connectors),
    },
  }
}

async function listProvider(toolId, params, deps) {
  const runCommand = deps.runCommand || defaultRunCommand
  const cwd = params.projectPath && path.isAbsolute(params.projectPath) ? params.projectPath : undefined
  const binary = toolId === 'codex' ? 'codex' : 'claude'
  const response = await runPluginCli(runCommand, binary, ['plugin', 'list', '--available', '--json'], { shell: false, cwd, timeout: 30_000 })
  const data = parseJson(response.stdout)
  if (toolId === 'codex') {
    const installedItems = Array.isArray(data?.installed) ? data.installed : []
    const installed = await Promise.all(installedItems.map(async (item) => enrichLocalInventory(normalizePlugin(item, toolId, true), item)))
    const available = Array.isArray(data?.available) ? data.available.map((item) => normalizePlugin(item, toolId, false)) : []
    return [...installed, ...available.filter((candidate) => !installed.some((item) => item.id === candidate.id))]
  }
  if (Array.isArray(data)) return Promise.all(data.map(async (item) => enrichLocalInventory(normalizePlugin(item, toolId, item.installed ?? true), item)))
  const installedItems = Array.isArray(data?.installed) ? data.installed : []
  const installed = await Promise.all(installedItems.map(async (item) => enrichLocalInventory(normalizePlugin(item, toolId, true), item)))
  const available = Array.isArray(data?.available) ? data.available.map((item) => normalizePlugin(item, toolId, false)) : []
  return [...installed, ...available.filter((candidate) => !installed.some((item) => item.id === candidate.id))]
}

/** 读取双端 Plugin 状态；单端失败时保留另一端。 */
async function getPluginControlSnapshot(params = {}, deps = {}) {
  const entries = await Promise.all(Object.keys(TOOL_NAMES).map(async (toolId) => {
    try {
      return [toolId, { plugins: await listProvider(toolId, params, deps), error: null }]
    } catch (error) {
      return [toolId, { plugins: [], error: safeErrorCode(error) }]
    }
  }))
  const results = Object.fromEntries(entries)
  const errors = entries.filter(([, value]) => value.error).map(([toolId, value]) => ({ toolId, code: value.error }))
  const plugins = entries.flatMap(([, value]) => value.plugins)
    .filter((item) => SAFE_PLUGIN_ID.test(item.id || ''))
    .sort((left, right) => Number(right.installed) - Number(left.installed) || left.name.localeCompare(right.name))
  return {
    generatedAt: new Date().toISOString(),
    partial: errors.length > 0,
    errors,
    tools: Object.fromEntries(Object.keys(TOOL_NAMES).map((toolId) => [toolId, {
      id: toolId,
      name: TOOL_NAMES[toolId],
      available: !results[toolId].error,
      installedCount: results[toolId].plugins.filter((item) => item.installed).length,
    }])),
    plugins,
    summary: {
      installed: plugins.filter((item) => item.installed).length,
      enabled: plugins.filter((item) => item.installed && item.enabled).length,
      available: plugins.filter((item) => !item.installed).length,
      updates: plugins.filter((item) => item.updateAvailable).length,
      authRequired: plugins.filter((item) => item.auth.status === 'required' || item.auth.status === 'required-on-install').length,
    },
  }
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function updateCodexPluginConfig(text, pluginId, enabled) {
  const lines = text.split('\n')
  const escaped = regexEscape(pluginId)
  const tablePattern = new RegExp(`^\\s*\\[plugins\\."${escaped}"\\]\\s*(?:#.*)?\\r?$`)
  const enabledPattern = /^(\s*)enabled\s*=\s*(?:true|false)(\s*(?:#.*)?)\r?$/
  const dottedPattern = new RegExp(`^(\\s*)plugins\\."${escaped}"\\.enabled\\s*=\\s*(?:true|false)(\\s*(?:#.*)?)\\r?$`)
  const value = Boolean(enabled)
  const tableIndex = lines.findIndex((line) => tablePattern.test(line))

  if (tableIndex >= 0) {
    const nextTableOffset = lines.slice(tableIndex + 1).findIndex((line) => /^\s*\[/.test(line))
    const tableEnd = nextTableOffset < 0 ? lines.length : tableIndex + 1 + nextTableOffset
    const enabledOffset = lines.slice(tableIndex + 1, tableEnd).findIndex((line) => enabledPattern.test(line))
    if (enabledOffset >= 0) {
      const enabledIndex = tableIndex + 1 + enabledOffset
      lines[enabledIndex] = lines[enabledIndex].replace(enabledPattern, `$1enabled = ${value}$2`)
    } else {
      lines.splice(tableIndex + 1, 0, `enabled = ${value}`)
    }
    return lines.join('\n')
  }

  // 兼容 CodePal 早期写入的 root dotted key；只在首个 TOML table 之前匹配，
  // 避免把其他 table 里的相对 dotted key 误当成 plugins 根配置。
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line))
  const rootEnd = firstTableIndex < 0 ? lines.length : firstTableIndex
  const dottedIndex = lines.slice(0, rootEnd).findIndex((line) => dottedPattern.test(line))
  if (dottedIndex >= 0) {
    lines[dottedIndex] = lines[dottedIndex].replace(dottedPattern, `$1plugins.${JSON.stringify(pluginId)}.enabled = ${value}$2`)
    return lines.join('\n')
  }

  const prefix = text.trimEnd()
  return `${prefix}${prefix ? '\n\n' : ''}[plugins.${JSON.stringify(pluginId)}]\nenabled = ${value}\n`
}

/** 保留式、原子更新一个 Codex Plugin 的 enabled 字段。 */
async function setCodexPluginEnabled(configPath, pluginId, enabled, deps = {}) {
  if (!SAFE_PLUGIN_ID.test(pluginId)) throw codedError('INVALID_PLUGIN_ID')
  const operation = codexConfigWriteQueue.then(async () => {
    let text = ''
    try { text = await (deps.readFile || fs.readFile)(configPath, 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const next = updateCodexPluginConfig(text, pluginId, enabled)
    await (deps.mkdir || fs.mkdir)(path.dirname(configPath), { recursive: true })
    const tempPath = `${configPath}.codepal-${process.pid}-${Date.now()}.tmp`
    await (deps.writeFile || fs.writeFile)(tempPath, next, { mode: 0o600 })
    await (deps.rename || fs.rename)(tempPath, configPath)
    return { success: true, enabled: Boolean(enabled) }
  })
  // 单次失败不能让后续写入永远挂在 rejected promise 上。
  codexConfigWriteQueue = operation.catch(() => {})
  return operation
}

function validateCommand(params) {
  if (!ACTIONS[params.toolId]) throw codedError('TOOL_NOT_SUPPORTED')
  if (!SAFE_PLUGIN_ID.test(params.pluginId || '')) throw codedError('INVALID_PLUGIN_ID')
  if (!ACTIONS[params.toolId].has(params.action)) throw codedError('ACTION_NOT_SUPPORTED')
  if (params.toolId === 'claude-code' && !CLAUDE_SCOPES.has(params.scope || 'user')) throw codedError('INVALID_SCOPE')
  if (params.projectPath && !path.isAbsolute(params.projectPath)) throw codedError('INVALID_PROJECT_PATH')
}

/** 执行白名单 Plugin 命令并强制重读两端原生状态。 */
async function executePluginCommand(params = {}, deps = {}) {
  validateCommand(params)
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const runCommand = deps.runCommand || defaultRunCommand
  const options = { shell: false, cwd: params.projectPath, timeout: 120_000 }
  let result
  if (params.toolId === 'codex') {
    if (params.action === 'enable' || params.action === 'disable') {
      result = await setCodexPluginEnabled(path.join(homeDir, '.codex', 'config.toml'), params.pluginId, params.action === 'enable', deps)
    } else {
      const verb = params.action === 'install' ? 'add' : 'remove'
      result = await runPluginCli(runCommand, 'codex', ['plugin', verb, params.pluginId, '--json'], options)
    }
  } else {
    const scope = params.scope || 'user'
    const argv = ['plugin', params.action, params.pluginId, '--scope', scope]
    if (params.action === 'install' || params.action === 'update' || params.action === 'uninstall') argv.push('--yes')
    result = await runPluginCli(runCommand, 'claude', argv, options)
  }
  const snapshot = await getPluginControlSnapshot({ homeDir, projectPath: params.projectPath }, deps)
  return {
    success: true,
    verified: snapshot.tools[params.toolId]?.available === true,
    result: result?.success ? result : { completed: true },
    snapshot,
  }
}

module.exports = {
  SAFE_PLUGIN_ID,
  normalizePlugin,
  defaultRunCommand,
  setCodexPluginEnabled,
  getPluginControlSnapshot,
  executePluginCommand,
}
