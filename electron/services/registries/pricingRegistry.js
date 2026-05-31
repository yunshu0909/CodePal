/**
 * 定价注册表 spec
 *
 * 负责：
 * - 声明 pricing 配置的 schema 校验规则
 * - 提供硬编码 fallback（极端情况下的最终兜底）
 * - 通过 remoteConfigLoader 被加载、拉取、缓存
 *
 * 数据结构：
 * - version / updatedAt 元信息
 * - exchangeRate: 美元对人民币汇率（用于费用计算的汇率换算）
 * - models: Object<modelKey, pricingEntry>
 *   - pricingEntry: { displayName, input, output, cacheRead, cacheWrite }
 *   - 单价单位：美元 / 百万 token
 *
 * @module electron/services/registries/pricingRegistry
 */

const { loadPackagedJson } = require('./loadPackagedJson')

// 硬编码兜底：Claude 三大模型 + 基本 GPT + Kimi
// 远程 pricing.json 会覆盖这个数据；即使完全加载失败，应用也能显示基本费用
const HARDCODED_PRICING_FALLBACK = Object.freeze({
  version: 'hardcoded-fallback',
  updatedAt: null,
  exchangeRate: 7.22,
  models: {
    'claude-opus-4-8': { displayName: 'Claude Opus 4.8', input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-7': { displayName: 'Claude Opus 4.7', input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-6': { displayName: 'Claude Opus 4.6', input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-haiku-4-5': { displayName: 'Claude Haiku 4.5', input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    'claude-haiku-4-5-20251001': { displayName: 'Claude Haiku 4.5', input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  },
})

/**
 * 校验 pricing 数据结构
 * @param {unknown} data - 待校验对象
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
function validatePricing(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'pricing 必须是对象' }
  }

  if (typeof data.exchangeRate !== 'number' || data.exchangeRate <= 0) {
    return { valid: false, error: 'exchangeRate 必须是正数' }
  }

  if (!data.models || typeof data.models !== 'object' || Array.isArray(data.models)) {
    return { valid: false, error: 'models 必须是对象' }
  }

  const modelKeys = Object.keys(data.models)
  if (modelKeys.length === 0) {
    return { valid: false, error: 'models 不能为空' }
  }

  for (const key of modelKeys) {
    const entry = data.models[key]
    if (!entry || typeof entry !== 'object') {
      return { valid: false, error: `models.${key} 必须是对象` }
    }
    // displayName 可选，但存在必须是字符串
    if (entry.displayName !== undefined && typeof entry.displayName !== 'string') {
      return { valid: false, error: `models.${key}.displayName 必须是字符串` }
    }
    // 四个价格字段必须都是非负数
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (typeof entry[field] !== 'number' || entry[field] < 0) {
        return { valid: false, error: `models.${key}.${field} 必须是非负数` }
      }
    }
  }

  return { valid: true }
}

/**
 * pricing 的 loader spec
 */
const pricingRegistrySpec = {
  name: 'pricing',
  remotePath: 'src/config/pricing.json',
  cacheFileName: 'pricing.cache.json',
  packaged: loadPackagedJson('src/config/pricing.json'),
  hardcoded: HARDCODED_PRICING_FALLBACK,
  validate: validatePricing,
}

module.exports = {
  pricingRegistrySpec,
  validatePricing,
  HARDCODED_PRICING_FALLBACK,
}
