/**
 * V0.12 内置 MCP 安装服务行为测试
 *
 * 负责：
 * - 校验 provider_registry 在启动 ensure 阶段的创建与幂等行为
 * - 校验工具未安装场景的跳过策略
 * - 校验单工具失败时不阻断另一工具写入
 *
 * @module 自动化测试/V0.12/tests/backend/builtinMcpInstallerService.v12.behavior.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import TOML from '@iarna/toml'

const require = createRequire(import.meta.url)
const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * 在指定 HOME 下重新加载 builtinMcpInstallerService
 *
 * 为什么要重新加载：
 * - 目标模块在加载时会基于 os.homedir() 固化配置路径。
 * - 必须先切换 HOME，再清缓存 require，才能让读写命中临时目录。
 *
 * @param {string} tempHome - 临时 HOME
 * @returns {object}
 */
function loadBuiltinInstallerWithHome(tempHome) {
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome

  const modulePath = require.resolve('../../../../electron/services/builtinMcpInstallerService')
  delete require.cache[modulePath]
  return require(modulePath)
}

/**
 * 判断路径是否存在
 * @param {string} targetPath - 目标路径
 * @returns {Promise<boolean>}
 */
async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

describe.sequential('V0.12 Builtin MCP Installer Service', () => {
  let tempHome
  let serviceModule
  let originalHome
  let originalUserProfile
  let mcpScriptPath
  let registryFilePath

  beforeEach(async () => {
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-mcp-v12-'))
    serviceModule = loadBuiltinInstallerWithHome(tempHome)
    mcpScriptPath = path.join(tempHome, 'mcp', 'provider_registry_mcp.js')
    registryFilePath = path.join(tempHome, 'Documents', 'SkillManager', '.provider-manifests.json')

    await fs.mkdir(path.dirname(mcpScriptPath), { recursive: true })
    await fs.writeFile(mcpScriptPath, 'console.log("ok")\n', 'utf-8')
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
  })

  it('TC-BE-01: 工具目录均不存在时应跳过写入', async () => {
    const result = await serviceModule.ensureBuiltinProviderRegistryInstalled({
      providerRegistryScriptPath: mcpScriptPath,
      providerRegistryFilePath: registryFilePath,
      logger: SILENT_LOGGER
    })

    expect(result.success).toBe(true)
    expect(result.results).toEqual([
      { tool: 'claude', status: 'skipped', reason: 'TOOL_HOME_NOT_FOUND' },
      { tool: 'codex', status: 'skipped', reason: 'TOOL_HOME_NOT_FOUND' },
    ])
    expect(await pathExists(path.join(tempHome, '.claude.json'))).toBe(false)
    expect(await pathExists(path.join(tempHome, '.codex', 'config.toml'))).toBe(false)
  })

  it('TC-BE-02: Claude 目录存在时应创建 provider_registry 配置', async () => {
    await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true })

    const result = await serviceModule.ensureBuiltinProviderRegistryInstalled({
      providerRegistryScriptPath: mcpScriptPath,
      providerRegistryFilePath: registryFilePath,
      logger: SILENT_LOGGER
    })

    expect(result.success).toBe(true)
    expect(result.results).toEqual([
      { tool: 'claude', status: 'created' },
      { tool: 'codex', status: 'skipped', reason: 'TOOL_HOME_NOT_FOUND' },
    ])

    const claudeConfigPath = path.join(tempHome, '.claude.json')
    const parsed = JSON.parse(await fs.readFile(claudeConfigPath, 'utf-8'))
    expect(parsed.mcpServers.provider_registry.command).toBe('node')
    expect(parsed.mcpServers.provider_registry.args).toEqual([mcpScriptPath])
    expect(parsed.mcpServers.provider_registry.env.SKILL_MANAGER_PROVIDER_REGISTRY_PATH).toBe(registryFilePath)
  })

  it('TC-BE-03: Codex 已存在同配置时应返回 unchanged', async () => {
    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true })
    const codexConfigPath = path.join(tempHome, '.codex', 'config.toml')

    const existingConfig = {
      model: 'gpt-5.3-codex',
      mcp_servers: {
        provider_registry: {
          command: 'node',
          args: [mcpScriptPath],
          env: {
            SKILL_MANAGER_PROVIDER_REGISTRY_PATH: registryFilePath
          }
        }
      }
    }
    await fs.writeFile(codexConfigPath, TOML.stringify(existingConfig), 'utf-8')

    const result = await serviceModule.ensureBuiltinProviderRegistryInstalled({
      providerRegistryScriptPath: mcpScriptPath,
      providerRegistryFilePath: registryFilePath,
      logger: SILENT_LOGGER
    })

    expect(result.success).toBe(true)
    expect(result.results).toEqual([
      { tool: 'claude', status: 'skipped', reason: 'TOOL_HOME_NOT_FOUND' },
      { tool: 'codex', status: 'unchanged' },
    ])
  })

  it('TC-BE-04: 解析失败时应只跳过失败工具并继续处理其他工具', async () => {
    await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true })
    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true })

    const codexConfigPath = path.join(tempHome, '.codex', 'config.toml')
    await fs.writeFile(codexConfigPath, 'invalid = [', 'utf-8')

    const result = await serviceModule.ensureBuiltinProviderRegistryInstalled({
      providerRegistryScriptPath: mcpScriptPath,
      providerRegistryFilePath: registryFilePath,
      logger: SILENT_LOGGER
    })

    const claudeResult = result.results.find((item) => item.tool === 'claude')
    const codexResult = result.results.find((item) => item.tool === 'codex')

    expect(result.success).toBe(true)
    expect(claudeResult).toEqual({ tool: 'claude', status: 'created' })
    expect(codexResult.tool).toBe('codex')
    expect(codexResult.status).toBe('skipped')
    expect(codexResult.reason).toContain('ENSURE_FAILED:')

    const parsedClaude = JSON.parse(await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8'))
    expect(parsedClaude.mcpServers.provider_registry.command).toBe('node')
  })

  it('TC-BE-05: MCP 脚本缺失时应返回失败并不触发写入', async () => {
    const missingScriptPath = path.join(tempHome, 'mcp', 'missing.js')

    const result = await serviceModule.ensureBuiltinProviderRegistryInstalled({
      providerRegistryScriptPath: missingScriptPath,
      providerRegistryFilePath: registryFilePath,
      logger: SILENT_LOGGER
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('MCP_SCRIPT_NOT_FOUND:')
    expect(result.results).toEqual([])
    expect(await pathExists(path.join(tempHome, '.claude.json'))).toBe(false)
    expect(await pathExists(path.join(tempHome, '.codex', 'config.toml'))).toBe(false)
  })
})
