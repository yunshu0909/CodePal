/**
 * #101 Skills 重开后先显示上次的：主进程这一侧
 * - 「上次的列表和次数」存在 CodePal 自己的数据目录，原子写，坏了自己删掉，删了下次读完重建
 * - 读快照、写操作带回快照、次数聚合之后各存一份；新通道一次拿回两份
 * 所有写入只在临时家目录。
 * @module tests/skills/lastView/lastViewMain.test
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeHome } from '../inbox/helpers.js'

const require = createRequire(import.meta.url)
const store = require('../../../electron/modules/skills/lastViewStore')
const { registerSkillControlHandlers } = require('../../../electron/handlers/registerSkillControlHandlers')
const { registerSkillUsageHandlers } = require('../../../electron/handlers/registerSkillUsageHandlers')

let env
let dir
beforeEach(async () => {
  env = await makeHome('last-view')
  dir = path.join(env.dataDir, 'last-view')
})
afterEach(async () => { await env.cleanup() })

const snap = (names = ['alpha']) => ({ generatedAt: '2026-11-21T02:00:00Z', skills: names.map((name) => ({ name, managed: true })), tools: {} })
const usageData = () => ({
  batchId: '11111111-2222-3333-4444-555555555555',
  window: 30,
  endTime: '2026-11-21T02:00:00.000Z',
  skills: [{ name: 'alpha', assetId: 'asset_aaaaaaaaaaaaaaaaaaaaaaaa', total: 4, confirmedTotal: 4, claude: 4, codex: 0, completeness: 'complete', availability: 'available', batchId: '11111111-2222-3333-4444-555555555555' }],
  records: [{ invocationId: 'x', session: { relativePath: 'projects/secret/one.jsonl' } }],
  assets: [{ assetId: 'asset_aaaaaaaaaaaaaaaaaaaaaaaa' }],
  subagentRuns: [{ runId: 'r1' }],
  scanMeta: { lastScannedAt: '2026-11-21T02:00:00.000Z', sources: { claude: 'available' } },
  sources: { claude: 'available' },
})

describe('#101 lastViewStore 存取', () => {
  it('TC-101-01 存了能读回；次数只留摘要（不带批次号和调用明细）', async () => {
    expect(await store.readLastView(env.homeDir)).toEqual({ snapshot: null, usage: null })
    expect(await store.saveLastSnapshot(env.homeDir, { repoPath: env.repoPath, snapshot: snap() })).toBe(true)
    expect(await store.saveLastUsage(env.homeDir, { cacheKey: 'key-1', windowDays: 30, data: usageData() })).toBe(true)
    const view = await store.readLastView(env.homeDir)
    expect(view.snapshot.repoPath).toBe(env.repoPath)
    expect(view.snapshot.data.skills[0].name).toBe('alpha')
    expect(view.usage.cacheKey).toBe('key-1')
    expect(view.usage.data.skills[0].total).toBe(4)
    expect(view.usage.data.skills[0].batchId).toBeUndefined()
    const text = await fs.readFile(path.join(dir, 'usage.json'), 'utf8')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('r1')
    expect(view.usage.data.scanMeta.lastScannedAt).toBe('2026-11-21T02:00:00.000Z')
    // 只给自己读写
    expect((await fs.stat(path.join(dir, 'snapshot.json'))).mode & 0o077).toBe(0)
  })

  it('TC-101-02 坏了的当场删掉、当作没有；另一份不受影响；删了下次存时重建', async () => {
    await store.saveLastSnapshot(env.homeDir, { repoPath: env.repoPath, snapshot: snap() })
    await store.saveLastUsage(env.homeDir, { cacheKey: 'key-1', windowDays: 30, data: usageData() })
    await fs.writeFile(path.join(dir, 'snapshot.json'), '{"format":1,"repoPath":"/x","snaps')
    let view = await store.readLastView(env.homeDir)
    expect(view.snapshot).toBeNull()
    expect(view.usage?.cacheKey).toBe('key-1')
    await expect(fs.access(path.join(dir, 'snapshot.json'))).rejects.toThrow()
    // 格式号不对、缺字段也算坏的
    await fs.writeFile(path.join(dir, 'usage.json'), JSON.stringify({ format: 99, cacheKey: 'k', data: { skills: [] } }))
    view = await store.readLastView(env.homeDir)
    expect(view.usage).toBeNull()
    await expect(fs.access(path.join(dir, 'usage.json'))).rejects.toThrow()
    await fs.rm(dir, { recursive: true, force: true })
    expect(await store.saveLastSnapshot(env.homeDir, { repoPath: env.repoPath, snapshot: snap(['beta']) })).toBe(true)
    expect((await store.readLastView(env.homeDir)).snapshot.data.skills[0].name).toBe('beta')
  })

  it('TC-101-03 原子写：写失败保留原文件、不留临时文件；连着存只留最新那份', async () => {
    await store.saveLastSnapshot(env.homeDir, { repoPath: env.repoPath, snapshot: snap(['old']) })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    expect(await store.saveLastSnapshot(env.homeDir, { repoPath: env.repoPath, snapshot: snap(['broken']) })).toBe(false)
    rename.mockRestore()
    expect((await store.readLastView(env.homeDir)).snapshot.data.skills[0].name).toBe('old')
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    const saves = ['a', 'b', 'c', 'd'].map((name) => store.saveLastSnapshot(env.homeDir, { repoPath: env.repoPath, snapshot: snap([name]) }))
    await Promise.all(saves)
    expect((await store.readLastView(env.homeDir)).snapshot.data.skills[0].name).toBe('d')
  })

  it('TC-101-04 太大的不存；不像快照的不存', async () => {
    const huge = snap()
    huge.skills[0].description = 'x'.repeat(store.MAX_BYTES + 10)
    expect(await store.saveLastSnapshot(env.homeDir, { repoPath: env.repoPath, snapshot: huge })).toBe(false)
    expect(await store.saveLastSnapshot(env.homeDir, { repoPath: env.repoPath, snapshot: { nope: true } })).toBe(false)
    expect(await store.saveLastSnapshot(env.homeDir, { repoPath: '', snapshot: snap() })).toBe(false)
    expect((await store.readLastView(env.homeDir)).snapshot).toBeNull()
  })
})

describe('#101 IPC：读完存一份，新通道拿回', () => {
  const setupControl = (overrides = {}) => {
    const handlers = {}
    const deps = {
      getSkillControlSnapshotFn: vi.fn(async () => snap(['alpha'])),
      executeSkillCommandFn: vi.fn(async () => ({ outcome: 'done' })),
      resolveSkillRepoPathFn: vi.fn(async () => env.repoPath),
      migrateLegacyCodexDisablesFn: vi.fn(async () => null),
      ...overrides,
    }
    registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir: env.homeDir }, deps)
    return { handlers, deps }
  }

  it('TC-101-05 读快照成功后存一份（带资产库）；last-view 一次拿回快照和次数', async () => {
    const { handlers } = setupControl()
    expect(handlers['skill-control:last-view']).toBeTypeOf('function')
    expect((await handlers['skill-control:last-view']({})).data).toEqual({ snapshot: null, usage: null })
    const response = await handlers['skill-control:get-snapshot']({})
    expect(response.success).toBe(true)
    await vi.waitFor(async () => {
      const view = await handlers['skill-control:last-view']({})
      expect(view.success).toBe(true)
      expect(view.data.snapshot?.repoPath).toBe(env.repoPath)
      expect(view.data.snapshot?.data.skills.map((skill) => skill.name)).toEqual(['alpha'])
    })
  })

  it('TC-101-06 写操作带回的快照也存：重开后看到的是操作之后的样子', async () => {
    let enabled = true
    const { handlers } = setupControl({
      getSkillControlSnapshotFn: vi.fn(async () => ({ ...snap(['alpha']), skills: [{ name: 'alpha', managed: true, tools: { codex: { enabled } } }] })),
      executeSkillCommandFn: vi.fn(async () => { enabled = false; return { outcome: 'done' } }),
    })
    await handlers['skill-control:get-snapshot']({})
    const result = await handlers['skill-control:execute']({}, { skillName: 'alpha', toolId: 'codex', action: 'disable' })
    expect(result.success).toBe(true)
    await vi.waitFor(async () => {
      const view = await handlers['skill-control:last-view']({})
      expect(view.data.snapshot?.data.skills[0].tools.codex.enabled).toBe(false)
    })
  })

  it('TC-101-07 读快照失败不存、不清掉上次的', async () => {
    await store.saveLastSnapshot(env.homeDir, { repoPath: env.repoPath, snapshot: snap(['kept']) })
    const { handlers } = setupControl({ getSkillControlSnapshotFn: vi.fn(async () => { throw new Error('SCAN_FAILED') }) })
    expect((await handlers['skill-control:get-snapshot']({})).success).toBe(false)
    const view = await handlers['skill-control:last-view']({})
    expect(view.data.snapshot.data.skills[0].name).toBe('kept')
  })

  it('TC-101-08 次数聚合带身份键就存摘要；不合法的身份键拒掉；不带不存', async () => {
    const handlers = new Map()
    const runUsageFn = vi.fn(async () => usageData())
    registerSkillUsageHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, homeDir: env.homeDir, runUsageFn })
    const aggregate = handlers.get('skill-usage:aggregate')
    expect((await aggregate({}, { skillNames: ['alpha'], windowDays: 30 })).success).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await store.readLastView(env.homeDir)).usage).toBeNull()
    expect((await aggregate({}, { skillNames: ['alpha'], windowDays: 30, cacheKey: 42 })).success).toBe(false)
    const response = await aggregate({}, { skillNames: ['alpha'], windowDays: 30, cacheKey: '[30,["alpha"],"id"]' })
    expect(response.success).toBe(true)
    // 页面这次拿到的仍是完整结果（带批次号，明细要用）
    expect(response.data.batchId).toBe('11111111-2222-3333-4444-555555555555')
    expect(runUsageFn.mock.calls.at(-1)[2]).not.toHaveProperty('cacheKey')
    await vi.waitFor(async () => {
      const view = await store.readLastView(env.homeDir)
      expect(view.usage?.cacheKey).toBe('[30,["alpha"],"id"]')
      expect(view.usage?.data.skills[0].total).toBe(4)
    })
  })
})
