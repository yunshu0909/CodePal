/**
 * 三源正常、通用日志预览与行级失败（TC-012 / TC-013 / TC-010）
 *
 * 这三项此前只绑在「计划文件」上，代码门 CODE-002 指出缺少可审核证据，这里用合成夹具补齐。
 * 不读真实用户日志，进 CI。
 *
 * @module tests/usageEquivalence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { scanLogFilesInRange } = require('../electron/logScanner.js')
const { scanClaudeLogs, scanCodexLogs } = require('../electron/services/usageLogScanService.js')

const DAY = new Date(Date.UTC(2026, 7, 9, 0, 0, 0))
const NEXT = new Date(Date.UTC(2026, 7, 10, 0, 0, 0))

let home

function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  fs.utimesSync(file, DAY, DAY)
}

/** 一条 Claude 用量行 */
function claudeLine(id, tokens) {
  return JSON.stringify({
    timestamp: '2026-08-09T10:00:00.000Z',
    cwd: '/Users/u/proj',
    message: { id, model: 'claude-opus-5', usage: { input_tokens: tokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })
}

/** 一条 Codex 用量事件（含文件开头的模型上下文） */
function codexLines() {
  return [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: '/Users/u/proj' } }),
    JSON.stringify({ type: 'session_meta', payload: {} }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-09T11:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, output_tokens: 2, cached_input_tokens: 0, total_tokens: 22 } } } })
  ]
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-equiv-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('TC-012：三源可读时正常产出且无降级告警', () => {
  it('Claude 与 Codex 各自产出记录，且不出现降级告警', async () => {
    write(path.join(home, '.claude', 'projects', 'p', 's1.jsonl'), [claudeLine('m1', 5)])
    write(path.join(home, '.codex', 'sessions', '2026', '08', '09', 'rollout-abc.jsonl'), codexLines())

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const claude = await scanClaudeLogs(DAY, NEXT, { homeDir: home })
    const codex = await scanCodexLogs(DAY, NEXT, { homeDir: home })

    expect(claude.length).toBe(1)
    // 视图层的别名归一化会把模型 id 映射成展示名
    expect(String(claude[0].model)).toMatch(/opus/i)
    expect(codex.length).toBeGreaterThan(0)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('TC-013：通用日志预览保留原始行与自定义行数预算', () => {
  it('非用量预览返回原始行内容，且自定义 maxLinesPerFile 生效', async () => {
    const preview = path.join(home, 'preview')
    const raw = [
      JSON.stringify({ type: 'assistant', text: '第一行正文' }),
      JSON.stringify({ type: 'assistant', text: '第二行正文' }),
      JSON.stringify({ type: 'assistant', text: '第三行正文' })
    ]
    write(path.join(preview, 'a.jsonl'), raw)

    // 不传 usage 选项 → 通用预览路径
    const all = await scanLogFilesInRange(preview, DAY, NEXT, {})
    expect(all.files[0].lines).toEqual(raw)

    const lastTwo = await scanLogFilesInRange(preview, DAY, NEXT, { maxLinesPerFile: 2 })
    expect(lastTwo.files[0].lines).toEqual(raw.slice(-2))

    // 用量预筛只作用于用量路径；通用预览不得丢正文
    const viaClaude = await scanLogFilesInRange(preview, DAY, NEXT, { claudeUsageOnly: true })
    expect(viaClaude.files[0].lines.filter((l) => l.includes('正文')).length).toBe(0)
  })
})

describe('TC-010：行级失败只跳过该行（第三级见 usageSpanIndex）', () => {
  it('同文件里的坏 JSON 行不吞掉其余有效记录', async () => {
    const file = path.join(home, '.claude', 'projects', 'p', 'mixed.jsonl')
    write(file, [claudeLine('good-1', 3), '{ this is not json', claudeLine('good-2', 4)])

    const records = await scanClaudeLogs(DAY, NEXT, { homeDir: home })
    expect(records.map((r) => r.messageId).sort()).toEqual(['good-1', 'good-2'])
  })
})
