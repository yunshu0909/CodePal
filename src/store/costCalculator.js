/**
 * 费用计算模块
 *
 * 负责：
 * - 基于 pricing.json 计算各模型的预估费用（美元）
 * - 模型名归一化（展示名 → 定价表 key）
 * - 费用格式化显示
 * - 支持运行时 override：应用启动后可调用 setPricingOverride 注入远程拉到的 pricing
 *
 * 为什么保留同步 import + override 机制（而不是改成纯异步）：
 * - calculateCosts 被多处同步调用，改异步会牵扯所有组件加载时序
 * - 保留 import 作为兜底，异步加载成功后覆盖，兼顾了可用性和最新性
 *
 * @module store/costCalculator
 */

import pricingData from '../config/pricing.json';

// 当前生效的 pricing（默认用 import 的，启动后可被 setPricingOverride 覆盖）
let activePricing = pricingData;

/**
 * 用远程拉到的 pricing 覆盖本地 import 的默认值
 * 仅在 App 启动流程里被调用一次（从主进程 IPC 拉到后）
 * @param {object} remotePricing - 远程 registry 数据
 */
export function setPricingOverride(remotePricing) {
  if (!remotePricing || typeof remotePricing !== 'object') return;
  if (!remotePricing.models || typeof remotePricing.models !== 'object') return;
  // 远端注册表可能尚未包含新型号；缺项继续使用随包价格。
  activePricing = { ...pricingData, ...remotePricing, models: { ...pricingData.models, ...remotePricing.models } };
}

/**
 * 将模型展示名转换为定价表 key
 * 规则：小写 + 空格→连字符 + 点→连字符
 * @param {string} name - 模型展示名（如 "Claude Opus 4.7"）
 * @returns {string} 定价表 key（如 "claude-opus-4-7"）
 */
function normalizeModelKey(name) {
  return name.toLowerCase().replace(/[\s.]+/g, '-');
}

/**
 * 计算每个模型的预估费用（美元）
 * @param {Array<{name: string, input: number, output: number, cacheRead: number, cacheCreate: number}>} models
 * @returns {{ totalCost: number|null, modelCosts: Map<string, number|null> }}
 */
export function calculateCosts(models) {
  if (!models || models.length === 0) {
    return { totalCost: null, modelCosts: new Map() };
  }

  const pricingModels = activePricing.models;
  const modelCosts = new Map();
  let totalUsd = 0;
  let hasKnown = false;

  for (const model of models) {
    const key = normalizeModelKey(model.name);
    const pricing = pricingModels[key];

    if (!pricing) {
      modelCosts.set(model.name, null);
      continue;
    }

    // 美元费用 = 各维度 token × 对应单价 / 百万
    const usdCost = (
      (model.input || 0) * pricing.input +
      (model.output || 0) * pricing.output +
      (model.cacheRead || 0) * pricing.cacheRead +
      (model.cacheCreate || 0) * pricing.cacheWrite
    ) / 1_000_000;

    modelCosts.set(model.name, usdCost);
    totalUsd += usdCost;
    hasKnown = true;
  }

  return {
    totalCost: hasKnown ? totalUsd : null,
    modelCosts
  };
}

/**
 * 格式化费用显示
 * @param {number|null} cost - 费用值（美元）
 * @returns {string} "$12.35" 或 "--"
 */
export function formatCost(cost) {
  if (cost === null || cost === undefined) return '--';
  return '$' + cost.toFixed(2);
}
