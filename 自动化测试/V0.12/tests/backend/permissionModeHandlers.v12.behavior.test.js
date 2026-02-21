/**
 * V0.12 启动模式后端行为测试
 *
 * 负责：
 * - 校验 get-permission-mode-config 的读取契约与错误分支
 * - 校验 set-permission-mode 的参数校验、备份与写入行为
 * - 校验 IPC 包装层的参数类型保护
 *
 * @module 自动化测试/V0.12/tests/backend/permissionModeHandlers.v12.behavior.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const require = createRequire(import.meta.url)

/**
 * 判断路径是否存在
 * @param {string} checkPath - 目标路径
 * @returns {Promise<boolean>}
 */
async function pathExists(checkPath) {
  try {
    await fs.access(checkPath)
    return true
  } catch {
    return false
  }
}

/**
 * 生成测试 handler 映射
 * @param {object} permissionModule - 待测模块
 * @returns {Map<string, Function>}
 */
function createRegisteredHandlers(permissionModule) {
  const handlers = new Map()
  const ipcMain = {
    handle: (name, fn) => handlers.set(name, fn),
  }

  permissionModule.registerPermissionModeHandlers({
    ipcMain,
    pathExists,
    expandHome: (inputPath) => inputPath,
  })

  return handlers
}

/**
 * 在指定 HOME 下重新加载模块
 *
 * 为什么要这样做：
 * - 目标模块在加载时就会基于 os.homedir() 计算配置文件绝对路径。
 * - 必须先切 HOME 再 require fresh，才能确保读写命中临时目录而不是用户真实目录。
 *
 * @param {string} tempHome - 临时 HOME
 * @returns {object}
 */
function loadPermissionModuleWithHome(tempHome) {
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome

  const modulePath = require.resolve('../../../../electron/handlers/permissionModeHandlers')
  delete require.cache[modulePath]
  return require(modulePath)
}

describe.sequential('V0.12 Permission Mode Handlers', () => {
  let tempHome
  let handlers
  let permissionModule
  let originalHome
  let originalUserProfile
  let settingsPath

  beforeEach(async () => {
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'permission-mode-handler-v12-'))
    permissionModule = loadPermissionModuleWithHome(tempHome)
    handlers = createRegisteredHandlers(permissionModule)
    settingsPath = path.join(tempHome, '.claude', 'settings.json')
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
  })

  it('TC-BE-01: settings.json 不存在时应返回未配置', async () => {
    const getConfig = handlers.get('get-permission-mode-config')

    const result = await getConfig()

    expect(result.success).toBe(true)
    expect(result.isConfigured).toBe(false)
    expect(result.mode).toBeNull()
    expect(result.errorCode).toBeNull()
  })

  it('TC-BE-02: 已知模式应返回已配置且已知模式', async () => {
    const getConfig = handlers.get('get-permission-mode-config')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }, null, 2), 'utf-8')

    const result = await getConfig()

    expect(result.success).toBe(true)
    expect(result.mode).toBe('acceptEdits')
    expect(result.isConfigured).toBe(true)
    expect(result.isKnownMode).toBe(true)
    expect(result.modeName).toBe('自动编辑')
  })

  it('TC-BE-03: 未支持模式值应返回未知模式态', async () => {
    const getConfig = handlers.get('get-permission-mode-config')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify({ permissions: { defaultMode: 'dontAsk' } }, null, 2), 'utf-8')

    const result = await getConfig()

    expect(result.success).toBe(true)
    expect(result.mode).toBe('dontAsk')
    expect(result.isConfigured).toBe(true)
    expect(result.isKnownMode).toBe(false)
  })

  it('TC-BE-04: settings.json JSON 损坏时应返回解析错误', async () => {
    const getConfig = handlers.get('get-permission-mode-config')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, '{"permissions": {"defaultMode": "plan", }', 'utf-8')

    const result = await getConfig()

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('JSON_PARSE_ERROR')
    expect(result.error).toContain('JSON 解析错误')
  })

  it('TC-BE-05: 非法模式写入应被拦截', async () => {
    const setMode = handlers.get('set-permission-mode')

    const result = await setMode({}, 'invalid-mode')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_MODE')
  })

  it('TC-BE-06: 首次写入应创建 settings.json 并写入目标模式', async () => {
    const setMode = handlers.get('set-permission-mode')

    const result = await setMode({}, 'plan')

    expect(result.success).toBe(true)
    expect(await pathExists(settingsPath)).toBe(true)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(parsed.permissions.defaultMode).toBe('plan')
  })

  it('TC-BE-07: 写入时应保留其他字段并生成备份', async () => {
    const setMode = handlers.get('set-permission-mode')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    const originalContent = JSON.stringify({
      permissions: {
        approvalPolicy: 'on-request',
        defaultMode: 'default',
      },
      mcpServers: {
        demo: { enabled: true },
      },
    }, null, 2)
    await fs.writeFile(settingsPath, `${originalContent}\n`, 'utf-8')

    const result = await setMode({}, 'bypassPermissions')

    expect(result.success).toBe(true)
    expect(result.backupPath).toBeTruthy()
    expect(await pathExists(result.backupPath)).toBe(true)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(parsed.permissions.approvalPolicy).toBe('on-request')
    expect(parsed.permissions.defaultMode).toBe('bypassPermissions')
    expect(parsed.mcpServers.demo.enabled).toBe(true)
  })

  it('TC-BE-08: 原文件损坏时应恢复并写入目标模式', async () => {
    const setMode = handlers.get('set-permission-mode')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, '{"permissions": {"defaultMode": "default"', 'utf-8')

    const result = await setMode({}, 'default')

    expect(result.success).toBe(true)
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(parsed.permissions.defaultMode).toBe('default')
  })

  it('TC-BE-09: 非字符串参数应被 IPC 包装层拦截', async () => {
    const setMode = handlers.get('set-permission-mode')

    const result = await setMode({}, 123)

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_ARGUMENT')
  })
})
