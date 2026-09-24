/**
 * 失败如实上报 + 测试 / CI 接线（架构优化 B2-3）
 *
 * 负责：
 * - 自动增量导入：配置保存失败时结果为失败（界面仍按原设计不弹提示）
 * - 共享用量统计：来源失败时记下原因（原来只记 failed）
 * - CI 在 dev 分支的 push / PR 上跑测试；覆盖率统计包含主进程 electron/
 *
 * @module tests/honestFailures.test
 */
/* @vitest-environment node */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createImportService } from '../src/store/services/importService.js'

const require = createRequire(import.meta.url)
const { createSharedUsageStatistics } = require('../electron/services/sharedUsageStatistics')
const root = path.resolve(__dirname, '..')

describe('B2-3 失败如实上报', () => {
  it('H-3 自动增量导入：新增了 Skill 但配置保存失败 → success=false 且带错误', async () => {
    const config = { version: '0.4', repoPath: '/repo', customPaths: [], pushStatus: {}, pushTargets: ['claude'], importSources: ['claude'] }
    const deps = {
      getRepoPath: vi.fn(async () => '/repo'),
      getConfig: vi.fn(async () => structuredClone(config)),
      saveConfig: vi.fn(async () => ({ success: false, error: 'CONFIG_CORRUPTED' })),
      setFirstEntryAfterImport: vi.fn(),
      getCentralSkills: vi.fn(async () => []),
      getCentralSkillPath: vi.fn(async (name) => `/repo/${name}`),
      getToolSkillPath: vi.fn((toolPath, name) => `${toolPath}/${name}`),
      deleteSkill: vi.fn(async () => ({ success: true })),
      copySkill: vi.fn(async () => ({ success: true })),
      ensureDir: vi.fn(async () => ({ success: true })),
      scanToolDirectory: vi.fn(async () => ({ success: true, skills: [{ name: 'fresh' }] })),
      scanCustomPath: vi.fn(async () => ({ success: true, skills: {} })),
      buildCustomToolPath: vi.fn((base, toolPath) => `${base}/${toolPath}`),
      compareSkillContent: vi.fn(),
      clearPushStatusCache: vi.fn(),
      toolDefinitions: [{ id: 'claude', name: 'Claude', path: '/tool/claude' }],
      DEFAULT_REPO_PATH: '/default-repo',
    }
    const service = createImportService(deps)
    const result = await service.autoIncrementalRefresh()
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.errors)).toMatch(/CONFIG_CORRUPTED|save/i)
  })

  it('H-4 共享用量统计：来源失败时记下原因', async () => {
    const entries = new Map()
    const storage = { read: async (k) => structuredClone(entries.get(k) || null), write: async (k, v) => entries.set(k, structuredClone(v)), list: async () => [...entries.keys()].filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)) }
    const scanFn = vi.fn(async (id) => {
      if (id === 'dsh') throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return []
    })
    const service = createSharedUsageStatistics({ storage, scanFn, sourceStatusFn: async () => 'present', earliestFn: async () => '2026-09-17', legacyReadFn: async () => null, nowFn: () => new Date('2026-09-17T04:00:00Z') })
    await service.getCalendar({ month: '2026-09' })
    expect(entries.get('2026-09-17').sources.dsh).toMatchObject({ status: 'failed', reason: 'EACCES' })
  })
})

describe('B2-3 CI 与覆盖率接线', () => {
  it('H-5 CI 在 dev 的 push 与 PR 上跑测试', () => {
    const yml = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf-8')
    const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'))
    expect(on).toMatch(/push:[\s\S]*branches:\s*\[[^\]]*\bdev\b/)
    expect(on).toMatch(/pull_request:[\s\S]*branches:\s*\[[^\]]*\bdev\b/)
  })

  it('H-6 覆盖率统计包含主进程 electron/', () => {
    const cfg = readFileSync(path.join(root, 'vitest.config.js'), 'utf-8')
    expect(cfg).toMatch(/include:\s*\[[^\]]*'electron\/\*\*\/\*\.\{js,mjs\}'/)
  })
})
