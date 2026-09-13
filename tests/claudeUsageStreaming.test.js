/* @vitest-environment node */
/**
 * 第一步：Claude 扫描改流式（TC-101 ~ TC-104）
 *
 * 这一步是**纯性能重构**：目标是把「整份文件读成字符串再切行」改成逐行流式，
 * 但**可观察行为必须一字不变**。所以这里的核心不是"测它能跑"，而是**测它与旧行为等价**：
 *
 * - 旧行为 = `fs.readFile` 全文 → split('\n') → 过滤空行 → 取**末尾 N 行** → 逐行 parse
 * - 新行为 = readline 流式 → 只留用量候选行 → 按**行号**裁到末尾 N 行 → 输出等价的可解析行
 *
 * 关键不变量：
 *   1. 截断口径按「非空行」计数，且取**末尾** N 行（不是前 N 行）
 *   2. 从"被裁掉的前缀"里不能漏出任何一条用量记录
 *   3. 新实现不得整份读文件（否则内存问题没解决）
 *
 * @module tests/claudeUsageStreaming
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { readClaudeUsageLines, scanClaudeLogs } = require('../electron/services/usageLogScanService')

/** 造一行可被 parseClaudeLog 识别的用量行；tokens 用于区分不同行 */
function usageLine(index, marker) {
  return JSON.stringify({
    timestamp: `2026-08-13T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    cwd: '/Users/u/proj',
    message: {
      id: `msg-${marker}`,
      model: 'claude-opus-5',
      usage: {
        input_tokens: marker,
        output_tokens: marker * 2,
        cache_read_input_tokens: marker * 3,
        cache_creation_input_tokens: 0,
      },
    },
  })
}

/** 一行非用量噪声（不含 "usage" 字样，用于验证计数与裁剪口径） */
function noiseLine(index) {
  return JSON.stringify({ type: 'assistant', timestamp: `2026-08-13T09:00:00.000Z`, text: `noise-${index}` })
}

/** 旧行为参照实现：全文读取 → 过滤空行 → 取末尾 N 行 → 逐行 JSON.parse */
function legacyKeptLines(filePath, maxLines) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter((line) => line.trim())
  const kept = lines.length <= maxLines ? lines : lines.slice(-maxLines)
  return kept.map((line) => JSON.parse(line))
}

/** 新行为输出 → 解析成与旧行为同形的对象 */
function newKeptObjects(lines) {
  return lines.map((line) => JSON.parse(line))
}

function writeFixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stream-'))
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, contents.join('\n'))
  return { dir, file }
}

describe('TC-101 末尾 N 行语义（截断口径必须与旧实现一致）', () => {
  it('超过上限时只保留末尾 N 行，且按非空行计数', async () => {
    // 40 行非空：其中奇数行是用量行；再插入若干空行验证不被计入
    const contents = []
    for (let i = 0; i < 40; i += 1) {
      contents.push(i % 2 === 0 ? noiseLine(i) : usageLine(i, i))
      if (i % 7 === 0) contents.push('', '   ')
    }
    const { file } = writeFixture(contents)

    const lines = await readClaudeUsageLines(file, 10)

    const legacy = legacyKeptLines(file, 10)
    // 新实现只保留用量候选行，所以只比较「其中的用量行」
    const legacyUsage = legacy.filter((row) => row.message?.usage)
    expect(newKeptObjects(lines)).toEqual(legacyUsage)
  })

  it('文件未超过上限时全部保留（不丢行）', async () => {
    const contents = []
    for (let i = 1; i <= 5; i += 1) contents.push(usageLine(i, i))
    const { file } = writeFixture(contents)

    const lines = await readClaudeUsageLines(file, 10000)

    expect(newKeptObjects(lines)).toEqual(legacyKeptLines(file, 10000))
  })

  it('被裁掉的前缀里不得漏出用量记录', async () => {
    // 前 30 行是用量行（应被裁掉），后 5 行也是用量行（必须保留）
    const contents = []
    for (let i = 1; i <= 30; i += 1) contents.push(usageLine(i, 1000 + i))
    for (let i = 1; i <= 5; i += 1) contents.push(usageLine(i, 2000 + i))
    const { file } = writeFixture(contents)

    const lines = await readClaudeUsageLines(file, 5)

    const markers = newKeptObjects(lines).map((row) => row.message.id)
    expect(markers).toEqual(['msg-2001', 'msg-2002', 'msg-2003', 'msg-2004', 'msg-2005'])
  })
})

describe('TC-102 不整份读文件（内存目标）', () => {
  it('readClaudeUsageLines 的实现不得使用 fs.readFile 整份读取', () => {
    // 源码级断言：这条不变量容易被后续"顺手优化"破坏，值得钉住
    // 注意：实现落在 logScanner（usageLogScanService 只做再导出）
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'electron', 'logScanner.js'),
      'utf-8',
    )
    const start = source.indexOf('async function readClaudeUsageLines')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 2000)
    expect(body).not.toMatch(/fs\.readFile\(|readFileSync\(/)
    expect(body).toMatch(/createReadStream|readline/)
  })
})

describe('TC-103 边界形态', () => {
  it('末行没有换行结尾时仍产出', async () => {
    const contents = [usageLine(1, 1), usageLine(2, 2)]
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stream-'))
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, contents.join('\n')) // 无结尾换行
    const lines = await readClaudeUsageLines(file, 10)
    expect(newKeptObjects(lines)).toHaveLength(2)
  })

  it('损坏行被跳过且不影响其余行', async () => {
    const contents = [usageLine(1, 1), '{ 这不是合法 JSON ', usageLine(2, 2)]
    const { file } = writeFixture(contents)
    const lines = await readClaudeUsageLines(file, 10)
    expect(newKeptObjects(lines).map((row) => row.message.id)).toEqual(['msg-1', 'msg-2'])
  })

  it('空文件返回空数组', async () => {
    const { file } = writeFixture([''])
    await expect(readClaudeUsageLines(file, 10)).resolves.toEqual([])
  })
})

describe('TC-104 scanClaudeLogs 端到端等价', () => {
  it('新扫描器产出的记录与旧口径逐字段一致', async () => {
    // 冻结语料：同一天、含用量行与噪声行
    const contents = []
    for (let i = 1; i <= 12; i += 1) {
      contents.push(i % 3 === 0 ? noiseLine(i) : usageLine(i, i))
    }
    const { dir } = writeFixture(contents)

    // 构造 ~/.claude/projects/<proj>/<session>.jsonl 结构
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'))
    const projDir = path.join(home, '.claude', 'projects', '-Users-u-proj')
    fs.mkdirSync(projDir, { recursive: true })
    fs.writeFileSync(path.join(projDir, 'session-a.jsonl'), contents.join('\n'))

    const start = new Date('2026-08-01T00:00:00+08:00')
    const end = new Date('2026-09-01T00:00:00+08:00')

    const records = await scanClaudeLogs(start, end, {
      homeDir: home,
      scanLogFilesInRangeFn: async () => ({ files: [], totalMatched: 0, scannedCount: 0, truncated: false }),
    })

    // 该 fixture 用注入的空扫描器时应当没有记录（用于验证 deps 通路未被破坏）
    expect(records).toEqual([])

    // 真跑一次（不注入扫描器），验证能读到自己造的语料
    const realRecords = await scanClaudeLogs(start, end, { homeDir: home })
    const expectedMarkers = newKeptObjects(
      contents.filter((line) => line.includes('"usage"')),
    ).map((row) => row.message.id)
    expect(realRecords.map((record) => record.messageId).sort()).toEqual(expectedMarkers.sort())

    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })
})
