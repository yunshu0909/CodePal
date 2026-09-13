/**
 * 逐工具护栏：Codex 侧不做行数截断
 *
 * `scanLogFilesInRange` 的 `maxLinesPerFile`（默认 10000，只取末尾 N 个非空行）**只作用于 Claude**。
 * Codex 的计量需要完整事件链（模型上下文与窗口前基线可能在文件开头），因此即使显式传入很小的
 * `maxLinesPerFile`，也必须保留全部事件。把 Claude 的尾部截断泛化到 Codex 即为行为漂移。
 *
 * 对应 spec：SC-004 / AC-004 / TC-004（第 4 步断言），INV-001。
 *
 * @module tests/codexUsageNoTruncation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { scanLogFilesInRange } = require('../electron/logScanner.js')

let dir
const MTIME = new Date(Date.UTC(2026, 7, 9, 0, 0, 0))

function writeCodexLog(name) {
  const lines = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: '/tmp/proj' } }),
    JSON.stringify({ type: 'session_meta', payload: {} }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-09T01:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0, total_tokens: 11 } } } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-09T02:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, output_tokens: 2, cached_input_tokens: 0, total_tokens: 22 } } } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-09T03:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 30, output_tokens: 3, cached_input_tokens: 0, total_tokens: 33 } } } })
  ]
  const full = path.join(dir, name)
  fs.writeFileSync(full, lines.join('\n') + '\n', 'utf-8')
  fs.utimesSync(full, MTIME, MTIME)
  return full
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-guard-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Codex 逐工具护栏', () => {
  it('maxLinesPerFile 很小也保留完整事件链（含文件开头的 turn_context）', async () => {
    writeCodexLog('sess.jsonl')

    const result = await scanLogFilesInRange(dir, MTIME, new Date(Date.UTC(2026, 7, 10)), {
      codexUsageOnly: true,
      maxLinesPerFile: 2
    })

    const lines = result.files[0].lines
    const events = lines.map((l) => JSON.parse(l))

    // 5 行全部保留：没有被 maxLinesPerFile=2 截断
    expect(lines.length).toBe(5)
    // 开头的事件（模型上下文）仍然在 —— 截断会把它丢掉并让模型归属退化
    expect(events.some((e) => e.type === 'turn_context')).toBe(true)
    expect(events.filter((e) => e.type === 'event_msg').length).toBe(3)
  })

  it('Claude 侧同样参数下只取末尾 N 个非空行（两侧语义不同，不得互相泛化）', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ timestamp: `2026-08-09T0${i + 1}:00:00.000Z`, message: { id: `m${i}`, usage: { input_tokens: i } } })
    )
    const full = path.join(dir, 'claude.jsonl')
    fs.writeFileSync(full, lines.join('\n') + '\n', 'utf-8')
    fs.utimesSync(full, MTIME, MTIME)

    const result = await scanLogFilesInRange(dir, MTIME, new Date(Date.UTC(2026, 7, 10)), {
      claudeUsageOnly: true,
      maxLinesPerFile: 2
    })

    // 末尾 2 行：m3 / m4（m0 被截掉）
    const kept = result.files[0].lines.map((l) => JSON.parse(l).message.id)
    expect(kept).toEqual(['m3', 'm4'])
  })
})
