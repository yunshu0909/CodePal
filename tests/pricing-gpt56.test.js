/* @vitest-environment node */

/**
 * GPT-5.6 全系定价防回归测试
 *
 * 负责：
 * - 校验 Sol 别名、Sol、Terra、Luna 的官方单价
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

const EXPECTED_GPT56_PRICING = {
  'gpt-5-6': { displayName: 'GPT-5.6 Sol', input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  'gpt-5-6-sol': { displayName: 'GPT-5.6 Sol', input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  'gpt-5-6-terra': { displayName: 'GPT-5.6 Terra', input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  'gpt-5-6-luna': { displayName: 'GPT-5.6 Luna', input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
}

describe('GPT-5.6 pricing registry', () => {
  it('打包与服务器分发 JSON 包含全系官方单价', () => {
    expect(pricingData.version).toBe('2026-09-08')
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
    ['gpt-5.6-terra', 20.875],
    ['gpt-5.6-luna', 8.35],
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
