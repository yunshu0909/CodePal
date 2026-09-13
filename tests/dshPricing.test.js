/* @vitest-environment node */
/**
 * DSH 定价条目测试（TC-11 / TC-12）
 *
 * 覆盖：
 * - 四个 DSH 模型条目的单价等于官方人民币价 ÷ 项目汇率
 * - vision-exp 与 flash 同价（官方：旧模型名按 Flash 价格计费）
 * - `glm-5.3` 归一化后命中 `glm-5-3`
 * - 未收录模型费用为 null（展示 `--`），不猜测价格
 *
 * 官方价来源（2026-09-12 抓取）：
 * - DeepSeek https://api-docs.deepseek.com/zh-cn/quick_start/pricing （空闲档：flash 1/0.02/4，pro 4.5/0.15/13.5）
 * - 智谱 https://docs.bigmodel.cn/cn/guide/start/pricing （GLM-5.3 输入 8 / 输出 28 / 缓存命中 2）
 *
 * @module tests/dshPricing
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import pricingData from '../src/config/pricing.json'
import { calculateCosts, canonicalModelName, resolveModelKey, setPricingOverride } from '../src/store/costCalculator.js'

const require = createRequire(import.meta.url)
const { HARDCODED_PRICING_FALLBACK, validatePricing } = require('../electron/services/registries/pricingRegistry.js')

/** 官方人民币价（元/百万 token，空闲/基础档） */
const OFFICIAL_CNY = {
  'deepseek-v4-1-flash': { input: 1, output: 4, cacheRead: 0.02 },
  'deepseek-v4-flash-vision-exp': { input: 1, output: 4, cacheRead: 0.02 },
  'deepseek-v4-pro': { input: 4.5, output: 13.5, cacheRead: 0.15 },
  'glm-5-3': { input: 8, output: 28, cacheRead: 2 },
}

const round6 = (value) => Math.round(value * 1e6) / 1e6

/** 钉住汇率本身：否则"自除自证"会放过任何汇率改动（渲染费用会整体偏移却测试全绿） */
const EXPECTED_EXCHANGE_RATE = 6.7253

describe('TC-11 DSH 模型定价条目', () => {
  it('汇率被钉住（费用换算的前提）', () => {
    expect(pricingData.exchangeRate).toBe(EXPECTED_EXCHANGE_RATE)
    expect(HARDCODED_PRICING_FALLBACK.exchangeRate).toBe(EXPECTED_EXCHANGE_RATE)
  })

  it('四个条目存在且等于官方人民币价 ÷ exchangeRate', () => {
    const rate = EXPECTED_EXCHANGE_RATE

    for (const [key, cny] of Object.entries(OFFICIAL_CNY)) {
      const entry = pricingData.models[key]
      expect(entry, `缺少定价条目 ${key}`).toBeTruthy()

      expect(entry.input).toBeCloseTo(round6(cny.input / rate), 5)
      expect(entry.output).toBeCloseTo(round6(cny.output / rate), 5)
      expect(entry.cacheRead).toBeCloseTo(round6(cny.cacheRead / rate), 5)
    }
  })

  it('vision-exp 与 flash 四字段完全同价（官方：按 Flash 价格计费）', () => {
    const flash = pricingData.models['deepseek-v4-1-flash']
    const vision = pricingData.models['deepseek-v4-flash-vision-exp']

    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      expect(vision[field]).toBe(flash[field])
    }
  })

  it('离线兜底与打包 JSON 同步，且汇率与别名表一致', () => {
    const fallbackModels = HARDCODED_PRICING_FALLBACK.models

    for (const key of Object.keys(OFFICIAL_CNY)) {
      expect(fallbackModels[key], `兜底缺少 ${key}`).toBeTruthy()
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        expect(fallbackModels[key][field]).toBe(pricingData.models[key][field])
      }
    }
    expect(HARDCODED_PRICING_FALLBACK.exchangeRate).toBe(pricingData.exchangeRate)
    // 别名表也必须同步，否则离线兜底时同一模型会退化成多行 / 无价
    expect(HARDCODED_PRICING_FALLBACK.aliases).toEqual(pricingData.aliases)
    expect(validatePricing(pricingData).valid).toBe(true)
  })

  it('别名表结构非法时 validatePricing 拒绝（values 必须是非空字符串）', () => {
    expect(validatePricing({ ...pricingData, aliases: { 'a-b': 42 } }).valid).toBe(false)
    expect(validatePricing({ ...pricingData, aliases: [] }).valid).toBe(false)
    // 缺 aliases 字段仍然合法（老版本注册表）
    const { aliases, ...withoutAliases } = pricingData
    expect(validatePricing(withoutAliases).valid).toBe(true)
  })

  it('未收录模型费用为 null（展示 --），不猜测价格', () => {
    const { modelCosts, totalCost } = calculateCosts([
      { name: 'some-unreleased-model', input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreate: 0 }
    ])

    expect(modelCosts.get('some-unreleased-model')).toBeNull()
    expect(totalCost).toBeNull()
  })
})

describe('TC-12 模型名归一化命中定价键', () => {
  it('glm-5.3 归一化后命中 glm-5-3 并算出费用', () => {
    const { modelCosts } = calculateCosts([
      { name: 'glm-5.3', input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 }
    ])

    // 归一是 lower + 空格/点 → 连字符：glm-5.3 → glm-5-3
    expect(modelCosts.get('glm-5.3')).toBeCloseTo(pricingData.models['glm-5-3'].input, 6)
    expect(modelCosts.get('glm-5.3')).toBeGreaterThan(0)
  })

  it('事件流里的干净模型名都能直接命中（无需剥 provider 前缀）', () => {
    const names = ['deepseek-v4.1-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro', 'glm-5.3']
    const { modelCosts, totalCost } = calculateCosts(
      names.map(name => ({ name, input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 }))
    )

    for (const name of names) {
      expect(modelCosts.get(name), `${name} 未命中定价`).toBeGreaterThan(0)
    }
    expect(totalCost).toBeGreaterThan(0)
  })

  it('同一上游模型的三个客户端别名都能算出费用（不再显示 --）', () => {
    // 真实日志里出现过的写法：DSH 新版 / 老日志 / Claude+Codex 的临时代号
    const aliases = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash-expires-on-0910']
    const { modelCosts, totalCost } = calculateCosts(
      aliases.map(name => ({ name, input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreate: 0 }))
    )

    const canonical = pricingData.models['deepseek-v4-1-flash']
    // 输入/输出各 1M token → 费用（美元）= input 单价 + output 单价
    const expected = canonical.input + canonical.output
    for (const name of aliases) {
      expect(modelCosts.get(name), `${name} 未通过别名归一到 canonical`).toBeCloseTo(expected, 6)
    }
    expect(totalCost).toBeCloseTo(expected * aliases.length, 6)
  })

  it('别名只归一"同一模型"，不误并 vision / pro / 其他厂商', () => {
    // vision 与 pro 是独立条目（视觉变体、不同档位），glm 是另一家厂商
    for (const name of ['deepseek-v4-flash-vision-exp', 'deepseek-v4-pro', 'glm-5.3']) {
      expect(canonicalModelName(name), `${name} 不该被归一`).toBe(name)
    }
  })
})

describe('TC-13 别名归一（canonicalModelName）', () => {
  it('三个 DeepSeek 别名归一到 deepseek-v4.1-flash', () => {
    expect(canonicalModelName('deepseek-flash')).toBe('deepseek-v4.1-flash')
    expect(canonicalModelName('deepseek-v4-flash')).toBe('deepseek-v4.1-flash')
    expect(canonicalModelName('deepseek-v4.1-flash-expires-on-0910')).toBe('deepseek-v4.1-flash')
    // 已经是 canonical 的原样返回
    expect(canonicalModelName('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
  })

  it('未知名字 / 空值原样返回，不抛错', () => {
    expect(canonicalModelName('some-unreleased-model')).toBe('some-unreleased-model')
    expect(canonicalModelName('')).toBe('')
    expect(canonicalModelName(undefined)).toBeUndefined()
  })

  it('别名目标写错（canonical 不在价格表）时不归一，宁可各行可见', () => {
    setPricingOverride({ models: {}, aliases: { 'ghost-model': 'not-in-pricing' } })
    try {
      expect(canonicalModelName('ghost-model')).toBe('ghost-model')
      expect(resolveModelKey('ghost-model')).toBeNull()
    } finally {
      // 复位，避免污染后续用例
      setPricingOverride({ models: pricingData.models, aliases: pricingData.aliases })
    }
  })
})
