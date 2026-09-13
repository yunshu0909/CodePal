/**
 * V1.9.9 Claude 自定义 statusLine 后端保护测试
 *
 * @module tests/statusLine/claudeStatusLineOwnership.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const require = createRequire(import.meta.url)

async function pathExists(checkPath) {
  try {
    await fs.access(checkPath)
    return true
  } catch {
    return false
  }
}

function loadModuleWithHome(tempHome) {
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome
  process.env.PATH = '/nonexistent'
  for (const modulePath of [
    require.resolve('../../electron/services/claudeUsageStatusService'),
    require.resolve('../../electron/services/claudeSettingsService'),
  ]) {
    delete require.cache[modulePath]
  }
  return {
    usageModule: require('../../electron/services/claudeUsageStatusService'),
    settingsModule: require('../../electron/services/claudeSettingsService'),
  }
}

function createSettingsService(settingsPath, onWrite = () => {}) {
  return {
    async readClaudeSettingsFile() {
      const content = await fs.readFile(settingsPath, 'utf8')
      return { success: true, exists: true, content, data: JSON.parse(content) }
    },
    async writeClaudeSettingsFile(data, options) {
      onWrite(data, options)
      await fs.writeFile(settingsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      return { success: true }
    },
  }
}

describe.sequential('V1.9.9 Claude statusLine ownership', () => {
  let tempHome
  let settingsPath
  let originalEnv

  beforeEach(async () => {
    originalEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      PATH: process.env.PATH,
    }
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-statusline-ownership-'))
    settingsPath = path.join(tempHome, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  })

  afterEach(async () => {
    process.env.HOME = originalEnv.HOME
    process.env.USERPROFILE = originalEnv.USERPROFILE
    process.env.PATH = originalEnv.PATH
    await fs.rm(tempHome, { recursive: true, force: true })
  })

  it('Q-TC-09: 未确认时不覆盖自定义 statusLine', async () => {
    const customSettings = {
      statusLine: { type: 'command', command: 'bash "/tmp/my-statusline.sh"' },
    }
    await fs.writeFile(settingsPath, `${JSON.stringify(customSettings, null, 2)}\n`, 'utf8')
    const { usageModule: moduleUnderTest } = loadModuleWithHome(tempHome)
    const service = moduleUnderTest.createClaudeUsageStatusService({
      pathExists,
      claudeSettingsService: createSettingsService(settingsPath),
    })

    const result = await service.ensureUsageStatusInstalled({ force: false })
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'))

    expect(result.integrationState).toBe('conflict')
    expect(after.statusLine.command).toBe('bash "/tmp/my-statusline.sh"')
  })

  it('Q-TC-09b: 明确确认后携带原内容请求备份再接管', async () => {
    const originalContent = `${JSON.stringify({
      statusLine: { type: 'command', command: 'bash "/tmp/my-statusline.sh"' },
    }, null, 2)}\n`
    await fs.writeFile(settingsPath, originalContent, 'utf8')
    const writes = []
    const { usageModule: moduleUnderTest } = loadModuleWithHome(tempHome)
    const service = moduleUnderTest.createClaudeUsageStatusService({
      pathExists,
      claudeSettingsService: createSettingsService(settingsPath, (data, options) => writes.push({ data, options })),
    })

    const result = await service.ensureUsageStatusInstalled({ force: true })

    expect(result.success).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0].options.backupSuffix).toBe('codepal-usage-status')
    expect(writes[0].options.previousContent).toBe(originalContent)
    expect(writes[0].data.statusLine.command).toBe(moduleUnderTest.MANAGED_STATUS_COMMAND)
  })

  it('Q-TC-09c: 后端基于真实 settings 分类未配置、自定义与 CodePal 托管', async () => {
    const { usageModule: moduleUnderTest } = loadModuleWithHome(tempHome)
    const settingsService = createSettingsService(settingsPath)
    const service = moduleUnderTest.createClaudeUsageStatusService({ pathExists, claudeSettingsService: settingsService })

    await fs.writeFile(settingsPath, '{}\n', 'utf8')
    expect((await service.getUsageStatusState()).integrationState).toBe('not_configured')

    await fs.writeFile(settingsPath, `${JSON.stringify({
      statusLine: { type: 'command', command: 'bash "/tmp/custom.sh"' },
    })}\n`, 'utf8')
    const conflict = await service.getUsageStatusState()
    expect(conflict.integrationState).toBe('conflict')
    expect(conflict.hasCustomStatusLine).toBe(true)

    await fs.writeFile(service.scriptPath, '# codepal-script-version: 7\n', { mode: 0o700 })
    await fs.writeFile(settingsPath, `${JSON.stringify({
      statusLine: { type: 'command', command: moduleUnderTest.MANAGED_STATUS_COMMAND },
    })}\n`, 'utf8')
    const managed = await service.getUsageStatusState()
    expect(managed.integrationState).toBe('waiting_for_data')
    expect(managed.usesManagedStatusLine).toBe(true)
  })

  it('Q-TC-09d: 真实唯一写入口先产生备份再替换 settings', async () => {
    const originalContent = `${JSON.stringify({
      statusLine: { type: 'command', command: 'bash "/tmp/custom.sh"' },
    }, null, 2)}\n`
    await fs.writeFile(settingsPath, originalContent, 'utf8')
    const { usageModule, settingsModule } = loadModuleWithHome(tempHome)
    const realSettingsService = settingsModule.createClaudeSettingsService({ pathExists })
    const service = usageModule.createClaudeUsageStatusService({ pathExists, claudeSettingsService: realSettingsService })

    const result = await service.ensureUsageStatusInstalled({ force: true })
    const backupDir = path.join(tempHome, '.claude', 'backups')
    const backups = await fs.readdir(backupDir)
    const backupName = backups.find((name) => name.includes('codepal-usage-status'))
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'))

    expect(result.success).toBe(true)
    expect(backupName).toBeTruthy()
    expect(await fs.readFile(path.join(backupDir, backupName), 'utf8')).toBe(originalContent)
    expect(after.statusLine.command).toBe(usageModule.MANAGED_STATUS_COMMAND)
  })

  it.each([
    ['PERMISSION_DENIED', '无法写入 Claude settings 备份'],
    ['WRITE_FAILED', '写入 Claude settings.json 失败'],
  ])('Q-TC-09e: settings 写入链路 %s 时保留自定义配置', async (errorCode, error) => {
    const original = { statusLine: { type: 'command', command: 'bash "/tmp/custom.sh"' } }
    await fs.writeFile(settingsPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8')
    const { usageModule } = loadModuleWithHome(tempHome)
    const failingSettingsService = {
      ...createSettingsService(settingsPath),
      writeClaudeSettingsFile: async () => ({ success: false, errorCode, error }),
    }
    const service = usageModule.createClaudeUsageStatusService({ pathExists, claudeSettingsService: failingSettingsService })

    const result = await service.ensureUsageStatusInstalled({ force: true })
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'))

    expect(result.success).toBe(false)
    expect(result.integrationState).toBe('setup_failed')
    expect(result.errorCode).toBe(errorCode)
    expect(after.statusLine.command).toBe(original.statusLine.command)
  })

  it('Q-TC-10c: 静默升级写入前所有权变为自定义时拒绝覆盖', async () => {
    const { usageModule } = loadModuleWithHome(tempHome)
    const settingsService = createSettingsService(settingsPath)
    const service = usageModule.createClaudeUsageStatusService({ pathExists, claudeSettingsService: settingsService })
    await fs.writeFile(service.scriptPath, '# codepal-script-version: 1\n', { mode: 0o700 })
    await fs.writeFile(settingsPath, `${JSON.stringify({
      statusLine: { type: 'command', command: usageModule.MANAGED_STATUS_COMMAND },
    })}\n`, 'utf8')

    const observed = await service.getUsageStatusState()
    expect(observed.usesManagedStatusLine).toBe(true)
    expect(observed.scriptOutdated).toBe(true)

    const customCommand = 'bash "/tmp/changed-after-read.sh"'
    await fs.writeFile(settingsPath, `${JSON.stringify({
      statusLine: { type: 'command', command: customCommand },
    })}\n`, 'utf8')

    const result = await service.ensureUsageStatusInstalled({ force: false })
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    expect(result.integrationState).toBe('conflict')
    expect(after.statusLine.command).toBe(customCommand)
  })

  it('Q-TC-10d: service 内第二次读取发现自定义时零写入', async () => {
    const { usageModule } = loadModuleWithHome(tempHome)
    const managedSettings = {
      statusLine: { type: 'command', command: usageModule.MANAGED_STATUS_COMMAND },
    }
    const customSettings = {
      statusLine: { type: 'command', command: 'bash "/tmp/changed-between-service-reads.sh"' },
    }
    await fs.writeFile(path.join(tempHome, '.claude', 'codepal-usage-statusline.sh'), '# codepal-script-version: 1\n', { mode: 0o700 })
    const writeClaudeSettingsFile = vi.fn()
    const claudeSettingsService = {
      readClaudeSettingsFile: vi.fn()
        .mockResolvedValueOnce({ success: true, exists: true, content: `${JSON.stringify(managedSettings)}\n`, data: managedSettings })
        .mockResolvedValueOnce({ success: true, exists: true, content: `${JSON.stringify(customSettings)}\n`, data: customSettings }),
      writeClaudeSettingsFile,
    }
    const service = usageModule.createClaudeUsageStatusService({ pathExists, claudeSettingsService })

    const result = await service.ensureUsageStatusInstalled({ force: false })

    expect(claudeSettingsService.readClaudeSettingsFile).toHaveBeenCalledTimes(2)
    expect(result.integrationState).toBe('conflict')
    expect(result.hasCustomStatusLine).toBe(true)
    expect(writeClaudeSettingsFile).not.toHaveBeenCalled()
    expect(await pathExists(service.configPath)).toBe(false)
  })
})
