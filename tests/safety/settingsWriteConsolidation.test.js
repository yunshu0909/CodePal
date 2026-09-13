/**
 * settings.json 写收口 — 行为测试
 *
 * 负责：
 * - writeClaudeSettingsFile：产物格式、备份落 backups/、入参校验、并发串行
 * - 四个原直写者迁移后端到端回归：permissionMode / modelConfig / usageStatus（时序）/ k28 hooks
 *
 * 手法：先把 HOME 指到临时目录，再 createRequire 加载被测模块
 * （各模块的 settings 路径常量在 require 时从 os.homedir() 求值）
 *
 * @module tests/safety/settingsWriteConsolidation.behavior.test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

let tempHome
let claudeDir
let settingsPath
let backupsDir
let writeClaudeSettingsFile
let setPermissionMode
let setModelConfig
let createClaudeUsageStatusService
let k28Private

const pathExists = async (p) => {
  try { await fs.access(p); return true } catch { return false }
}

async function readSettings() {
  return JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
}

async function listBackups() {
  try { return await fs.readdir(backupsDir) } catch { return [] }
}

beforeAll(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'v198-home-'))
  process.env.HOME = tempHome
  claudeDir = path.join(tempHome, '.claude')
  settingsPath = path.join(claudeDir, 'settings.json')
  backupsDir = path.join(claudeDir, 'backups')
  await fs.mkdir(claudeDir, { recursive: true })

  // HOME 就位后再加载：模块级路径常量在 require 时求值
  ;({ writeClaudeSettingsFile } = require('../../electron/services/claudeSettingsService'))
  ;({ setPermissionMode } = require('../../electron/handlers/permissionModeHandlers'))
  ;({ setModelConfig } = require('../../electron/handlers/modelConfigHandlers'))
  ;({ createClaudeUsageStatusService } = require('../../electron/services/claudeUsageStatusService'))
  k28Private = require('../../electron/services/k28StatusLightService')._private
})

afterAll(async () => {
  await fs.rm(tempHome, { recursive: true, force: true })
})

beforeEach(async () => {
  // 每个用例从干净的 settings 状态开始（backups 保留累计无碍，各用例按增量断言）
  await fs.rm(settingsPath, { force: true })
})

describe('V1.9.8 writeClaudeSettingsFile（唯一写入口）', () => {
  it('SW-1: 写入产物 = 2 空格格式化 JSON + 尾换行，无 tmp 残留', async () => {
    const result = await writeClaudeSettingsFile({ model: 'opus' })
    expect(result.success).toBe(true)
    const raw = await fs.readFile(settingsPath, 'utf-8')
    expect(raw).toBe(`${JSON.stringify({ model: 'opus' }, null, 2)}\n`)
    const claudeFiles = await fs.readdir(claudeDir)
    expect(claudeFiles.some((f) => f.includes('.tmp.'))).toBe(false)
  })

  it('SW-2: previousContent 给定 → 先备份到 ~/.claude/backups/settings-<suffix>-*', async () => {
    const before = await listBackups()
    const result = await writeClaudeSettingsFile({ a: 1 }, { backupSuffix: 'unit-test', previousContent: '{"old":true}' })
    expect(result.success).toBe(true)
    expect(result.backupPath).toBeTruthy()
    const after = await listBackups()
    const fresh = after.filter((f) => !before.includes(f))
    expect(fresh.length).toBe(1)
    expect(fresh[0].startsWith('settings-unit-test-')).toBe(true)
    expect(await fs.readFile(path.join(backupsDir, fresh[0]), 'utf-8')).toBe('{"old":true}')
  })

  it('SW-3: 非普通对象入参 → INVALID_SETTINGS_DATA 且不落盘', async () => {
    for (const bad of [null, [], 'str', 42]) {
      const result = await writeClaudeSettingsFile(bad)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_SETTINGS_DATA')
    }
    expect(fsSync.existsSync(settingsPath)).toBe(false)
  })

  it('SW-4: 并发 10 写全部成功且最终文件是合法 JSON（串行队列不撕裂）', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => writeClaudeSettingsFile({ seq: i, payload: 'x'.repeat(500) }))
    )
    expect(results.every((r) => r.success)).toBe(true)
    const finalData = await readSettings()
    expect(typeof finalData.seq).toBe('number')
    expect(finalData.payload.length).toBe(500)
  })
})

describe('V1.9.8 直写者迁移回归', () => {
  it('SW-5: setPermissionMode 写对字段、返回结构不变、备份进 backups/', async () => {
    await fs.writeFile(settingsPath, `${JSON.stringify({ env: { KEEP: '1' } }, null, 2)}\n`, 'utf-8')
    const result = await setPermissionMode('plan', pathExists)
    expect(result.success).toBe(true)
    expect(result.backupPath).toContain(path.join('.claude', 'backups'))
    const data = await readSettings()
    expect(data.permissions.defaultMode).toBe('plan')
    expect(data.env.KEEP).toBe('1')
  })

  it('SW-6: setModelConfig 写对字段、备份进 backups/', async () => {
    await fs.writeFile(settingsPath, `${JSON.stringify({ permissions: { defaultMode: 'plan' } }, null, 2)}\n`, 'utf-8')
    const result = await setModelConfig('model', 'opus', pathExists)
    expect(result.success).toBe(true)
    expect(result.backupPath).toContain(path.join('.claude', 'backups'))
    const data = await readSettings()
    expect(data.model).toBe('opus')
    expect(data.permissions.defaultMode).toBe('plan')
  })

  it('SW-7: usageStatus 安装时序——settings 写发生在状态栏脚本落盘之后', async () => {
    const scriptPath = path.join(claudeDir, 'codepal-usage-statusline.sh')
    let scriptExistedAtSettingsWrite = null
    const fakeSettingsService = {
      readClaudeSettingsFile: async () => ({ success: true, exists: false, content: '', data: {}, errorCode: null, error: null, backupPath: null }),
      writeClaudeSettingsFile: async (data) => {
        scriptExistedAtSettingsWrite = fsSync.existsSync(scriptPath)
        expect(data.statusLine).toBeTruthy()
        return { success: true, backupPath: null, errorCode: null, error: null }
      },
    }
    const service = createClaudeUsageStatusService({ pathExists, claudeSettingsService: fakeSettingsService })
    await service.ensureUsageStatusInstalled({ force: true })
    expect(scriptExistedAtSettingsWrite).toBe(true)
  })

  it('SW-8: k28 installClaudeHooks 写入 6 组 hooks，备份归位 backups/ 不再散落 .claude 根', async () => {
    await fs.writeFile(settingsPath, `${JSON.stringify({ env: { KEEP: '1' } }, null, 2)}\n`, 'utf-8')
    const before = await listBackups()
    await k28Private.installClaudeHooks()
    const data = await readSettings()
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(Array.isArray(data.hooks[event]), `缺 ${event} hook`).toBe(true)
    }
    expect(data.env.KEEP).toBe('1')
    const after = await listBackups()
    expect(after.filter((f) => f.startsWith('settings-k28-hooks-')).length)
      .toBeGreaterThan(before.filter((f) => f.startsWith('settings-k28-hooks-')).length)
    // 旧行为的散落备份（~/.claude/settings-k28-<ts>.json）不再产生
    const claudeFiles = await fs.readdir(claudeDir)
    expect(claudeFiles.some((f) => /^settings-k28-\d+\.json$/.test(f))).toBe(false)
  })
})
