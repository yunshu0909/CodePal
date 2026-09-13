/**
 * 用量重算路径 · 复用决策与缓存兼容（A-010 / A-011）
 *
 * 顶层不变式：**新缓存层不得改变任何可观察的复用决策**。现状会复用的天，改动后必须仍然复用；
 * 现状会重算的天，改动后仍然重算。降级结果照常缓存并复用（A-011），不引入重试。
 *
 * 这些用例在聚合层用注入依赖验证，不碰真实日志与真实缓存目录。
 * 对应 spec：SC-005 / SC-009 / SC-011（TC-005 / TC-009 / TC-011）。
 *
 * @module tests/usageDayCacheCompat
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { aggregateUsageDateRange } = require('../electron/services/usageDateRangeAggregationService.js')
const { DAILY_SUMMARY_SCHEMA_VERSION } = require('../electron/services/dailySummaryService.js')

const RANGE = { startDate: '2026-08-10', endDate: '2026-08-12' }

/** 造一个「有效日汇总」形状的缓存对象 */
function cachedSummary(dateKey) {
  return {
    date: dateKey,
    version: DAILY_SUMMARY_SCHEMA_VERSION,
    models: { 'claude-opus-5': { name: 'claude-opus-5', input: 10, output: 1, cacheRead: 0, cacheCreate: 0, total: 11, count: 1 } },
    projects: { demo: { name: 'demo', value: 11 } }
  }
}

/** 收集一次聚合过程中的写入与重算次数 */
function makeDeps(seedDays = []) {
  const store = new Map(seedDays.map((d) => [d, cachedSummary(d)]))
  const recomputed = []
  const written = []
  return {
    store,
    recomputed,
    written,
    deps: {
      readDailySummaryFn: async (dateKey) => store.get(dateKey) || null,
      // 真实签名是 (dateKey, summary, deps)
      writeDailySummaryFn: async (dateKey, summary) => { written.push(summary); store.set(dateKey, summary) },
      recomputeDailySummaryFn: async (dateKey) => { recomputed.push(dateKey); return cachedSummary(dateKey) }
    }
  }
}

describe('复用决策与现状逐条一致', () => {
  it('存在有效日汇总时直接复用，不触发重算，且不升 schemaVersion', async () => {
    const seeded = ['2026-08-10', '2026-08-11', '2026-08-12']
    const { deps, recomputed, written } = makeDeps(seeded)

    const result = await aggregateUsageDateRange({ period: 'custom', ...RANGE }, deps)

    expect(result.success).toBe(true)
    expect(recomputed).toEqual([])
    expect(written).toEqual([])
    expect(result.meta.cachedDays).toBe(3)
    expect(result.meta.recomputedDays).toBe(0)
  })

  it('缓存缺失的日期才重算，且写盘仍为 schemaVersion 6', async () => {
    const { deps, recomputed, written } = makeDeps(['2026-08-10', '2026-08-12'])

    const result = await aggregateUsageDateRange({ period: 'custom', ...RANGE }, deps)

    expect(recomputed).toEqual(['2026-08-11'])
    expect(result.meta.cachedDays).toBe(2)
    expect(result.meta.recomputedDays).toBe(1)
    // 写盘内容必须仍是 6：升版本会让所有旧缓存失效并触发一次全量重建
    for (const summary of written) {
      expect(summary.version).toBe(DAILY_SUMMARY_SCHEMA_VERSION)
    }
    expect(DAILY_SUMMARY_SCHEMA_VERSION).toBe(6)
  })

  it('重复查询同一区间：第二次全部命中缓存，零重算（数值稳定）', async () => {
    const { deps, recomputed } = makeDeps([])

    const first = await aggregateUsageDateRange({ period: 'custom', ...RANGE }, deps)
    const afterFirst = recomputed.length
    expect(afterFirst).toBe(3)

    const second = await aggregateUsageDateRange({ period: 'custom', ...RANGE }, deps)
    expect(recomputed.length).toBe(afterFirst) // 第二次没有新增重算
    expect(second.meta.cachedDays).toBe(3)
    expect(second.meta.recomputedDays).toBe(0)

    // 两次的模型行完全一致 → 数值稳定
    expect(JSON.stringify(second.data.models)).toEqual(JSON.stringify(first.data.models))
  })

  it('已固化用量优先：源日志消失也不回流清零（缓存被直接复用）', async () => {
    // 缓存里已有该天的固化结果；这里不提供任何日志来源，
    // 由于复用决策只看日汇总缓存，那一天必须原样返回、不重算也不归零。
    const { deps, recomputed } = makeDeps(['2026-08-10', '2026-08-11', '2026-08-12'])

    const result = await aggregateUsageDateRange({ period: 'custom', ...RANGE }, deps)

    expect(recomputed).toEqual([])
    // 视图层会把模型 id 映射成展示名，因此按 sourceModels 认原始 id
    expect(result.data.models).toHaveLength(1)
    const row = result.data.models[0]
    expect(row.sourceModels.map((m) => m.name)).toContain('claude-opus-5')
    expect(row.input).toBeGreaterThan(0)
  })
})
