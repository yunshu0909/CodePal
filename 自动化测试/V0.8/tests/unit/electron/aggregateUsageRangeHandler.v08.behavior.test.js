/* @vitest-environment node */

/**
 * V0.8 自定义日期区间聚合处理器测试
 *
 * 负责：
 * - 校验日期参数与时间边界
 * - 校验“日汇总命中 + 缺失补算”混合链路
 * - 校验聚合结果与 meta 统计字段
 *
 * @module 自动化测试/V0.8/tests/unit/electron/aggregateUsageRangeHandler.v08.behavior.test
 */

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { handleAggregateUsageRange } = require('../../../../../electron/aggregateUsageRangeHandler.js')

/**
 * 构造测试用日汇总对象
 * @param {string} date - 日期
 * @param {Record<string, {input:number,output:number,cacheRead:number,cacheCreate?:number,total:number}>} models - 模型汇总
 * @returns {object}
 */
function createDailySummary(date, models) {
  const summary = Object.values(models).reduce((acc, model) => {
    acc.total += model.total
    acc.input += model.input
    acc.output += model.output
    acc.cache += (model.cacheRead || 0) + (model.cacheCreate || 0)
    return acc
  }, { total: 0, input: 0, output: 0, cache: 0 })

  return {
    date,
    generatedAt: '2026-02-16T00:05:00.000Z',
    models,
    summary
  }
}

/**
 * 构造 Claude 日志行
 * @param {{timestamp: string, messageId?: string, model: string, input?: number, output?: number, cacheRead?: number, cacheCreate?: number}} payload - 日志字段
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

describe('aggregateUsageRangeHandler V0.8 Behavior (Node Unit)', () => {
  it('UT-BE-RANGE-01: 非法日期格式应返回 INVALID_DATE_RANGE', async () => {
    const result = await handleAggregateUsageRange({
      startDate: '2026/02/10',
      endDate: '2026-02-12',
      timezone: 'Asia/Shanghai'
    })

    expect(result).toEqual({
      success: false,
      error: 'INVALID_DATE_RANGE'
    })
  })

  it('UT-BE-RANGE-02: 结束日期为今天或未来应返回 DATE_OUT_OF_RANGE', async () => {
    const now = new Date('2026-02-16T10:00:00.000Z')

    const result = await handleAggregateUsageRange(
      {
        startDate: '2026-02-15',
        endDate: '2026-02-16',
        timezone: 'Asia/Shanghai'
      },
      {
        nowFn: vi.fn(() => now)
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'DATE_OUT_OF_RANGE'
    })
  })

  it('UT-BE-RANGE-03: 命中日汇总并补算缺失日期后应返回完整聚合结果', async () => {
    const cachedDay = createDailySummary('2026-02-13', {
      'kimi-for-coding': {
        input: 100,
        output: 10,
        cacheRead: 20,
        cacheCreate: 0,
        total: 130
      }
    })

    const recomputedDay = createDailySummary('2026-02-14', {
      'codex-latest': {
        input: 200,
        output: 30,
        cacheRead: 50,
        cacheCreate: 0,
        total: 280
      }
    })

    const readDailySummaryFn = vi.fn(async (dateKey) => {
      if (dateKey === '2026-02-13') {
        return cachedDay
      }
      return null
    })

    const recomputeDailySummaryFn = vi.fn(async (dateKey) => {
      if (dateKey === '2026-02-14') {
        return recomputedDay
      }
      throw new Error(`unexpected recompute date: ${dateKey}`)
    })

    const writeDailySummaryFn = vi.fn(async () => {})

    const result = await handleAggregateUsageRange(
      {
        startDate: '2026-02-13',
        endDate: '2026-02-14',
        timezone: 'Asia/Shanghai'
      },
      {
        nowFn: vi.fn(() => new Date('2026-02-16T10:00:00.000Z')),
        readDailySummaryFn,
        recomputeDailySummaryFn,
        writeDailySummaryFn
      }
    )

    expect(result.success).toBe(true)
    expect(result.meta).toEqual({
      fromDailySummaryDays: 1,
      recomputedDays: 1,
      totalDays: 2,
      failedDays: 0
    })

    expect(result.data.period).toBe('custom')
    expect(result.data.startDate).toBe('2026-02-13')
    expect(result.data.endDate).toBe('2026-02-14')

    // 聚合总量 = 130 + 280
    expect(result.data.total).toBe(410)
    expect(result.data.input).toBe(300)
    expect(result.data.output).toBe(40)
    expect(result.data.cache).toBe(70)

    expect(readDailySummaryFn).toHaveBeenCalledTimes(2)
    expect(recomputeDailySummaryFn).toHaveBeenCalledTimes(1)
    expect(writeDailySummaryFn).toHaveBeenCalledTimes(1)
  })

  it('UT-BE-RANGE-04: 补算时 Claude 同一 message.id 应只计最终态', async () => {
    const readDailySummaryFn = vi.fn(async () => null)
    const writeDailySummaryFn = vi.fn(async () => {})
    const pathExistsFn = vi.fn(async (targetPath) => targetPath.endsWith('/.claude/projects'))
    const scanLogFilesInRangeFn = vi.fn(async (basePath) => {
      if (basePath.endsWith('/.claude/projects')) {
        return {
          files: [
            {
              path: '/mock-home/.claude/projects/mock-session.jsonl',
              lines: [
                buildClaudeLogLine({
                  timestamp: '2026-02-14T01:00:00+08:00',
                  messageId: 'msg-1',
                  model: 'claude-opus-4-6',
                  input: 100,
                  output: 0,
                  cacheRead: 0,
                  cacheCreate: 0
                }),
                buildClaudeLogLine({
                  timestamp: '2026-02-14T01:00:01+08:00',
                  messageId: 'msg-1',
                  model: 'claude-opus-4-6',
                  input: 20,
                  output: 5,
                  cacheRead: 80,
                  cacheCreate: 0
                }),
                buildClaudeLogLine({
                  timestamp: '2026-02-14T01:00:02+08:00',
                  messageId: 'msg-2',
                  model: 'claude-opus-4-6',
                  input: 10,
                  output: 2,
                  cacheRead: 0,
                  cacheCreate: 3
                })
              ]
            }
          ]
        }
      }

      return { files: [] }
    })

    const result = await handleAggregateUsageRange(
      {
        startDate: '2026-02-14',
        endDate: '2026-02-14',
        timezone: 'Asia/Shanghai'
      },
      {
        nowFn: vi.fn(() => new Date('2026-02-16T10:00:00.000Z')),
        homeDir: '/mock-home',
        readDailySummaryFn,
        writeDailySummaryFn,
        pathExistsFn,
        scanLogFilesInRangeFn
      }
    )

    expect(result.success).toBe(true)
    expect(result.meta).toEqual({
      fromDailySummaryDays: 0,
      recomputedDays: 1,
      totalDays: 1,
      failedDays: 0
    })
    expect(result.data.models.map(model => model.name)).toEqual(['opus'])
    expect(result.data.input).toBe(30)
    expect(result.data.output).toBe(7)
    expect(result.data.cache).toBe(83)
    expect(result.data.total).toBe(120)
  })
})
