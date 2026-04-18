/**
 * V0.16 模型配置与推理等级后端行为测试
 *
 * 负责：
 * - 校验 get-model-config 的读取契约与错误分支
 * - 校验 set-model-config 的参数校验、备份与写入行为
 * - 校验 IPC 包装层的参数类型保护
 *
 * @module 自动化测试/V0.16/tests/backend/modelConfigHandlers.v16.behavior.test
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
 * @param {object} modelConfigModule - 待测模块
 * @returns {Map<string, Function>}
 */
function createRegisteredHandlers(modelConfigModule) {
  const handlers = new Map()
  const ipcMain = {
    handle: (name, fn) => handlers.set(name, fn),
  }

  modelConfigModule.registerModelConfigHandlers({
    ipcMain,
    pathExists,
  })

  return handlers
}

/**
 * 在指定 HOME 下重新加载模块
 *
 * 为什么要这样做：
 * - 目标模块和其依赖在加载时会读取 os.homedir() 计算绝对路径。
 * - 必须先切 HOME 再 require fresh，才能确保读写命中临时目录。
 *
 * @param {string} tempHome - 临时 HOME
 * @returns {object}
 */
function loadModelConfigModuleWithHome(tempHome) {
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome

  const permissionModulePath = require.resolve('../../../../electron/handlers/permissionModeHandlers')
  const modelConfigModulePath = require.resolve('../../../../electron/handlers/modelConfigHandlers')

  delete require.cache[permissionModulePath]
  delete require.cache[modelConfigModulePath]

  return require(modelConfigModulePath)
}

describe.sequential('V0.16 Model Config Handlers', () => {
  let tempHome
  let handlers
  let modelConfigModule
  let originalHome
  let originalUserProfile
  let settingsPath

  beforeEach(async () => {
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'model-config-handler-v16-'))
    modelConfigModule = loadModelConfigModuleWithHome(tempHome)
    handlers = createRegisteredHandlers(modelConfigModule)
    settingsPath = path.join(tempHome, '.claude', 'settings.json')
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
  })

  it('TC-BE-01: settings.json 不存在时应返回未配置', async () => {
    const getConfig = handlers.get('get-model-config')

    const result = await getConfig()

    expect(result.success).toBe(true)
    expect(result.model).toBeNull()
    expect(result.effortLevel).toBeNull()
    expect(result.isModelConfigured).toBe(false)
    expect(result.isEffortConfigured).toBe(false)
  })

  it('TC-BE-02: model 与 effortLevel 都存在时应完整返回', async () => {
    const getConfig = handlers.get('get-model-config')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify({ model: 'opus[1m]', effortLevel: 'high' }, null, 2), 'utf-8')

    const result = await getConfig()

    expect(result.success).toBe(true)
    expect(result.model).toBe('opus[1m]')
    expect(result.effortLevel).toBe('high')
    expect(result.isModelConfigured).toBe(true)
    expect(result.isEffortConfigured).toBe(true)
  })

  it('TC-BE-03: 部分配置时应独立返回配置状态', async () => {
    const getConfig = handlers.get('get-model-config')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify({ model: 'sonnet' }, null, 2), 'utf-8')

    const result = await getConfig()

    expect(result.success).toBe(true)
    expect(result.model).toBe('sonnet')
    expect(result.effortLevel).toBeNull()
    expect(result.isModelConfigured).toBe(true)
    expect(result.isEffortConfigured).toBe(false)
  })

  it('TC-BE-04: settings.json JSON 损坏时应返回解析错误', async () => {
    const getConfig = handlers.get('get-model-config')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, '{"model":"opus",}', 'utf-8')

    const result = await getConfig()

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('JSON_PARSE_ERROR')
    expect(result.error).toContain('JSON 解析错误')
  })

  it('TC-BE-05: 非法 field 应被拦截', async () => {
    const setConfig = handlers.get('set-model-config')

    const result = await setConfig({}, 'unknownField', 'value')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_FIELD')
  })

  it('TC-BE-06: 空字符串 value 应被拦截', async () => {
    const setConfig = handlers.get('set-model-config')

    const result = await setConfig({}, 'model', '  ')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_VALUE')
  })

  it('TC-BE-07: 格式非法的 effortLevel 应被拦截（值本身的合法性交给 Claude Code 判定）', async () => {
    const setConfig = handlers.get('set-model-config')

    // 大写字母违反 EFFORT_LEVEL_PATTERN
    const result = await setConfig({}, 'effortLevel', 'HIGH!')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_EFFORT_LEVEL')
  })

  it('TC-BE-08: 首次写入 model 应创建 settings.json', async () => {
    const setConfig = handlers.get('set-model-config')

    const result = await setConfig({}, 'model', 'sonnet')

    expect(result.success).toBe(true)
    expect(await pathExists(settingsPath)).toBe(true)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(parsed.model).toBe('sonnet')
  })

  it('TC-BE-09: 写入 effortLevel 时应保留其他字段并生成备份', async () => {
    const setConfig = handlers.get('set-model-config')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    const originalContent = JSON.stringify({
      model: 'sonnet',
      effortLevel: 'medium',
      permissions: { defaultMode: 'plan' },
      extra: { keep: true },
    }, null, 2)
    await fs.writeFile(settingsPath, `${originalContent}\n`, 'utf-8')

    const result = await setConfig({}, 'effortLevel', 'high')

    expect(result.success).toBe(true)
    expect(result.backupPath).toBeTruthy()
    expect(await pathExists(result.backupPath)).toBe(true)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(parsed.model).toBe('sonnet')
    expect(parsed.effortLevel).toBe('high')
    expect(parsed.permissions.defaultMode).toBe('plan')
    expect(parsed.extra.keep).toBe(true)
  })

  it('TC-BE-10: 写入 model 时不应覆盖已有 effortLevel（回归）', async () => {
    const setConfig = handlers.get('set-model-config')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify({
      model: 'opus[1m]',
      effortLevel: 'high',
      permissions: { defaultMode: 'acceptEdits' },
    }, null, 2), 'utf-8')

    const result = await setConfig({}, 'model', 'claude-opus-4-6')

    expect(result.success).toBe(true)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(parsed.model).toBe('claude-opus-4-6')
    expect(parsed.effortLevel).toBe('high')
    expect(parsed.permissions.defaultMode).toBe('acceptEdits')
  })

  it('TC-BE-11: 原文件损坏时应自动恢复并完成写入', async () => {
    const setConfig = handlers.get('set-model-config')

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, '{"model":"sonnet"', 'utf-8')

    const result = await setConfig({}, 'effortLevel', 'low')

    expect(result.success).toBe(true)
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(parsed.effortLevel).toBe('low')
  })

  it('TC-BE-12: IPC 参数非字符串应被包装层拦截', async () => {
    const setConfig = handlers.get('set-model-config')

    const result = await setConfig({}, 'model', 123)

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_ARGUMENT')
  })
})
