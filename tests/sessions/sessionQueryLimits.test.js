/**
 * 对话回顾查询的工作量上限与取消（架构优化 B2-4）
 *
 * 负责：
 * - 单页条数有上限；单页有字节预算，超了先停，剩下的用「加载更早」接着读
 * - 超长行（如内嵌图片）读取时不反复整段复制（按复制字节数验证，不靠计时）
 * - 搜索可取消；同一窗口发起新搜索时，主进程里上一次搜索立即停
 *
 * @module tests/sessions/sessionQueryLimits.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import { createRequire } from 'node:module'
import { L, stamp, makeProjectsDir } from './fixtures'

const require = createRequire(import.meta.url)
const service = require('../../electron/services/sessionBrowserService.js')
const reader = require('../../electron/services/sessionFileReader.js')
const { registerSessionBrowserHandlers } = require('../../electron/handlers/registerSessionBrowserHandlers.js')

const CWD = `${os.homedir()}/Documents/trae_projects/skills`
let p
beforeEach(() => { p = makeProjectsDir() })
afterEach(() => p.cleanup())

describe('B2-4 读对话：条数与字节上限', () => {
  it('Q-1 页面传再大的 limit，一页也最多 500 条', async () => {
    const lines = []
    for (let i = 0; i < 700; i++) lines.push(L.user(`问题 ${i}`))
    p.write('-proj', 's1', stamp([L.mode(), ...lines], { cwd: CWD }))
    const page = await service.readSessionPage('-proj', 's1', { limit: 1e9, projectsDir: p.dir })
    expect(page.messages.length).toBe(500)
    expect(page.hasMore).toBe(true)
  })

  it('Q-2 一页超过字节预算先停，剩下的用 before 接着读，前后不重不漏', async () => {
    const big = 'y'.repeat(3 * 1024 * 1024)
    const lines = []
    for (let i = 0; i < 6; i++) lines.push(L.user(`第${i}条 ${big}`))
    p.write('-proj', 's2', stamp([L.mode(), ...lines], { cwd: CWD }))
    const first = await service.readSessionPage('-proj', 's2', { projectsDir: p.dir })
    expect(first.messages.length).toBeGreaterThanOrEqual(1)
    expect(first.messages.length).toBeLessThan(6)
    expect(first.hasMore).toBe(true)
    const seen = [...first.messages]
    let cursor = first.cursor
    while (cursor > 0) {
      const next = await service.readSessionPage('-proj', 's2', { before: cursor, projectsDir: p.dir })
      if (next.messages.length === 0) break
      seen.unshift(...next.messages)
      cursor = next.cursor
    }
    expect(seen.map((m) => m.text.slice(0, 4))).toEqual(['第0条 ', '第1条 ', '第2条 ', '第3条 ', '第4条 ', '第5条 '])
  })

  it('Q-3 超长行不反复整段复制（倒读与正读）', async () => {
    const line = JSON.stringify({ type: 'progress', data: 'z'.repeat(8 * 1024 * 1024) })
    const file = p.write('-proj', 's3', [line])
    reader.resetReaderStats()
    await reader.scanBackward(file, {}, () => true)
    expect(reader.getReaderStats().bytesCopied).toBeLessThan(3 * line.length)
    reader.resetReaderStats()
    await reader.scanForward(file, () => true)
    expect(reader.getReaderStats().bytesCopied).toBeLessThan(3 * line.length)
  })
})

describe('B2-4 搜索可取消', () => {
  it('Q-4 已取消的搜索不再扫文件', async () => {
    p.write('-proj', 's4', stamp([L.mode(), L.user('关键词 在这')], { cwd: CWD }))
    const controller = new AbortController()
    controller.abort()
    await expect(service.searchSessions('关键词', { projectsDir: p.dir, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('Q-5 同一窗口发起新搜索时，上一次搜索被取消', async () => {
    const handlers = new Map()
    const signals = []
    const fakeService = {
      listRecent: vi.fn(), readSessionPage: vi.fn(),
      searchSessions: vi.fn((kw, opts) => { signals.push(opts.signal); return new Promise(() => {}) }),
    }
    registerSessionBrowserHandlers({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, service: fakeService })
    const event = { sender: { id: 7 } }
    handlers.get('session:search')(event, '第一次', {})
    handlers.get('session:search')(event, '第二次', {})
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    handlers.get('session:search')({ sender: { id: 8 } }, '别的窗口', {})
    expect(signals[1].aborted).toBe(false)
  })
})
