/* @vitest-environment node */
/**
 * DSH 扫描层测试（TC-07）
 *
 * 覆盖：
 * - 只扫 DSH 会话日志、按时间窗交给解析器
 * - `~/.dsh` 不存在时返回空数组，不抛
 * - 单个日志损坏/残帧时跳过该文件，其余文件仍返回
 * - 任何异常 fail-soft 返回空数组（作为第三来源不得拖垮整次聚合）
 * - mtime 早于窗口的文件不读取
 *
 * 全部通过 deps 注入假实现，不读真实 ~/.dsh。
 *
 * @module tests/dshUsageScan
 */

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { scanDshLogs, listDshSessionLogs, iterateDshLines } = require('../electron/services/usageLogScanService')

const WINDOW_START = new Date('2026-08-01T00:00:00+08:00')
const WINDOW_END = new Date('2026-09-01T00:00:00+08:00')

/** 最小可用依赖：默认路径存在、无文件、逐帧产出由 iterateFramesFn 注入 */
function baseDeps(overrides = {}) {
  return {
    homeDir: '/home/u',
    pathExistsFn: vi.fn(async () => true),
    listDshSessionLogsFn: vi.fn(async () => []),
    // 同步读取（生产路径逐帧流式消费，不走异步 fs）
    readFileFn: vi.fn(() => Buffer.from('raw')),
    // 逐帧解压由注入替身提供，测试不构造真实 zstd 数据
    iterateFramesFn: vi.fn(() => [Buffer.from('{"type":"session","id":"s"}\n')]),
    collectRecordsFn: vi.fn(() => []),
    ...overrides,
  }
}

describe('TC-07 DSH 扫描层', () => {
  it('扫到 DSH 日志时按窗口交给解析器，并返回其记录', async () => {
    const listed = [{ path: '/home/u/.dsh/sessions/p/s1/session.v3.jsonl.zstd', mtime: new Date('2026-08-13T02:00:00Z') }]
    const records = [{ input: 1, output: 1, cacheRead: 1, cacheCreate: 0 }]
    const collectRecordsFn = vi.fn(() => records)
    const deps = baseDeps({
      listDshSessionLogsFn: vi.fn(async (basePath, start, end) => {
        expect(basePath).toBe('/home/u/.dsh/sessions')
        expect(start).toBe(WINDOW_START)
        // 上界必须传下去：累计至今逐日重算时靠它避免每天都读全部日志
        expect(end).toBe(WINDOW_END)
        return listed
      }),
      collectRecordsFn,
    })

    const result = await scanDshLogs(WINDOW_START, WINDOW_END, deps)

    expect(result).toEqual(records)
    expect(collectRecordsFn).toHaveBeenCalledTimes(1)
    const [files, start, end] = collectRecordsFn.mock.calls[0]
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe(listed[0].path)
    // lines 是逐帧产出的同步可迭代对象，不是一次性数组
    expect(Array.from(files[0].lines)[0]).toContain('"type":"session"')
    expect(start).toBe(WINDOW_START)
    expect(end).toBe(WINDOW_END)
  })

  it('~/.dsh 不存在时返回空数组且不抛', async () => {
    const deps = baseDeps({ pathExistsFn: vi.fn(async () => false) })
    await expect(scanDshLogs(WINDOW_START, WINDOW_END, deps)).resolves.toEqual([])
    expect(deps.listDshSessionLogsFn).not.toHaveBeenCalled()
  })

  it('单个日志读取或解压失败时跳过该文件，其余文件仍返回', async () => {
    const listed = [
      { path: '/home/u/.dsh/sessions/p/s1/session.v3.jsonl.zstd', mtime: new Date('2026-08-13T02:00:00Z') },
      { path: '/home/u/.dsh/sessions/p/s2/session.v3.jsonl.zstd', mtime: new Date('2026-08-14T02:00:00Z') },
    ]
    const readFileFn = vi.fn((filePath) => {
      if (filePath.includes('s1')) throw new Error('EIO')
      return Buffer.from('raw')
    })
    const collectRecordsFn = vi.fn((files) => files.map(f => ({ sessionId: f.path })))
    const deps = baseDeps({
      listDshSessionLogsFn: vi.fn(async () => listed),
      readFileFn,
      collectRecordsFn,
    })

    const result = await scanDshLogs(WINDOW_START, WINDOW_END, deps)

    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toContain('s2')
  })

  it('扫描层整体异常时 fail-soft 返回空数组（第三来源不得拖垮聚合）', async () => {
    const deps = baseDeps({ listDshSessionLogsFn: vi.fn(async () => { throw new Error('EACCES') }) })
    await expect(scanDshLogs(WINDOW_START, WINDOW_END, deps)).resolves.toEqual([])
  })

  it('mtime 早于窗口起点的文件不读取', async () => {
    const listed = [
      { path: '/home/u/.dsh/sessions/p/old/session.v3.jsonl.zstd', mtime: new Date('2026-07-01T00:00:00Z') },
      { path: '/home/u/.dsh/sessions/p/new/session.v3.jsonl.zstd', mtime: new Date('2026-08-13T00:00:00Z') },
    ]
    const readFileFn = vi.fn(() => Buffer.from('raw'))
    const deps = baseDeps({ listDshSessionLogsFn: vi.fn(async () => listed), readFileFn, collectRecordsFn: vi.fn(() => []) })

    await scanDshLogs(WINDOW_START, WINDOW_END, deps)

    expect(readFileFn).toHaveBeenCalledTimes(1)
    expect(readFileFn.mock.calls[0][0]).toContain('/new/')
  })

  it('日志重叠判据用 mtime 下界 + header createdAt 上界，且会话创建晚于窗口的文件被排除', async () => {
    // 这条钉住"累计至今逐日重算"的性能修复：
    // 只按 mtime 下界筛的话，历史每一天都会命中全部日志并整份读取（实测会把主进程读崩）。
    const fileA = '/base/A/session.v3.jsonl.zstd' // 创建于窗口内 → 应保留
    const fileB = '/base/B/session.v3.jsonl.zstd' // 创建于窗口之后 → 应排除
    const fileC = '/base/C/session.v3.jsonl.zstd' // 最后写入早于窗口 → 应排除

    const fsPromises = {
      readdir: vi.fn(async (dir) => {
        if (dir === '/base') {
          return ['A', 'B', 'C'].map(name => ({ name, isDirectory: () => true, isFile: () => false }))
        }
        const name = dir.split('/').pop()
        return [{ name: 'session.v3.jsonl.zstd', isDirectory: () => false, isFile: () => true }]
      }),
      stat: vi.fn(async (filePath) => ({
        size: 100,
        mtime: filePath.includes('/C/') ? new Date('2026-07-01T00:00:00Z') : new Date('2026-08-20T00:00:00Z'),
      })),
    }
    const decompressFirstFrameFn = vi.fn((buffer) => {
      const createdAt = buffer.toString() === 'B'
        ? Date.parse('2026-09-05T00:00:00+08:00') // 晚于窗口结束
        : Date.parse('2026-08-13T00:00:00+08:00') // 落在窗口内
      return Buffer.from(JSON.stringify({ type: 'session', id: 's', createdAt }) + '\n')
    })
    const readFileFn = vi.fn((filePath) => Buffer.from(filePath.includes('/B/') ? 'B' : 'A'))

    const listed = await listDshSessionLogs('/base', WINDOW_START, WINDOW_END, {
      fsPromises,
      readFileFn,
      decompressFirstFrameFn,
    })

    expect(listed.map(item => item.path)).toEqual([fileA])
  })
})

describe('iterateDshLines 跨帧切行（生产主路径，不被注入短路）', () => {
  /** 不变量：逐帧切行的结果必须等于把原始字节整段切行 */
  const splitWhole = (frames) => Buffer.concat(frames).toString()
    .split('\n').filter((line) => line.trim())

  it('帧边界落在行中间时不丢行（残片必须拼到下一帧首段）', () => {
    // 曾经的缺陷：直接覆盖 carry 而不是拼到下一帧首段 → 该行整条丢失
    const frames = [Buffer.from('{"seq":1}\n{"seq":2,"par'), Buffer.from('t":3}\n{"seq":4}\n')]

    const lines = Array.from(iterateDshLines(Buffer.from('x'), { iterateFramesFn: () => frames }))

    expect(lines).toEqual(['{"seq":1}', '{"seq":2,"part":3}', '{"seq":4}'])
    expect(lines).toEqual(splitWhole(frames))
  })

  it('帧边界正好落在换行上时不丢行', () => {
    const frames = [Buffer.from('{"a":1}\n{"b":2'), Buffer.from('\n{"c":3}\n')]

    const lines = Array.from(iterateDshLines(Buffer.from('x'), { iterateFramesFn: () => frames }))

    expect(lines).toEqual(splitWhole(frames))
    expect(lines).toHaveLength(3)
  })

  it('末尾没有换行的半行仍然产出', () => {
    const frames = [Buffer.from('{"a":1}\n{"tail":2')]

    const lines = Array.from(iterateDshLines(Buffer.from('x'), { iterateFramesFn: () => frames }))

    expect(lines).toEqual(['{"a":1}', '{"tail":2'])
    expect(lines).toEqual(splitWhole(frames))
  })

  it('单帧以换行结尾时不产出行尾空串', () => {
    const frames = [Buffer.from('{"a":1}\n{"b":2}\n')]

    expect(Array.from(iterateDshLines(Buffer.from('x'), { iterateFramesFn: () => frames }))).toEqual(['{"a":1}', '{"b":2}'])
  })
})

describe('生产同步路径端到端（真实 zstd，不经注入）', () => {
  it('真实多帧 zstd 日志经 scanDshLogs 产出记录，且跨帧拆行不丢用量', async () => {
    const os = await import('node:os')
    const fsp = await import('node:fs/promises')
    const nodePath = await import('node:path')
    const { zstdCompressSync } = await import('node:zlib')

    const root = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-scan-'))
    const sessionDir = nodePath.join(root, '.dsh', 'sessions', '--Users-u-proj--', 'session-abc')
    await fsp.mkdir(sessionDir, { recursive: true })

    const eventTime = Date.parse('2026-08-13T10:00:00+08:00')
    const raw = [
      JSON.stringify({ type: 'session', version: 3, id: 'session-abc', cwd: '/Users/u/proj', createdAt: eventTime }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 2,
        time: eventTime,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 500 },
        },
      }),
      '',
    ].join('\n')

    // 故意切成两帧，且第二帧从行中间开始 —— 覆盖跨帧残片拼装
    const cut = Math.floor(raw.length / 2)
    const file = Buffer.concat([
      zstdCompressSync(Buffer.from(raw.slice(0, cut))),
      zstdCompressSync(Buffer.from(raw.slice(cut))),
    ])
    await fsp.writeFile(nodePath.join(sessionDir, 'session.v3.jsonl.zstd'), file)

    const records = await scanDshLogs(WINDOW_START, WINDOW_END, { homeDir: root })

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      project: 'proj',
      input: 100,
      output: 10,
      cacheRead: 500,
      cacheCreate: 0,
      sessionId: 'session-abc',
    })

    await fsp.rm(root, { recursive: true, force: true })
  })
})
