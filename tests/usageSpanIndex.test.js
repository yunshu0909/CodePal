/**
 * 用量重算路径 · 第二步：窗口级枚举 + 按天候选资格
 *
 * 覆盖 `createLogScanWindowContext`（每窗口枚举一次、每文件解析一次）与逐日独立扫描的
 * **逐条等价**，以及最容易踩错的一条：跨日文件不得把事件计入「原本没有选中它」的那一天。
 *
 * 对应 spec：SC-002 / AC-002 / TC-002，以及方案门 Astra SOL-003 的硬约束。
 *
 * @module tests/usageSpanIndex
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { scanLogFilesInRange, createLogScanWindowContext } = require('../electron/logScanner.js')

let dir

/** 建一个 .jsonl 文件并指定 mtime */
function writeLog(name, lines, mtime) {
  const full = path.join(dir, name)
  fs.writeFileSync(full, lines.join('\n') + '\n', 'utf-8')
  fs.utimesSync(full, mtime, mtime)
  return full
}

const day = (n) => new Date(Date.UTC(2026, 7, n, 0, 0, 0)) // 2026-08-n 00:00Z

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-span-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('窗口上下文与逐日独立扫描等价', () => {
  it('每一天选中的文件集合与 scanLogFilesInRange 逐条相同', async () => {
    writeLog('a.jsonl', ['{"t":1}'], day(1))
    writeLog('b.jsonl', ['{"t":2}'], day(3))
    writeLog('c.jsonl', ['{"t":3}'], day(5))

    const ctx = createLogScanWindowContext(day(1))

    for (const d of [day(1), day(2), day(3), day(4), day(5), day(6)]) {
      const legacy = await scanLogFilesInRange(dir, d, day(d.getUTCDate() + 1), {})
      const viaCtx = await ctx.scanForDay(dir, d, {})

      const legacyPaths = legacy.files.map((f) => f.path).sort()
      const ctxPaths = viaCtx.files.map((f) => f.path).sort()

      expect(ctxPaths).toEqual(legacyPaths)
      expect(viaCtx.totalMatched).toBe(legacy.totalMatched)
      expect(viaCtx.scannedCount).toBe(legacy.scannedCount)
      expect(viaCtx.truncated).toBe(legacy.truncated)
    }
  })

  it('maxFiles 截断按天重建，顺序与旧实现一致（取 mtime 最新前 N）', async () => {
    writeLog('old.jsonl', ['{"t":1}'], day(1))
    writeLog('mid.jsonl', ['{"t":2}'], day(4))
    writeLog('new.jsonl', ['{"t":3}'], day(9))

    const options = { maxFiles: 1 }
    const ctx = createLogScanWindowContext(day(1))

    // 第 2 天：old(第1天) 低于下界被排除；mid/new 满足 → 取 mtime 最新的 1 个（new）
    const d2Legacy = await scanLogFilesInRange(dir, day(2), day(3), options)
    const d2Ctx = await ctx.scanForDay(dir, day(2), options)
    expect(d2Ctx.files.map((f) => f.path).sort()).toEqual(d2Legacy.files.map((f) => f.path).sort())
    expect(d2Ctx.files.map((f) => path.basename(f.path))).toEqual(['new.jsonl'])
    expect(d2Ctx.truncated).toBe(true)

    // 第 1 天：三个文件都满足下界 → 截断仍然成立，且与旧实现选中同一个
    const d1Legacy = await scanLogFilesInRange(dir, day(1), day(2), options)
    const d1Ctx = await ctx.scanForDay(dir, day(1), options)
    expect(d1Ctx.files.map((f) => f.path).sort()).toEqual(d1Legacy.files.map((f) => f.path).sort())
    expect(d1Ctx.truncated).toBe(true)

    // 第 6 天：只有 new 满足下界 → 不再截断
    const d6Ctx = await ctx.scanForDay(dir, day(6), options)
    expect(d6Ctx.files.map((f) => path.basename(f.path))).toEqual(['new.jsonl'])
    expect(d6Ctx.truncated).toBe(false)
  })
})

describe('跨日候选资格（方案门 Astra SOL-003）', () => {
  it('mtime 落在前一天的文件，不会被计入原本没选中它的那一天', async () => {
    // 文件 mtime 在第 1 天，但内部含第 2 天的记录
    const day2Event = JSON.stringify({ timestamp: day(2).toISOString(), usage: { input_tokens: 5 } })
    writeLog('carry.jsonl', [day2Event], day(1))

    const ctx = createLogScanWindowContext(day(1))

    // 第 1 天：文件被选中，能读到那条记录
    const d1 = await ctx.scanForDay(dir, day(1), {})
    expect(d1.files.map((f) => path.basename(f.path))).toEqual(['carry.jsonl'])

    // 第 2 天：mtime 下界把该文件排除 → 不产出任何文件
    // 若实现改成「按事件时间落桶」，这里就会错误地把第 2 天的事件算进第 2 天
    const d2 = await ctx.scanForDay(dir, day(2), {})
    expect(d2.files).toEqual([])

    // 与旧实现口径一致（旧实现在第 2 天同样不含它）
    const legacyD2 = await scanLogFilesInRange(dir, day(2), day(3), {})
    expect(legacyD2.files).toEqual([])
  })
})

describe('枚举失败不跨天记忆（CODE-001 回归）', () => {
  it('首次 stat 失败导致的候选遗漏，不会让后续日期也漏掉恢复后的文件', async () => {
    const real = path.join(dir, 'recovered.jsonl')
    fs.writeFileSync(real, '{"t":1}\n', 'utf-8')
    fs.utimesSync(real, day(9), day(9))

    let calls = 0
    const enumerateFn = async () => {
      calls += 1
      // 第一次：模拟 stat 失败 → 不完整的枚举结果
      if (calls === 1) return { candidates: [], failed: 1 }
      return { candidates: [{ path: real, mtime: day(9) }], failed: 0 }
    }

    const ctx = createLogScanWindowContext(day(1), { enumerateFn })

    // 第 1 天：候选集不完整，读不到文件
    const d1 = await ctx.scanForDay(dir, day(1), {})
    expect(d1.files).toEqual([])

    // 第 2 天：因为上次枚举带失败，必须重新枚举 → 发现已恢复的文件
    const d2 = await ctx.scanForDay(dir, day(2), {})
    expect(d2.files.map((f) => path.basename(f.path))).toEqual(['recovered.jsonl'])
    expect(calls).toBe(2)
  })

  it('枚举失败不影响成功枚举的复用（成绩好的那次仍只枚举一次）', async () => {
    const real = path.join(dir, 'ok.jsonl')
    fs.writeFileSync(real, '{"t":1}\n', 'utf-8')
    fs.utimesSync(real, day(9), day(9))

    let calls = 0
    const enumerateFn = async () => {
      calls += 1
      return { candidates: [{ path: real, mtime: day(9) }], failed: 0 }
    }

    const ctx = createLogScanWindowContext(day(1), { enumerateFn })
    for (const d of [day(1), day(2), day(3)]) await ctx.scanForDay(dir, d, {})
    expect(calls).toBe(1)
  })
})

describe('每窗口只枚举一次、每文件只解析一次', () => {
  it('同一文件被多天选中时只读取一次', async () => {
    // mtime 落在第 9 天 → 第 1..9 天的 mtime 下界都放行，因此会被多天共同选中
    writeLog('shared.jsonl', ['{"t":1}'], day(9))

    const ctx = createLogScanWindowContext(day(1))
    for (const d of [day(1), day(3), day(9)]) {
      const result = await ctx.scanForDay(dir, d, {})
      expect(result.files.map((f) => path.basename(f.path))).toEqual(['shared.jsonl'])
    }

    const stats = ctx.stats()
    expect(stats.enumerated).toBe(1)
    expect(stats.parsedFiles).toBe(1)
  })

  it('读取失败只影响当次，恢复后后续日期会重试（CODE-001 回归）', async () => {
    writeLog('ok.jsonl', ['{"t":1}'], day(9))
    // 真文件但去掉读权限：枚举能 stat 到它，读取一定失败
    const broken = writeLog('broken.jsonl', ['{"t":2}'], day(9))
    fs.chmodSync(broken, 0o000)

    const ctx = createLogScanWindowContext(day(1))

    // 第 1 天：坏文件被跳过
    const d1 = await ctx.scanForDay(dir, day(1), {})
    expect(d1.files.map((f) => path.basename(f.path))).toEqual(['ok.jsonl'])

    // 恢复可读后，**同一个窗口上下文**在第 2 天必须重新尝试并读到它
    fs.chmodSync(broken, 0o644)
    const d2 = await ctx.scanForDay(dir, day(2), {})
    expect(d2.files.map((f) => path.basename(f.path)).sort()).toEqual(['broken.jsonl', 'ok.jsonl'])

    // 成功结果才跨天复用：此时缓存里是 ok + broken 两条成功记录
    expect(ctx.stats().parsedFiles).toBe(2)
  })
})
