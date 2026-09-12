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

// 硬编码兜底：Claude 三大模型 + 基本 GPT + Kimi + DSH 侧 DeepSeek/GLM
// 远程 pricing.json 会覆盖这个数据；即使完全加载失败，应用也能显示基本费用
const HARDCODED_PRICING_FALLBACK = Object.freeze({
  version: 'hardcoded-fallback',
  updatedAt: null,
  exchangeRate: 6.7253,
  models: {
    'claude-opus-5': { displayName: 'Claude Opus 5', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'gpt-6-astra': { displayName: 'GPT-6 Astra', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    'claude-fable-5-1': { displayName: 'Claude Fable 5.1', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    'claude-opus-4-8': { displayName: 'Claude Opus 4.8', input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-7': { displayName: 'Claude Opus 4.7', input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-6': { displayName: 'Claude Opus 4.6', input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-haiku-4-5': { displayName: 'Claude Haiku 4.5', input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    'claude-haiku-4-5-20251001': { displayName: 'Claude Haiku 4.5', input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    'gpt-5-6': { displayName: 'GPT-5.6 Sol', input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 6.25 },
    'gpt-5-6-sol': { displayName: 'GPT-5.6 Sol', input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 6.25 },
    'gpt-5-6-terra': { displayName: 'GPT-5.6 Terra', input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 3.125 },
    'gpt-5-6-luna': { displayName: 'GPT-5.6 Luna', input: 1.0, output: 6.0, cacheRead: 0.1, cacheWrite: 1.25 },
    'deepseek-v4-flash': { displayName: 'DeepSeek V4 Flash', input: 0.148692, output: 0.594769, cacheRead: 0.002974, cacheWrite: 0.148692 },
    'deepseek-v4-flash-vision-exp': { displayName: 'DeepSeek V4 Flash (Vision)', input: 0.148692, output: 0.594769, cacheRead: 0.002974, cacheWrite: 0.148692 },
    'deepseek-v4-pro': { displayName: 'DeepSeek V4 Pro', input: 0.669115, output: 2.007345, cacheRead: 0.022304, cacheWrite: 0.669115 },
    'glm-5-3': { displayName: 'GLM-5.3', input: 1.189538, output: 4.163383, cacheRead: 0.297385, cacheWrite: 1.189538 },
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
