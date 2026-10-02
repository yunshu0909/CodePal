/**
 * 失败如实上报 + 测试 / CI 接线（架构优化 B2-3）
 *
 * 负责：
 * - （H-3 自动增量导入已随 Skills 旧引擎退役删除，v2.1.9）
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

const require = createRequire(import.meta.url)
const { createSharedUsageStatistics } = require('../electron/services/sharedUsageStatistics')
const root = path.resolve(__dirname, '..')

describe('B2-3 失败如实上报', () => {
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
    // 分别截出 push 与 pull_request 两段（审核 note：原正则会从 push 跨进 pull_request，删掉 push 的 dev 也照样通过）
    const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'))
    const push = on.slice(on.indexOf('push:'), on.indexOf('pull_request:'))
    const pr = on.slice(on.indexOf('pull_request:'))
    expect(push).toMatch(/branches:\s*\[[^\]]*\bdev\b/)
    expect(pr).toMatch(/branches:\s*\[[^\]]*\bdev\b/)
  })

  it('H-6 覆盖率统计包含主进程 electron/', () => {
    const cfg = readFileSync(path.join(root, 'vitest.config.js'), 'utf-8')
    expect(cfg).toMatch(/include:\s*\[[^\]]*'electron\/\*\*\/\*\.\{js,mjs\}'/)
  })
})
