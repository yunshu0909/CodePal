/**
 * V0.6 用量聚合行为测试
 *
 * 负责：
 * - 校验总 Token 公式与指标汇总
 * - 校验 <=5 与 >5 模型场景的分布规则
 * - 校验并列总量时排序稳定
 * - 校验坏行容错不影响整体聚合
 *
 * @module 自动化测试/V0.6/tests/unit/store/usageAggregator.v06.behavior.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { aggregateUsage } from '@/store/usageAggregator.js'

/**
 * 构造 Claude 日志行
 * @param {{timestamp: string, model: string, messageId?: string, input?: number, output?: number, cacheRead?: number, cacheCreate?: number}} payload - 日志字段
 * @returns {string}
 */
function buildClaudeLogLine(payload) {
  return JSON.stringify({
    timestamp: payload.timestamp,
    message: {
      id: payload.messageId,
      model: payload.model,
      usage: {
        input_tokens: payload.input ?? 0,
        output_tokens: payload.output ?? 0,
        cache_read_input_tokens: payload.cacheRead ?? 0,
        cache_creation_input_tokens: payload.cacheCreate ?? 0
      }
    }
  })
}

/**
 * 构造 Codex token_count 日志行（累计口径）
 * @param {{timestamp: string, inputTotal: number, outputTotal: number, cacheReadTotal: number, totalTokens?: number}} payload - 日志字段
 * @returns {string}
 */
function buildCodexTokenCountLine(payload) {
  const totalTokens = payload.totalTokens ?? (payload.inputTotal + payload.outputTotal + payload.cacheReadTotal)
  return JSON.stringify({
    timestamp: payload.timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: payload.inputTotal,
          cached_input_tokens: payload.cacheReadTotal,
          output_tokens: payload.outputTotal,
          total_tokens: totalTokens
        },
        last_token_usage: {
          input_tokens: 1,
          cached_input_tokens: 1,
          output_tokens: 1,
          total_tokens: 3
        }
      }
    }
  })
}

/**
 * 执行 today 聚合
 * @param {string[]} claudeLines - Claude 日志行
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function aggregateTodayWithClaudeLines(claudeLines) {
  window.electronAPI = {
    scanLogFiles: vi.fn(async ({ basePath }) => {
      if (basePath === '~/.claude/projects') {
        return {
          success: true,
          files: [{ path: '/tmp/mock-claude.jsonl', mtime: '2026-02-15T03:00:00.000Z', lines: claudeLines }],
          totalMatched: 1,
          scannedCount: 1,
          truncated: false,
          error: null
        }
      }

      return {
        success: true,
        files: [],
        totalMatched: 0,
        scannedCount: 0,
        truncated: false,
        error: null
      }
    })
  }

  return aggregateUsage('today')
}

/**
 * 执行 today 聚合（支持注入 Claude/Codex 文件）
 * @param {{claudeFiles?: Array<{path: string, lines: string[]}>, codexFiles?: Array<{path: string, lines: string[]}>}} payload - 模拟文件列表
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function aggregateTodayWithMockFiles(payload) {
  const claudeFiles = payload?.claudeFiles || []
  const codexFiles = payload?.codexFiles || []

  window.electronAPI = {
    scanLogFiles: vi.fn(async ({ basePath }) => {
      if (basePath === '~/.claude/projects') {
        return {
          success: true,
          files: claudeFiles.map(file => ({
            path: file.path,
            mtime: '2026-02-15T03:00:00.000Z',
            lines: file.lines
          })),
          totalMatched: claudeFiles.length,
          scannedCount: claudeFiles.length,
          truncated: false,
          error: null
        }
      }

      if (basePath === '~/.codex/sessions') {
        return {
          success: true,
          files: codexFiles.map(file => ({
            path: file.path,
            mtime: '2026-02-15T03:00:00.000Z',
            lines: file.lines
          })),
          totalMatched: codexFiles.length,
          scannedCount: codexFiles.length,
          truncated: false,
          error: null
        }
      }

      return {
        success: true,
        files: [],
        totalMatched: 0,
        scannedCount: 0,
        truncated: false,
        error: null
      }
    })
  }

  return aggregateUsage('today')
}

describe('usageAggregator V0.6 Behavior (Unit)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 固定北京时间 2026-02-15 11:00，确保所有记录处于 today 窗口内
    vi.setSystemTime(new Date('2026-02-15T03:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('UT-BE-AGG-01: 总 Token 应等于 input + output + cacheRead + cacheCreate', async () => {
    const result = await aggregateTodayWithClaudeLines([
      buildClaudeLogLine({
        timestamp: '2026-02-15T08:00:00+08:00',
        model: 'sonnet',
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheCreate: 40
      })
    ])

    expect(result.success).toBe(true)
    expect(result.data.total).toBe(100)
    expect(result.data.input).toBe(10)
    expect(result.data.output).toBe(20)
    expect(result.data.cache).toBe(70)
    expect(result.data.models[0].total).toBe(100)
  })

  it('UT-BE-AGG-02: 模型数 <= 5 时 distribution 不应出现“其他”', async () => {
    const result = await aggregateTodayWithClaudeLines([
      buildClaudeLogLine({ timestamp: '2026-02-15T01:00:00+08:00', model: 'model-a', input: 100 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T02:00:00+08:00', model: 'model-b', input: 80 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T03:00:00+08:00', model: 'model-c', input: 20 })
    ])

    expect(result.success).toBe(true)
    expect(result.data.models).toHaveLength(3)
    expect(result.data.distribution).toHaveLength(3)
    expect(result.data.distribution.some(item => item.key === 'others')).toBe(false)
  })

  it('UT-BE-AGG-03: 模型数 > 5 时应展示 Top5 + 其他', async () => {
    const result = await aggregateTodayWithClaudeLines([
      buildClaudeLogLine({ timestamp: '2026-02-15T01:00:00+08:00', model: 'model-1', input: 700 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:01:00+08:00', model: 'model-2', input: 600 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:02:00+08:00', model: 'model-3', input: 500 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:03:00+08:00', model: 'model-4', input: 400 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:04:00+08:00', model: 'model-5', input: 300 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:05:00+08:00', model: 'model-6', input: 200 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:06:00+08:00', model: 'model-7', input: 100 })
    ])

    expect(result.success).toBe(true)
    expect(result.data.isExtremeScenario).toBe(true)
    expect(result.data.models).toHaveLength(7)
    expect(result.data.distribution).toHaveLength(6)
    expect(result.data.distribution.map(item => item.name)).toEqual([
      'model-1',
      'model-2',
      'model-3',
      'model-4',
      'model-5',
      '其他 (2个模型)'
    ])
    expect(result.data.distribution[5].percent).toBe(11)
  })

  it('UT-BE-AGG-04: 同总量模型应按名称升序稳定排序', async () => {
    const result = await aggregateTodayWithClaudeLines([
      buildClaudeLogLine({ timestamp: '2026-02-15T01:00:00+08:00', model: 'zeta', input: 10 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:01:00+08:00', model: 'alpha', input: 10 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:02:00+08:00', model: 'beta', input: 10 })
    ])

    expect(result.success).toBe(true)
    expect(result.data.models.map(model => model.name)).toEqual(['alpha', 'beta', 'zeta'])
  })

  it('UT-BE-AGG-05: 日志坏行应被跳过，且合法行仍可统计', async () => {
    const result = await aggregateTodayWithClaudeLines([
      '{"timestamp":"2026-02-15T01:00:00+08:00","message":{"usage":{"input_tokens":1}',
      buildClaudeLogLine({ timestamp: '2026-02-15T01:01:00+08:00', model: 'codex', input: 9 })
    ])

    expect(result.success).toBe(true)
    expect(result.data.recordCount).toBe(1)
    expect(result.data.total).toBe(9)
    expect(result.data.models.map(model => model.name)).toEqual(['codex'])
  })

  it('UT-BE-AGG-06: 0 消耗模型应从 models/distribution 过滤', async () => {
    const result = await aggregateTodayWithClaudeLines([
      buildClaudeLogLine({ timestamp: '2026-02-15T01:00:00+08:00', model: 'model-a', input: 30 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:01:00+08:00', model: 'model-b', input: 20 }),
      buildClaudeLogLine({ timestamp: '2026-02-15T01:02:00+08:00', model: 'model-zero', input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
    ])

    expect(result.success).toBe(true)
    expect(result.data.models.map(model => model.name)).toEqual(['model-a', 'model-b'])
    expect(result.data.distribution.map(item => item.name)).toEqual(['model-a', 'model-b'])
  })

  it('UT-BE-AGG-07: Codex 应按 session 累计快照计算窗口增量并去重', async () => {
    const result = await aggregateTodayWithMockFiles({
      codexFiles: [
        {
          path: '/tmp/rollout-2026-02-15T10-00-00-019c5f06-c6e8-7f50-add2-6865b618d549.jsonl',
          lines: [
            // 窗口前基线（北京时间 2/14 23:59）
            buildCodexTokenCountLine({
              timestamp: '2026-02-14T15:59:00.000Z',
              inputTotal: 60,
              outputTotal: 10,
              cacheReadTotal: 30
            }),
            // 窗口内累计值
            buildCodexTokenCountLine({
              timestamp: '2026-02-14T16:10:00.000Z',
              inputTotal: 80,
              outputTotal: 10,
              cacheReadTotal: 50
            }),
            // 重复快照（同 total，不应重复累计）
            buildCodexTokenCountLine({
              timestamp: '2026-02-14T16:10:05.000Z',
              inputTotal: 80,
              outputTotal: 10,
              cacheReadTotal: 50
            }),
            // 窗口内更大累计值
            buildCodexTokenCountLine({
              timestamp: '2026-02-14T16:20:00.000Z',
              inputTotal: 95,
              outputTotal: 15,
              cacheReadTotal: 60
            })
          ]
        },
        {
          path: '/tmp/rollout-2026-02-15T10-05-00-019c5f0b-9977-7711-ac1b-c661c26fbc29.jsonl',
          lines: [
            // 第二个会话：窗口内首次出现，基线按 0 计算
            buildCodexTokenCountLine({
              timestamp: '2026-02-14T16:30:00.000Z',
              inputTotal: 10,
              outputTotal: 1,
              cacheReadTotal: 9
            }),
            // 重复快照
            buildCodexTokenCountLine({
              timestamp: '2026-02-14T16:30:05.000Z',
              inputTotal: 10,
              outputTotal: 1,
              cacheReadTotal: 9
            })
          ]
        }
      ]
    })

    expect(result.success).toBe(true)
    expect(result.data.models.map(model => model.name)).toEqual(['codex'])
    expect(result.data.recordCount).toBe(2)
    expect(result.data.input).toBe(6)
    expect(result.data.output).toBe(6)
    expect(result.data.cache).toBe(39)
    expect(result.data.total).toBe(51)
    expect(result.data.models[0].total).toBe(51)
  })

  it('UT-BE-AGG-08: Claude 同一 message.id 应只统计最终态快照', async () => {
    const result = await aggregateTodayWithClaudeLines([
      // 同一消息的中间态（output/cache 还未补全）
      buildClaudeLogLine({
        timestamp: '2026-02-15T01:00:00+08:00',
        messageId: 'msg-1',
        model: 'claude-sonnet-4-6',
        input: 100,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0
      }),
      // 同一消息最终态（应覆盖中间态）
      buildClaudeLogLine({
        timestamp: '2026-02-15T01:00:01+08:00',
        messageId: 'msg-1',
        model: 'claude-sonnet-4-6',
        input: 20,
        output: 5,
        cacheRead: 80,
        cacheCreate: 0
      }),
      // 不同消息正常累计
      buildClaudeLogLine({
        timestamp: '2026-02-15T01:00:02+08:00',
        messageId: 'msg-2',
        model: 'claude-sonnet-4-6',
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheCreate: 3
      })
    ])

    expect(result.success).toBe(true)
    expect(result.data.recordCount).toBe(2)
    expect(result.data.input).toBe(30)
    expect(result.data.output).toBe(7)
    expect(result.data.cache).toBe(83)
    expect(result.data.total).toBe(120)
    expect(result.data.models.map(model => model.name)).toEqual(['sonnet'])
  })
})
