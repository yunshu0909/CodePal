/**
 * 混合模型费用回归：验证真实扫描入口、价格与缓存迁移。
 * @module tests/usageModelCost
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { aggregateUsage } from '../src/store/usageAggregator.js'
import { calculateCosts, setPricingOverride } from '../src/store/costCalculator.js'
import pricing from '../src/config/pricing.json'
import { readUsageCache } from '../src/pages/usage/useUsageCache.js'
const require = createRequire(import.meta.url)
const { scanCodexLogs, scanClaudeLogs, aggregateByModel } = require('../electron/services/usageLogScanService.js')
const { DAILY_SUMMARY_SCHEMA_VERSION } = require('../electron/services/dailySummaryService.js')
const { HARDCODED_PRICING_FALLBACK, validatePricing } = require('../electron/services/registries/pricingRegistry.js')
const start = new Date('2026-09-08T00:00:00Z'), end = new Date('2026-09-09T00:00:00Z')
const ctx = model => JSON.stringify({ type: 'turn_context', payload: { model, cwd: '/projects/demo' } })
const snap = (time, input, output, cache = 0) => JSON.stringify({ type: 'event_msg', timestamp: time, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cache, total_tokens: input + output } } } })
const files = lines => [{ path: '/sessions/session-a.jsonl', lines }]
const scan = (lines, a = start, b = end) => scanCodexLogs(a, b, { pathExistsFn: async () => true, scanLogFilesInRangeFn: async () => ({ files: files(lines) }) })
const mixed = () => [ctx('gpt-6-astra'), snap('2026-09-08T01:00:00Z', 100, 10, 20), ctx('gpt-5.6-sol'), snap('2026-09-08T02:00:00Z', 300, 30, 80), ctx('gpt-6-astra'), snap('2026-09-08T03:00:00Z', 450, 45, 110)]
afterEach(() => { vi.useRealTimers(); setPricingOverride(pricing); window.localStorage.clear(); vi.restoreAllMocks() })
describe('模型事件归属', () => {
  it('A→B→A 按段归属输入、输出、缓存，合计不变', async () => {
    const m = aggregateByModel(await scan(mixed()))
    expect(m.get('gpt-6-astra')).toMatchObject({ input: 200, output: 25, cacheRead: 50, total: 275 })
    expect(m.get('gpt-5.6-sol')).toMatchObject({ input: 140, output: 20, cacheRead: 60, total: 220 })
  })
  it('窗口前累计只作基线，窗口后模型不追溯改写归属', async () => {
    const rows = await scan([ctx('gpt-5.6-sol'), snap('2026-09-07T23:00:00Z', 100, 10), ctx('gpt-6-astra'), snap('2026-09-08T01:00:00Z', 150, 15), ctx('gpt-future'), snap('2026-09-09T00:00:00Z', 900, 90)])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: 'gpt-6-astra', input: 50, output: 5 })
  })
  it('切模型后的重复累计不产生用量也不转移归属', async () => {
    const rows = await scan([ctx('gpt-6-astra'), snap('2026-09-08T01:00:00Z', 100, 10), ctx('gpt-5.6-sol'), snap('2026-09-08T02:00:00Z', 100, 10)])
    expect(rows).toHaveLength(1)
    expect(rows[0].model).toBe('gpt-6-astra')
  })
  it('无模型证据的用量不归给后来模型', async () => {
    const m = aggregateByModel(await scan([snap('2026-09-08T01:00:00Z', 100, 10), ctx('gpt-6-astra'), snap('2026-09-08T02:00:00Z', 150, 15)]))
    expect(m.get('codex').total).toBe(110)
    expect(m.get('gpt-6-astra').total).toBe(55)
  })
  it('连续两个日期窗口之和等于整段扫描', async () => {
    const lines = [ctx('gpt-6-astra'), snap('2026-09-08T01:00:00Z', 100, 10), ctx('gpt-5.6-sol'), snap('2026-09-09T01:00:00Z', 200, 20)]
    const next = new Date('2026-09-10T00:00:00Z')
    const all = aggregateByModel(await scan(lines, start, next))
    const parts = aggregateByModel([...(await scan(lines)), ...(await scan(lines, end, next))])
    expect(parts).toEqual(all)
  })
  it('前端备用扫描与主进程按模型一致', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-08T08:00:00Z'))
    window.electronAPI = { scanLogFiles: vi.fn(async ({ basePath }) => ({ success: true, files: basePath.includes('codex') ? files(mixed()) : [] })) }
    const result = await aggregateUsage('today')
    expect(result.success).toBe(true)
    expect(result.data.models.find(x => x.name === 'gpt-6-astra')).toMatchObject({ input: 200, output: 25, cacheRead: 50 })
    expect(result.data.models.find(x => x.name === 'gpt-5.6-sol').total).toBe(220)
  })
  it('长日志的开头模型与用量不会被截掉，备用 IPC 同样保留', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'model-cost-'))
    try {
      const dir = path.join(home, '.codex/sessions'); await fs.mkdir(dir, { recursive: true })
      const lines = [ctx('gpt-6-astra'), snap('2026-09-08T01:00:00Z', 100, 10), ...Array(10010).fill('{}'), ctx('gpt-5.6-sol'), snap('2026-09-08T02:00:00Z', 200, 20)]
      await fs.writeFile(path.join(dir, 'session.jsonl'), lines.join('\n'))
      const modelMap = aggregateByModel(await scanCodexLogs(start, end, { homeDir: home }))
      expect(modelMap.get('gpt-6-astra')?.total).toBe(110)
      const { handleScanLogFiles } = require('../electron/scanLogFilesHandler.js')
      const response = await handleScanLogFiles({ basePath: '~/.codex/sessions', start: start.toISOString(), end: end.toISOString(), purpose: 'usage-model-attribution' }, { expandHomeFn: () => dir })
      expect(response.files[0].lines.map(line => JSON.parse(line).type)).toEqual(['turn_context', 'event_msg', 'turn_context', 'event_msg'])
    } finally { await fs.rm(home, { recursive: true, force: true }) }
  })
  it('用量读取走流式且不留对话正文，普通扫描保留原输出', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-stream-'))
    try {
      const dir = path.join(home, '.codex/sessions'); await fs.mkdir(dir, { recursive: true })
      const modelContext = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra', cwd: '/projects/demo', instructions: 'not-needed-text' } })
      const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'own', instructions: 'not-needed-text' } })
      const lines = [meta, modelContext, JSON.stringify({ type: 'response_item', payload: { content: 'x'.repeat(500000) } }), snap('2026-09-08T01:00:00Z', 100, 10)]
      const file = path.join(dir, 'session.jsonl'); await fs.writeFile(file, lines.join('\n'))
      const { scanLogFilesInRange } = require('../electron/logScanner.js')
      const readFileSpy = vi.spyOn(fs, 'readFile')
      const records = await scanCodexLogs(start, end, { homeDir: home })
      expect(records[0]).toMatchObject({ model: 'gpt-6-astra', input: 100, output: 10 })
      expect(readFileSpy.mock.calls.filter(([p]) => p === file)).toHaveLength(0)
      const compact = await scanLogFilesInRange(dir, start, end, { codexUsageOnly: true })
      expect(compact.files[0].lines).toHaveLength(3)
      expect(JSON.stringify(compact.files)).not.toContain('not-needed-text')
      expect(JSON.stringify(compact.files).length).toBeLessThan(2000)
      const normal = await scanLogFilesInRange(dir, start, end)
      expect(normal.files[0].lines).toEqual(lines)
    } finally { await fs.rm(home, { recursive: true, force: true }) }
  })
  it('Claude 同会话仍按每条消息的模型计量', async () => {
    const lines = ['claude-fable-5-1', 'claude-opus-4-8'].map((model, i) => JSON.stringify({ timestamp: '2026-09-08T01:00:00Z', message: { id: `msg-${i}`, model, usage: { input_tokens: 100, output_tokens: 10 } } }))
    const rows = await scanClaudeLogs(start, end, { pathExistsFn: async () => true, scanLogFilesInRangeFn: async () => ({ files: files(lines) }) })
    expect(rows.map(x => x.model)).toEqual(['Claude Fable 5.1', 'Claude Opus 4.8'])
  })
})
describe('新模型价格与拒旧缓存', () => {
  it('两款基础价格独立配置且总费用按模型相加', () => {
    const models = ['GPT-6 Astra', 'Claude Fable 5.1'].map(name => ({ name, input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreate: 1e6 }))
    const result = calculateCosts(models)
    expect(result.modelCosts.get('GPT-6 Astra')).toBe(73.5)
    expect(result.modelCosts.get('Claude Fable 5.1')).toBe(72.75)
    expect(result.totalCost).toBe(146.25)
    expect(validatePricing(pricing).valid).toBe(true)
    expect(HARDCODED_PRICING_FALLBACK.models['gpt-6-astra']).toMatchObject({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 })
    expect(HARDCODED_PRICING_FALLBACK.models['claude-fable-5-1'].cacheRead).toBe(0.25)
  })
  it('旧远端覆盖不抹掉本地新增型号', () => {
    setPricingOverride({ models: { 'gpt-5-5': pricing.models['gpt-5-5'] }, exchangeRate: 7.22 })
    expect(calculateCosts([{ name: 'gpt-6-astra', input: 1e6 }]).totalCost).toBe(10)
  })
  it('Claude Opus 5 原始名称与展示名称均按官方基础价格计费', () => {
    const expected = { displayName: 'Claude Opus 5', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
    expect(pricing.models['claude-opus-5']).toEqual(expected)
    expect(HARDCODED_PRICING_FALLBACK.models['claude-opus-5']).toEqual(expected)
    for (const name of ['claude-opus-5', 'Claude Opus 5']) {
      expect(calculateCosts([{ name, input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreate: 1e6 }]).totalCost).toBe(36.75)
    }
    setPricingOverride({ models: { 'gpt-5-5': pricing.models['gpt-5-5'] } })
    expect(calculateCosts([{ name: 'claude-opus-5', input: 1e6 }]).totalCost).toBe(5)
  })
  it('未知型号没有虚构价格', () => {
    expect(calculateCosts([{ name: 'unknown-model', input: 1e6 }]).totalCost).toBeNull()
  })
  it('旧日汇总与旧页面缓存不再沿用', () => {
    expect(DAILY_SUMMARY_SCHEMA_VERSION).toBeGreaterThan(4)
    window.localStorage.setItem('usage-monitor-cache-v3', JSON.stringify({ today: { data: { total: 123 } } }))
    expect(readUsageCache().today).toBeNull()
  })
})
