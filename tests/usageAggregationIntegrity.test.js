/* @vitest-environment node */

/**
 * 用量聚合完整性测试
 *
 * 负责：
 * - 累计起点忽略旧空缓存，同时保留有效历史账本
 *
 * @module tests/usageAggregationIntegrity.test
 */

import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { findEarliestDailySummaryDate, DAILY_SUMMARY_SCHEMA_VERSION } = require('../electron/services/dailySummaryService.js')

function makeSummary(date, total = 10) {
  return {
    version: DAILY_SUMMARY_SCHEMA_VERSION,
    date,
    generatedAt: '2026-07-11T00:00:00.000Z',
    models: total > 0
      ? {
          codex: {
            input: total,
            output: 0,
            cacheRead: 0,
            cacheCreate: 0,
            total,
          },
        }
      : {},
    projects: {},
    summary: { total, input: total, output: 0, cache: 0 },
  }
}

describe('累计起点完整性', () => {
  it('忽略 2020 空缓存与旧 schema，返回第一份当前口径的正用量汇总', async () => {
    const files = {
      '2020-01-01.json': makeSummary('2020-01-01', 0),
      '2025-01-01.json': { ...makeSummary('2025-01-01', 99), version: 3 },
      '2026-03-24.json': makeSummary('2026-03-24', 42),
    }

    const result = await findEarliestDailySummaryDate({
      homeDir: '/fake/home',
      readdirFn: vi.fn(async () => Object.keys(files)),
      readFileFn: vi.fn(async (filePath) => JSON.stringify(files[filePath.split('/').pop()])),
    })

    expect(result).toBe('2026-03-24')
  })
})
