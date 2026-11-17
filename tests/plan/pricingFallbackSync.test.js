/* @vitest-environment node */
/**
 * 硬编码兜底价格表和打包价格文件保持一致（#94）
 *
 * 主进程读不到打包的 pricing.json 时，用 pricingRegistry.js 里的硬编码兜底表算费用。
 * 以前每次只改 pricing.json，兜底表落下 30 个模型、还有一个旧价，极端情况下这些模型显示未知费用。
 * 这里守住：兜底表就是 pricing.json 的一份副本；改价格时两处一起改。
 *
 * @module tests/plan/pricingFallbackSync
 */
import { it, expect } from 'vitest'
import { createRequire } from 'node:module'
import pricing from '../../src/config/pricing.json'
import { normalizeModelKey } from '../../electron/services/modelAlias.mjs'

const require = createRequire(import.meta.url)
const { HARDCODED_PRICING_FALLBACK: fallback } = require('../../electron/services/registries/pricingRegistry')
const { aggregatePlanCosts } = require('../../electron/services/plan/planUsageService')

const HOW_TO_FIX = '改了 src/config/pricing.json 就把同样的改动抄进 electron/services/registries/pricingRegistry.js 的 HARDCODED_PRICING_FALLBACK'

it('兜底表的模型和价格与 pricing.json 逐项一致', () => {
  const missing = Object.keys(pricing.models).filter((key) => !fallback.models[key])
  expect(missing, `兜底表缺这些模型。${HOW_TO_FIX}`).toEqual([])
  for (const [key, entry] of Object.entries(pricing.models)) {
    expect(fallback.models[key], `${key} 的价格和 pricing.json 不一样。${HOW_TO_FIX}`).toEqual(entry)
  }
  expect(Object.keys(fallback.models).sort(), `兜底表多出了 pricing.json 里没有的模型。${HOW_TO_FIX}`)
    .toEqual(Object.keys(pricing.models).sort())
})

it('兜底表的别名和汇率与 pricing.json 一致，每个别名都落到有价格的模型上', () => {
  expect(fallback.aliases, HOW_TO_FIX).toEqual(pricing.aliases)
  expect(fallback.exchangeRate, HOW_TO_FIX).toBe(pricing.exchangeRate)
  for (const [alias, target] of Object.entries(fallback.aliases)) {
    expect(fallback.models[normalizeModelKey(target)], `别名 ${alias} 指向的 ${target} 在兜底表里没有价格`).toBeTruthy()
  }
})

it('只剩兜底表时，#94 的例子 gpt-6-astra-for-law 也能算出费用', async () => {
  const record = { timestamp: '2026-11-16T04:00:00Z', model: 'gpt-6-astra-for-law', input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0, source: 'codex' }
  const { total } = await aggregatePlanCosts('codex', [record], fallback)
  expect(total).toBeGreaterThan(0)
})
