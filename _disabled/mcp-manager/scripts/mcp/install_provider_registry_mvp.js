#!/usr/bin/env node
/**
 * provider_registry MCP 安装 MVP 验证脚本
 *
 * 负责：
 * - 生成 provider_registry 的标准 MCP 配置（Claude/Codex）
 * - 幂等写入 ~/.claude.json 与 ~/.codex/config.toml
 * - 写入前备份原文件并进行写后校验
 *
 * @module scripts/mcp/install_provider_registry_mvp
 */

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const TOML = require('@iarna/toml')

const PROVIDER_REGISTRY_MCP_NAME = 'provider_registry'
const VALID_TOOLS = new Set(['claude', 'codex', 'both'])

/**
 * 打印命令帮助
 */
function printUsage() {
  console.log(
    [
      'Usage:',
      '  node scripts/mcp/install_provider_registry_mvp.js [--tool=both] [--dry-run]',
      '',
      'Options:',
      '  --tool=claude|codex|both   指定安装目标，默认 both',
      '  --dry-run                  只输出变更，不实际写入',
      '  --help                     显示帮助',
    ].join('\n')
  )
}

/**
 * 解析命令行参数
 * @param {string[]} argv - 参数数组
 * @returns {{tool: 'claude'|'codex'|'both', dryRun: boolean, help: boolean}}
 */
function parseArgs(argv) {
  const options = {
    tool: 'both',
    dryRun: false,
    help: false
  }

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg.startsWith('--tool=')) {
      const tool = arg.slice('--tool='.length).trim()
      if (!VALID_TOOLS.has(tool)) {
        throw new Error(`无效参数 --tool=${tool}`)
      }
      options.tool = tool
      continue
    }
    throw new Error(`未知参数: ${arg}`)
  }

  return options
}

/**
 * 将 ~ 路径展开到用户目录
 * @param {string} filepath - 原始路径
 * @returns {string}
 */
function expandHome(filepath) {
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2))
  }
  return filepath
}

/**
 * 解析环境变量中的文件路径
 * @param {string|undefined} value - 原始环境变量值
 * @returns {string|null}
 */
function resolveEnvPath(value) {
  if (!value || !value.trim()) {
    return null
  }
  return path.resolve(expandHome(value.trim()))
}

/**
 * 生成时间戳（用于备份文件名）
 * @returns {string}
 */
function buildTimestamp() {
  const now = new Date()
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ]
  return parts.join('')
}

/**
 * 判断文件是否存在
 * @param {string} filePath - 文件路径
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 读取 Claude 配置（不存在时返回空对象）
 * @param {string} filePath - 配置路径
 * @returns {Promise<{data: object, existed: boolean}>}
 */
async function readClaudeConfig(filePath) {
  if (!(await fileExists(filePath))) {
    return { data: {}, existed: false }
  }

  const raw = await fs.readFile(filePath, 'utf-8')
  const data = JSON.parse(raw)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Claude 配置文件根节点不是对象')
  }

  return { data, existed: true }
}

/**
 * 读取 Codex 配置（不存在时返回空对象）
 * @param {string} filePath - 配置路径
 * @returns {Promise<{data: object, existed: boolean}>}
 */
async function readCodexConfig(filePath) {
  if (!(await fileExists(filePath))) {
    return { data: {}, existed: false }
  }

  const raw = await fs.readFile(filePath, 'utf-8')
  const data = TOML.parse(raw)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Codex 配置文件根节点不是对象')
  }

  return { data, existed: true }
}

/**
 * 写入 Claude 配置
 * @param {string} filePath - 配置路径
 * @param {object} data - 配置对象
 */
async function writeClaudeConfig(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

/**
 * 写入 Codex 配置
 * @param {string} filePath - 配置路径
 * @param {object} data - 配置对象
 */
async function writeCodexConfig(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${TOML.stringify(data)}`, 'utf-8')
}

/**
 * 备份配置文件（文件不存在时跳过）
 * @param {string} filePath - 原文件路径
 * @param {boolean} dryRun - 是否 dry-run
 * @returns {Promise<string|null>}
 */
async function backupConfig(filePath, dryRun) {
  if (!(await fileExists(filePath))) {
    return null
  }

  const backupPath = `${filePath}.bak.${buildTimestamp()}`
  if (!dryRun) {
    await fs.copyFile(filePath, backupPath)
  }

  return backupPath
}

/**
 * 构建 provider_registry MCP 配置模板
 * @param {string} scriptPath - provider_registry_mcp.js 路径
 * @param {string} registryPath - 注册表路径
 * @returns {{command: string, args: string[], env: Record<string, string>}}
 */
function buildProviderRegistryEntry(scriptPath, registryPath) {
  return {
    command: 'node',
    args: [scriptPath],
    env: {
      SKILL_MANAGER_PROVIDER_REGISTRY_PATH: registryPath
    }
  }
}

/**
 * 比较两个配置对象是否相等
 * @param {unknown} left - 左值
 * @param {unknown} right - 右值
 * @returns {boolean}
 */
function isJsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * 基于已有配置生成下一版 provider_registry 条目
 * @param {unknown} existingEntry - 现有配置条目
 * @param {{command: string, args: string[], env: Record<string, string>}} desiredEntry - 期望配置
 * @returns {object}
 */
function buildNextEntry(existingEntry, desiredEntry) {
  const safeExisting =
    existingEntry && typeof existingEntry === 'object' && !Array.isArray(existingEntry)
      ? existingEntry
      : {}

  const mergedEnv =
    safeExisting.env && typeof safeExisting.env === 'object' && !Array.isArray(safeExisting.env)
      ? { ...safeExisting.env, ...desiredEntry.env }
      : { ...desiredEntry.env }

  const nextEntry = {
    ...safeExisting,
    command: desiredEntry.command,
    args: [...desiredEntry.args],
    env: mergedEnv
  }

  // 强制移除 url，避免 stdio 与 http 混用导致行为不确定
  delete nextEntry.url

  return nextEntry
}

/**
 * 写入并验证单个工具的 provider_registry
 * @param {object} params - 参数对象
 * @param {'claude'|'codex'} params.tool - 目标工具
 * @param {boolean} params.dryRun - 是否 dry-run
 * @param {{command: string, args: string[], env: Record<string, string>}} params.desiredEntry - 期望配置
 * @returns {Promise<{tool: string, configPath: string, action: 'created'|'updated'|'unchanged', backupPath: string|null}>}
 */
async function installForTool({ tool, dryRun, desiredEntry }) {
  const isClaude = tool === 'claude'
  const configPath = isClaude
    ? path.join(os.homedir(), '.claude.json')
    : path.join(os.homedir(), '.codex', 'config.toml')

  const reader = isClaude ? readClaudeConfig : readCodexConfig
  const writer = isClaude ? writeClaudeConfig : writeCodexConfig
  const containerKey = isClaude ? 'mcpServers' : 'mcp_servers'

  const { data } = await reader(configPath)

  if (!data[containerKey] || typeof data[containerKey] !== 'object' || Array.isArray(data[containerKey])) {
    data[containerKey] = {}
  }

  const existingEntry = data[containerKey][PROVIDER_REGISTRY_MCP_NAME]
  const nextEntry = buildNextEntry(existingEntry, desiredEntry)

  let action = 'updated'
  if (!existingEntry) {
    action = 'created'
  } else if (isJsonEqual(existingEntry, nextEntry)) {
    action = 'unchanged'
  }

  if (action === 'unchanged') {
    return { tool, configPath, action, backupPath: null }
  }

  data[containerKey][PROVIDER_REGISTRY_MCP_NAME] = nextEntry
  const backupPath = await backupConfig(configPath, dryRun)

  if (!dryRun) {
    await writer(configPath, data)

    // 写后重读校验，确保脚本可作为“安装可行性”验证依据
    const verified = await reader(configPath)
    const verifiedEntry = verified.data?.[containerKey]?.[PROVIDER_REGISTRY_MCP_NAME]
    if (!verifiedEntry || !isJsonEqual(verifiedEntry, nextEntry)) {
      throw new Error(`${tool} 配置写后校验失败`)
    }
  }

  return { tool, configPath, action, backupPath }
}

/**
 * 入口函数
 */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  const serverScriptPath = path.resolve(__dirname, '..', '..', 'mcp', 'provider_registry_mcp.js')
  if (!(await fileExists(serverScriptPath))) {
    throw new Error(`未找到 provider_registry MCP 脚本: ${serverScriptPath}`)
  }

  const explicitRegistryPath = resolveEnvPath(process.env.SKILL_MANAGER_PROVIDER_REGISTRY_PATH)
  const sharedHome = resolveEnvPath(process.env.SKILL_MANAGER_SHARED_HOME)
  const defaultSharedHome = path.join(os.homedir(), 'Documents', 'SkillManager')
  const registryPath = explicitRegistryPath || path.join(sharedHome || defaultSharedHome, '.provider-manifests.json')

  const desiredEntry = buildProviderRegistryEntry(serverScriptPath, registryPath)
  const tools = args.tool === 'both' ? ['claude', 'codex'] : [args.tool]

  console.log(`[MVP] provider_registry install target = ${tools.join(', ')}`)
  console.log(`[MVP] dryRun = ${args.dryRun}`)
  console.log(`[MVP] script = ${serverScriptPath}`)
  console.log(`[MVP] registry = ${registryPath}`)

  const results = []
  for (const tool of tools) {
    const result = await installForTool({ tool, dryRun: args.dryRun, desiredEntry })
    results.push(result)
  }

  console.log('\n[MVP] install summary')
  for (const result of results) {
    console.log(`- ${result.tool}: ${result.action} (${result.configPath})`)
    if (result.backupPath) {
      console.log(`  backup: ${result.backupPath}`)
    }
  }
}

main().catch((error) => {
  console.error(`[MVP] install failed: ${error.message}`)
  process.exit(1)
})
