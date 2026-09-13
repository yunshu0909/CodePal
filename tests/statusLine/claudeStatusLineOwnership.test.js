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
    // 事务版写入口：最小实现复现"读真实状态 → 交 mutator → 提交"，
    // 并记录 mutator 产出的 next 与调用方给的 options，供断言核验。
    async mutateClaudeSettingsFile(mutator, options = {}) {
      let raw = ''
      let data = {}
      try {
        raw = await fs.readFile(settingsPath, 'utf8')
        data = JSON.parse(raw)
      } catch {
        data = {}
      }
      const outcome = await mutator({
        state: { kind: 'valid', exists: true, errorCode: null, error: null, raw },
        data,
        raw,
        exists: true,
        kind: 'valid',
      })
      if (!outcome || outcome.ok !== true) {
        return {
          success: false,
          backupPath: null,
          errorCode: (outcome && outcome.errorCode) || 'MUTATION_REFUSED',
          error: (outcome && outcome.error) || '变更被拒绝',
          exists: true,
        }
      }
      onWrite(outcome.next, options)
      await fs.writeFile(settingsPath, `${JSON.stringify(outcome.next, null, 2)}\n`, 'utf8')
      return { success: true, backupPath: null, errorCode: null, error: null, exists: true }
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
    // 事务版：备份后缀由调用方声明；原内容由 broker 在事务内读取并备份，
    // 不再依赖调用方回传 previousContent（那是旧接口的传参方式）。
    expect(writes[0].options.backupSuffix).toBe('codepal-usage-status')
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
      mutateClaudeSettingsFile: async () => ({ success: false, errorCode, error }),
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

  it('Q-TC-11: 静默维护不得复活被删除的 settings.json；显式接入可创建', async () => {
    const { usageModule } = loadModuleWithHome(tempHome)
    await fs.writeFile(path.join(tempHome, '.claude', 'codepal-usage-statusline.sh'), '# codepal-script-version: 1\n', { mode: 0o700 })
    const settingsService = loadModuleWithHome(tempHome).settingsModule.createClaudeSettingsService({ pathExists })

    // A) 静默 + 文件不存在 → 不创建
    await fs.rm(settingsPath, { force: true })
    let service = usageModule.createClaudeUsageStatusService({ pathExists, claudeSettingsService: settingsService })
    let result = await service.ensureUsageStatusInstalled({ force: false, intent: 'silent' })
    expect(result.integrationState).toBe('not_configured')
    expect(await pathExists(settingsPath)).toBe(false)

    // B) 未传 intent（老调用方）→ 安全默认静默，同样不创建
    result = await service.ensureUsageStatusInstalled({ force: false })
    expect(await pathExists(settingsPath)).toBe(false)

    // C) 显式接入 + 文件不存在 → 允许创建
    service = usageModule.createClaudeUsageStatusService({ pathExists, claudeSettingsService: settingsService })
    result = await service.ensureUsageStatusInstalled({ force: false, intent: 'explicit' })
    expect(result.success).toBe(true)
    expect(await pathExists(settingsPath)).toBe(true)

    // D) 用户删掉后静默维护 → 不得复活
    await fs.rm(settingsPath, { force: true })
    service = usageModule.createClaudeUsageStatusService({ pathExists, claudeSettingsService: settingsService })
    result = await service.ensureUsageStatusInstalled({ force: false, intent: 'silent' })
    expect(result.integrationState).toBe('not_configured')
    expect(await pathExists(settingsPath)).toBe(false)
  })

  it('Q-TC-10d: 预读看到托管、事务内看到自定义 → 事务必须拒绝写入', async () => {
    // 这是"过期决定"的构造：预读（含 getUsageStatusState 的那次）都看到"托管"，
    // 因此流程一路走到事务；但**盘上内容在事务内读到的是自定义**。
    // 断言：事务必须拒绝，文件逐字节不变。
    // 鉴别力：删掉 mutator 里的所有权检查后，写入会成功、文件被改写 → 本用例失败。
    const { usageModule, settingsModule } = loadModuleWithHome(tempHome)
    const customSettings = {
      statusLine: { type: 'command', command: 'bash "/tmp/changed-between-service-reads.sh"' },
    }
    const managedSettings = {
      statusLine: { type: 'command', command: usageModule.MANAGED_STATUS_COMMAND },
    }
    await fs.writeFile(path.join(tempHome, '.claude', 'codepal-usage-statusline.sh'), '# codepal-script-version: 1\n', { mode: 0o700 })
    // 盘上就是自定义内容——事务内读到的必须是它
    await fs.writeFile(settingsPath, `${JSON.stringify(customSettings, null, 2)}\n`, 'utf8')

    const realService = settingsModule.createClaudeSettingsService({ pathExists })
    const mutateSpy = vi.fn(realService.mutateClaudeSettingsFile)
    const claudeSettingsService = {
      ...realService,
      // 所有预读一律返回"托管"，好让流程**必须**进入事务才能发现真象
      readClaudeSettingsFile: vi.fn().mockResolvedValue({
        success: true,
        exists: true,
        content: `${JSON.stringify(managedSettings)}\n`,
        data: managedSettings,
      }),
      mutateClaudeSettingsFile: mutateSpy,
    }
    const service = usageModule.createClaudeUsageStatusService({ pathExists, claudeSettingsService })

    const before = await fs.readFile(settingsPath, 'utf8')
    const result = await service.ensureUsageStatusInstalled({ force: false })
    const after = await fs.readFile(settingsPath, 'utf8')

    // 事务**确实被打开过**——这正是本用例要证明的：决定权在事务内，不在预读
    expect(mutateSpy).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.integrationState).toBe('conflict')
    expect(result.hasCustomStatusLine).toBe(true)
    // 自定义配置逐字节未被触碰
    expect(after).toBe(before)
  })
})
