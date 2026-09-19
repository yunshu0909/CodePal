/* @vitest-environment node */

/**
 * GPT-5.6 全系定价防回归测试
 *
 * 负责：
 * - 校验 Sol（原价，不计促销价）、Terra、Luna（现价 + 降价前历史段）的单价
 * - 校验模型名归一化后能实际命中费用计算
 * - 校验极端离线 fallback 同样覆盖 GPT-5.6 全系
 *
 * @module tests/pricing-gpt56.test
 */

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import pricingData from '../src/config/pricing.json'
import { calculateCosts } from '../src/store/costCalculator.js'

const require = createRequire(import.meta.url)
const {
  HARDCODED_PRICING_FALLBACK,
  validatePricing,
} = require('../electron/services/registries/pricingRegistry.js')

// Terra/Luna 顶层是 07-30 永久降价后的官方现价，降价前的上市价放在 history 段；
// Sol 08-21 起的 $4/$20 是限时促销价，按用户要求不计，始终按原价
const EXPECTED_GPT56_PRICING = {
  'gpt-5-6': { displayName: 'GPT-5.6 Sol', input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  'gpt-5-6-sol': { displayName: 'GPT-5.6 Sol', input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  'gpt-5-6-terra': { displayName: 'GPT-5.6 Terra', input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5, history: [{ until: '2026-07-30', input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 }] },
  'gpt-5-6-luna': { displayName: 'GPT-5.6 Luna', input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, history: [{ until: '2026-07-30', input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 }] },
}

describe('GPT-5.6 pricing registry', () => {
  it('打包与服务器分发 JSON 包含全系官方单价', () => {
    // 版本只校验「形态合法 + 不早于已知基线」，不再钉死具体日期：
    // 钉死会让每次正常调价（09-08 → 09-12 → 09-13…）都误报一次回归。
    expect(pricingData.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(pricingData.version.localeCompare('2026-09-12') >= 0).toBe(true)
    expect(validatePricing(pricingData).valid).toBe(true)

    for (const [modelKey, expected] of Object.entries(EXPECTED_GPT56_PRICING)) {
      expect(pricingData.models[modelKey]).toEqual(expected)
    }
  })

  it('极端离线 fallback 同样包含 GPT-5.6 全系', () => {
    for (const [modelKey, expected] of Object.entries(EXPECTED_GPT56_PRICING)) {
      expect(HARDCODED_PRICING_FALLBACK.models[modelKey]).toEqual(expected)
    }
  })

  it.each([
    ['gpt-5.6', 41.75],
    ['gpt-5.6-sol', 41.75],
    ['gpt-5.6-terra', 16.7],
    ['gpt-5.6-luna', 1.67],
  ])('%s 能命中输入、输出、缓存读写费用', (modelName, expectedCost) => {
    const result = calculateCosts([{
      name: modelName,
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheCreate: 1_000_000,
    }])

    expect(result.totalCost).toBeCloseTo(expectedCost, 6)
    expect(result.modelCosts.get(modelName)).toBeCloseTo(expectedCost, 6)
  })
})
