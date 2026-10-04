/**
 * 模型注册表 spec
 *
 * 负责：
 * - 声明 model-registry 配置的 schema 校验规则
 * - 提供硬编码 fallback（代码最底层兜底）
 * - 通过 remoteConfigLoader 被加载、拉取、缓存
 *
 * 数据结构：
 * - models: 模型别名数组，每项含 id / display / sublabel
 * - effortLevels: 推理等级数组，每项含 id / display / desc / [isDefault]
 *
 * @module electron/services/registries/modelRegistry
 */

const { loadPackagedJson } = require('./loadPackagedJson')

// effortLevel id 格式校验与 modelConfigHandlers 后端白名单保持一致
const EFFORT_ID_PATTERN = /^[a-z0-9_-]{1,32}$/

// 硬编码兜底：即使 json 文件被改坏或缺失，应用仍能工作
const HARDCODED_MODEL_FALLBACK = Object.freeze({
  version: 'hardcoded-fallback',
  updatedAt: null,
  models: [
    { id: 'fable', display: 'Fable 5.1', sublabel: '' },
    { id: 'opus', display: 'Opus 5.5', sublabel: '最强 · 1M' },
    { id: 'sonnet', display: 'Sonnet 5.5', sublabel: '日常 · 1M' },
    { id: 'haiku', display: 'Haiku 4.5', sublabel: '快速 · 200K' },
  ],
  effortLevels: [
    { id: 'low', display: '低', desc: '快速响应，适合简单问答' },
    { id: 'medium', display: '中', desc: '平衡速度与质量，Claude 默认值', isDefault: true },
    { id: 'high', display: '高', desc: '深度思考，适合复杂编码任务' },
    { id: 'xhigh', display: '超高', desc: 'Claude 4.7 新增，推理最充分，适合复杂架构与调试' },
    { id: 'max', display: 'max', desc: '' },
  ],
})

/**
 * 校验 model-registry 数据结构
 * @param {unknown} data - 待校验对象
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
function validateModelRegistry(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'registry 必须是对象' }
  }

  if (!Array.isArray(data.models) || data.models.length === 0) {
    return { valid: false, error: 'models 必须是非空数组' }
  }
  for (const model of data.models) {
    if (!model || typeof model.id !== 'string' || !model.id) {
      return { valid: false, error: 'model.id 必须是非空字符串' }
    }
    if (typeof model.sublabel !== 'string') {
      return { valid: false, error: `model[${model.id}].sublabel 必须是字符串` }
    }
    if (model.display !== undefined && typeof model.display !== 'string') {
      return { valid: false, error: `model[${model.id}].display 必须是字符串` }
    }
  }

  if (!Array.isArray(data.effortLevels) || data.effortLevels.length === 0) {
    return { valid: false, error: 'effortLevels 必须是非空数组' }
  }
  for (const level of data.effortLevels) {
    if (!level || typeof level.id !== 'string') {
      return { valid: false, error: 'effortLevels[].id 必须是字符串' }
    }
    if (!EFFORT_ID_PATTERN.test(level.id)) {
      return { valid: false, error: `effortLevel.id 非法: ${level.id}` }
    }
    if (typeof level.display !== 'string' || !level.display) {
      return { valid: false, error: `effortLevel[${level.id}].display 必须是非空字符串` }
    }
    if (typeof level.desc !== 'string') {
      return { valid: false, error: `effortLevel[${level.id}].desc 必须是字符串` }
    }
  }

  return { valid: true }
}

/**
 * model-registry 的 loader spec
 */
const modelRegistrySpec = {
  name: 'model-registry',
  remotePath: 'src/config/model-registry.json',
  cacheFileName: 'model-registry.cache.json',
  packaged: loadPackagedJson('src/config/model-registry.json'),
  hardcoded: HARDCODED_MODEL_FALLBACK,
  validate: validateModelRegistry,
}

module.exports = {
  modelRegistrySpec,
  validateModelRegistry,
  HARDCODED_MODEL_FALLBACK,
  EFFORT_ID_PATTERN,
}
