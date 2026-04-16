/**
 * 用量展示数据组装服务
 *
 * 负责：
 * - 将模型聚合结果转换为前端展示结构
 * - 生成模型分布与项目分布图表数据
 * - 统一颜色映射与百分比口径
 *
 * @module electron/services/usageViewDataService
 */

// 模型颜色映射表（沿用前端口径，确保图例颜色稳定）
const MODEL_COLORS = {
  opus: '#f59e0b',
  'claude-opus': '#f59e0b',
  sonnet: '#6366f1',
  'claude-sonnet': '#6366f1',
  haiku: '#8b5cf6',
  'claude-haiku': '#8b5cf6',
  claude: '#ec4899',
  'gpt-5': '#e67e22',
  'gpt-4o': '#f97316',
  'gpt-4': '#fbbf24',
  'gpt-3.5': '#f59e0b',
  kimi: '#16a34a',
  'kimi-pro': '#22c55e',
  deepseek: '#a855f7',
  gemini: '#dc2626',
  qwen: '#10b981',
  yi: '#ec4899',
  llama: '#06b6d4',
  mistral: '#fbbf24',
  codex: '#3b82f6',
  default: '#8b919a'
}

const PROJECT_COLORS = ['#16a34a', '#f59e0b', '#06b6d4', '#8b5cf6', '#ec4899', '#94a3b8']

/**
 * 获取模型颜色
 * @param {string} model - 模型名
 * @returns {string}
 */
function getModelColor(model) {
  const normalized = (model || '').toLowerCase()

  if (MODEL_COLORS[normalized]) {
    return MODEL_COLORS[normalized]
  }

  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (normalized.includes(key)) {
      return color
    }
  }

  return MODEL_COLORS.default
}

/**
 * 使用最大余数法计算百分比，确保总和为 100%
 * @param {Array<object>} models - 模型数组
 * @param {number} total - 总量
 * @returns {Array<object>}
 */
function calculatePercentagesWithLargestRemainder(models, total) {
  if (total === 0 || models.length === 0) {
    return models.map((model) => ({ ...model, percent: 0 }))
  }

  const withFraction = models.map((model) => {
    const exactPercent = (model.total / total) * 100
    const floorPercent = Math.floor(exactPercent)
    return { ...model, exactPercent, floorPercent, fraction: exactPercent - floorPercent }
  })

  let remaining = 100 - withFraction.reduce((sum, model) => sum + model.floorPercent, 0)

  const sortedByFraction = withFraction
    .map((model, index) => ({ ...model, originalIndex: index }))
    .sort((a, b) => b.fraction - a.fraction || b.total - a.total)

  for (let index = 0; index < remaining && index < sortedByFraction.length; index += 1) {
    sortedByFraction[index].floorPercent += 1
  }

  return sortedByFraction
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((model) => ({ ...model, percent: model.floorPercent }))
}

/**
 * 百分比显示文案
 * @param {number} percent - 百分比
 * @param {number} modelTotal - 模型总量
 * @param {number} grandTotal - 总量
 * @returns {string}
 */
function formatPercentDisplay(percent, modelTotal, grandTotal) {
  if (percent === 0 && modelTotal > 0 && grandTotal > 0) {
    return '<1%'
  }

  return `${percent}%`
}

/**
 * 将模型聚合结果转换为展示数据
 * @param {Map<string, object>} aggregatedModels - 模型聚合结果
 * @returns {{total:number,input:number,output:number,cacheRead:number,cacheCreate:number,models:Array,distribution:Array,isExtremeScenario:boolean,modelCount:number}}
 */
function generateModelViewData(aggregatedModels) {
  const nonZeroModels = Array.from(aggregatedModels.values())
    .filter((model) => model.total > 0)

  const models = nonZeroModels
    .sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name))
    .map((model) => ({ ...model, color: getModelColor(model.name) }))

  const total = models.reduce((sum, model) => sum + model.total, 0)
  const totalInput = models.reduce((sum, model) => sum + model.input, 0)
  const totalOutput = models.reduce((sum, model) => sum + model.output, 0)
  const totalCacheRead = models.reduce((sum, model) => sum + model.cacheRead, 0)
  const totalCacheCreate = models.reduce((sum, model) => sum + model.cacheCreate, 0)

  const modelsWithPercent = calculatePercentagesWithLargestRemainder(models, total)
  const isExtremeScenario = models.length > 5

  if (!isExtremeScenario) {
    return {
      total,
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreate: totalCacheCreate,
      models,
      distribution: modelsWithPercent.map((model) => ({
        name: model.name,
        value: model.total,
        percent: model.percent,
        displayPercent: formatPercentDisplay(model.percent, model.total, total),
        color: model.color,
        key: model.name
      })),
      isExtremeScenario,
      modelCount: models.length
    }
  }

  const topModels = modelsWithPercent.slice(0, 5)
  const otherModels = modelsWithPercent.slice(5)
  const topDistribution = topModels.map((model) => ({
    name: model.name,
    value: model.total,
    percent: model.percent,
    displayPercent: formatPercentDisplay(model.percent, model.total, total),
    color: model.color,
    key: model.name
  }))

  const othersTotal = otherModels.reduce((sum, model) => sum + model.total, 0)
  const othersPercent = othersTotal > 0
    ? 100 - topModels.reduce((sum, model) => sum + model.percent, 0)
    : 0

  if (otherModels.length > 0) {
    topDistribution.push({
      name: `其他 (${otherModels.length}个模型)`,
      value: othersTotal,
      percent: othersPercent,
      displayPercent: formatPercentDisplay(othersPercent, othersTotal, total),
      color: MODEL_COLORS.default,
      key: 'others'
    })
  }

  return {
    total,
    input: totalInput,
    output: totalOutput,
    cacheRead: totalCacheRead,
    cacheCreate: totalCacheCreate,
    models,
    distribution: topDistribution,
    isExtremeScenario,
    modelCount: models.length
  }
}

/**
 * 将项目聚合结果转换为分布数组
 * @param {Map<string, {name: string, value: number}>} aggregatedProjects - 项目聚合结果
 * @returns {Array<{name: string, value: number, color: string}>}
 */
function generateProjectDistribution(aggregatedProjects) {
  return Array.from(aggregatedProjects.values())
    .map((item, index) => ({
      name: item.name,
      value: item.value,
      color: PROJECT_COLORS[index % PROJECT_COLORS.length]
    }))
    .sort((a, b) => b.value - a.value)
}

/**
 * 组装用量展示数据
 * @param {Map<string, object>} aggregatedModels - 模型聚合结果
 * @param {Map<string, {name: string, value: number}>} aggregatedProjects - 项目聚合结果
 * @returns {{total:number,input:number,output:number,cacheRead:number,cacheCreate:number,models:Array,distribution:Array,projectDistribution:Array,isExtremeScenario:boolean,modelCount:number}}
 */
function buildUsageViewData(aggregatedModels, aggregatedProjects = new Map()) {
  return {
    ...generateModelViewData(aggregatedModels),
    projectDistribution: generateProjectDistribution(aggregatedProjects)
  }
}

module.exports = {
  buildUsageViewData
}
