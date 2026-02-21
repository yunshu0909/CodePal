/**
 * V0.7 渠道注册表 MVP 后端测试
 *
 * 负责：
 * - 验证 register_provider（本地虚拟入口）可注册新渠道
 * - 验证动态渠道可进入 token 保存与读取链路
 * - 验证 manifest 安全校验可拦截非法 settingsEnv
 *
 * @module 自动化测试/V0.7/tests/unit/backend/providerRegistryMvp.v07.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const { registerProviderHandlers } = require('../../../../../electron/handlers/registerProviderHandlers')

/**
 * 创建 provider handlers 测试环境
 * @param {string} envFilePath - 测试专用 .env 路径
 * @returns {{handlers: Map<string, Function>}}
 */
function createProviderHandlerRuntime(envFilePath) {
  const handlers = new Map()
  const providerRegistryFilePath = path.join(path.dirname(envFilePath), '.provider-manifests.json')
  const ipcMain = {
    handle: (name, fn) => handlers.set(name, fn),
  }

  registerProviderHandlers({
    ipcMain,
    envFilePath,
    providerRegistryFilePath,
    pathExists: async (targetPath) => {
      try {
        await fs.access(targetPath)
        return true
      } catch {
        return false
      }
    },
  })

  return { handlers }
}

describe('V0.7 Provider Registry MVP Backend', () => {
  let tempBasePath
  let envFilePath
  let handlers

  beforeEach(async () => {
    tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'v07-provider-registry-mvp-'))
    envFilePath = path.join(tempBasePath, '.env')
    await fs.writeFile(envFilePath, '', 'utf-8')
    handlers = createProviderHandlerRuntime(envFilePath).handlers
  })

  afterEach(async () => {
    await fs.rm(tempBasePath, { recursive: true, force: true })
  })

  it('UT-V07-MCP-01: 注册新渠道后应可保存并读取 token', async () => {
    const registerManifest = handlers.get('register-provider-manifest')
    const listDefinitions = handlers.get('list-provider-definitions')
    const saveToken = handlers.get('save-provider-token')
    const getEnvConfig = handlers.get('get-provider-env-config')

    const registerResult = await registerManifest({}, {
      id: 'neo-proxy',
      name: 'NeoProxy Gateway',
      baseUrl: 'https://api.neoproxy.dev/anthropic',
      tokenEnvKey: 'NEO_PROXY_API_KEY',
      model: 'opus',
      settingsEnv: {
        ANTHROPIC_MODEL: 'neoproxy-opus',
      },
      icon: 'N',
      color: '#2563eb',
    })

    expect(registerResult.success).toBe(true)
    expect(registerResult.provider?.id).toBe('neo-proxy')

    const listResult = await listDefinitions()
    expect(listResult.success).toBe(true)
    expect(listResult.providers.some((provider) => provider.id === 'neo-proxy')).toBe(true)

    const saveResult = await saveToken({}, 'neo-proxy', 'sk-neo-test-token')
    expect(saveResult.success).toBe(true)

    const envConfigResult = await getEnvConfig()
    expect(envConfigResult.success).toBe(true)
    expect(envConfigResult.providers['neo-proxy']?.token).toBe('sk-neo-test-token')
  })

  it('UT-V07-MCP-02: 非白名单 settingsEnv key 应被拒绝', async () => {
    const registerManifest = handlers.get('register-provider-manifest')

    const registerResult = await registerManifest({}, {
      id: 'unsafe-provider',
      name: 'Unsafe Provider',
      baseUrl: 'https://unsafe.example.com/anthropic',
      tokenEnvKey: 'UNSAFE_PROVIDER_API_KEY',
      settingsEnv: {
        OPENAI_API_KEY: 'should-not-pass',
      },
    })

    expect(registerResult.success).toBe(false)
    expect(registerResult.errorCode).toBe('UNSAFE_SETTINGS_ENV_KEY')
  })
})
