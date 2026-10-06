/**
 * 模型汇总的本页设置 hub.json：哪些模型用于审核、审核用的思考等级、审核在用的顺序
 *
 * 负责（纯读与计算，写文件由 reviewCenter 统一做）：
 * - 读并校验 hub.json；坏了抛 HUB_FILE_INVALID（不改写）
 * - 发现当前能用的模型来源（Claude Code、Codex、模型接入里测通的）
 * - 第一次打开的开关、顺序与等级（A-016）；从上一版升级时补顺序（后-45）
 * - 给页面看的模型列表：开关、审核用的等级（档位不再支持时退回默认档并标出原值，后-29）
 * - 审核在用的可见顺序（暂时消失的模型留在 order 里，恢复后回原位，后-35）
 *
 * @module electron/modules/models/hub
 */
const fs = require('fs')
const store = require('./store')
const { PRESETS, modelCapabilities } = require('./presets')
const { discoverSubscriptions } = require('./subscriptions')

const COLORS = {
  deepseek: 'var(--ic-blue)',
  'mimo-api': 'var(--ic-orange)',
  'zhipu-api': 'var(--ic-green)',
  'kimi-api': 'var(--ic-purple)',
  'zhipu-coding': 'var(--ic-green)',
  'kimi-coding': 'var(--ic-purple)',
  'minimax-api': 'var(--ic-orange)',
  'minimax-plan': 'var(--ic-orange)',
}
const HUB_FILE_INVALID_MESSAGE = '模型汇总的设置文件无法解析，修好或删除它后重试'
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function fault(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function readBytes(file) {
  try {
    return fs.readFileSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * @param {string} file hub.json 的可信路径
 * @returns {object|null} 设置；文件不存在返回 null
 * @throws {Error} code=HUB_FILE_INVALID
 */
function readPreferences(file) {
  const bytes = readBytes(file)
  if (bytes === null) return null
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    if (
      !object(value) ||
      value.schemaVersion !== 1 ||
      typeof value.initializedAt !== 'string' ||
      !object(value.reviewEnabled) ||
      !object(value.effort)
    )
      throw new Error('shape')
    if (
      !Object.values(value.reviewEnabled).every((entry) => typeof entry === 'boolean') ||
      !Object.values(value.effort).every((entry) => typeof entry === 'string')
    )
      throw new Error('shape')
    if (value.order !== undefined && (!Array.isArray(value.order) || !value.order.every((id) => typeof id === 'string')))
      throw new Error('shape')
    return value
  } catch {
    throw fault('HUB_FILE_INVALID', HUB_FILE_INVALID_MESSAGE)
  }
}

/** @returns {string} 要落盘的 hub.json 文本 */
function serializePreferences(preferences) {
  return JSON.stringify(preferences, null, 2) + '\n'
}

/** A test result determines availability; a later review result cannot erase that fact. */
function tested(status) {
  if (!status) return false
  return Object.hasOwn(status, 'lastTest') ? status.lastTest?.ok === true : status.ok === true
}

/** 模型接入里填了 Key、测通了的模型，按模型接入页的顺序（预设顺序） */
function providerSources() {
  const vendors = []
  let providerConfigError = false
  try {
    const config = store.readConfig()
    const statuses = store.readStatuses()
    for (const preset of Object.values(PRESETS)) {
      const provider = config.providers[preset.id]
      if (!provider || provider.keySet !== true) continue
      // Key 文件丢了或读不出：这家暂时不给审核用（只影响这一家，开关、等级、顺序都留着，读得出后回原位）
      if (!store.keyState(preset.id).keyReadable) continue
      if (!Array.isArray(provider.models)) throw new Error('invalid provider models')
      const models = provider.models
        .filter((model) => tested(statuses[`${preset.id}__${model.id}`]))
        .map((model) => ({
          slug: model.id,
          displayName: model.name,
          efforts: [...modelCapabilities(preset, model.name).efforts],
          effort: model.effort,
        }))
      if (models.length)
        vendors.push({ id: preset.id, name: preset.name, color: COLORS[preset.id], blocked: null, models })
    }
  } catch {
    providerConfigError = true
    vendors.length = 0
  }
  return { vendors, providerConfigError }
}

/**
 * @param {object} options 可信 homeDir / env 及可注入的 CLI 定位函数
 * @returns {{vendors: Array<object>, providerConfigError: boolean}} Claude Code → Codex → 模型接入各家
 */
function currentSources(options) {
  const providers = providerSources()
  return {
    vendors: [...discoverSubscriptions(options), ...providers.vendors],
    providerConfigError: providers.providerConfigError,
  }
}

const isSubscription = (vendorId) => vendorId === 'claude' || vendorId === 'codex'

/** 没设过审核等级时的默认档：订阅照定稿字面 high（v2.1.12 已确认，不偷偷换成首档）；接入模型沿用它在模型接入里的值 */
function defaultEffort(vendorId, model) {
  if (!model.efforts.length) return null
  if (isSubscription(vendorId)) return 'high'
  return model.efforts.includes(model.effort) ? model.effort : model.efforts[0]
}

/**
 * 审核用的等级（后-29）：保存的档位还支持就用它；不再支持退回默认档并带出原值；没有档位为 null
 * @returns {{effort: string|null, effortUnsupported?: string}}
 */
function hubEffort(vendorId, model, preferences, id) {
  if (!model.efforts.length) return { effort: null }
  const saved = preferences.effort[id]
  if (saved === undefined || model.efforts.includes(saved)) return { effort: saved ?? defaultEffort(vendorId, model) }
  return { effort: defaultEffort(vendorId, model), effortUnsupported: saved }
}

/**
 * 接入模型第一次出现时，把它此刻在模型接入里的等级抄一份进汇总设置：两边各管各的
 * （接入管终端，汇总管审核）。只在重新生成路径调用（启动对账、模型接入事件后），页面读取不调。
 * @returns {boolean} 有没有新抄的条目
 */
function seedProviderEfforts(sources, preferences) {
  let changed = false
  for (const vendor of sources.vendors) {
    if (vendor.blocked || isSubscription(vendor.id)) continue
    for (const model of vendor.models) {
      const id = `${vendor.id}:${model.slug}`
      if (Object.hasOwn(preferences.effort, id) || !model.efforts.includes(model.effort)) continue
      preferences.effort[id] = model.effort
      changed = true
    }
  }
  return changed
}

/** 给每个模型叠上开关与审核用的等级 */
function decorate(sources, preferences) {
  return {
    providerConfigError: sources.providerConfigError,
    vendors: sources.vendors.map((vendor) => ({
      ...vendor,
      models: vendor.models.map((model) => {
        const id = `${vendor.id}:${model.slug}`
        return {
          ...model,
          id,
          enabled: preferences.reviewEnabled[id] === true,
          ...hubEffort(vendor.id, model, preferences, id),
        }
      }),
    })),
  }
}

/** 打开且现在能用的模型：id → { vendorId, model }，按来源发现顺序 */
function visibleEnabled(data) {
  const visible = new Map()
  for (const vendor of data.vendors) {
    if (vendor.blocked) continue
    for (const model of vendor.models) if (model.enabled) visible.set(model.id, { vendorId: vendor.id, model })
  }
  return visible
}

/**
 * 审核在用的可见顺序：按 order 排，order 里没有的（不该出现，兜底）按发现顺序接在后面
 * @returns {string[]}
 */
function enabledOrder(data, preferences) {
  const visible = visibleEnabled(data)
  const order = (preferences.order || []).filter((id) => visible.has(id))
  for (const id of visible.keys()) if (!order.includes(id)) order.push(id)
  return order
}

/**
 * 第一次打开（或从上一版升级、hub.json 还没有顺序）时的顺序：Claude Code → Codex → 模型接入各家，
 * 同一家按它自己清单的顺序；这次看不到的已开模型排在后面
 */
function initialOrder(sources, reviewEnabled) {
  const order = []
  for (const vendor of sources.vendors) {
    if (vendor.blocked) continue
    for (const model of vendor.models) {
      const id = `${vendor.id}:${model.slug}`
      if (reviewEnabled[id] === true) order.push(id)
    }
  }
  for (const [id, on] of Object.entries(reviewEnabled).sort(([a], [b]) => a.localeCompare(b)))
    if (on && !order.includes(id)) order.push(id)
  return order
}

/**
 * 第一次打开的设置（A-016）：有 Claude Code 开它的默认模型，有 Codex 开它的默认模型，
 * 模型接入里只开测通了、审核已在用的（DeepSeek）；其余关
 */
function initialPreferences(sources) {
  const reviewEnabled = {}
  for (const vendor of sources.vendors) {
    if (vendor.blocked) continue
    const chosen = isSubscription(vendor.id)
      ? vendor.models.find((model) => model.slug === vendor.defaultModel)
      : vendor.id === 'deepseek'
        ? vendor.models[0]
        : null
    if (chosen) reviewEnabled[`${vendor.id}:${chosen.slug}`] = true
  }
  return {
    schemaVersion: 1,
    initializedAt: new Date().toISOString(),
    reviewEnabled,
    effort: {},
    order: initialOrder(sources, reviewEnabled),
  }
}

/** 给页面的数据：不含凭证、路径；带审核在用的可见顺序 */
function publicView(data, order) {
  return {
    providerConfigError: data.providerConfigError,
    order,
    vendors: data.vendors.map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      color: vendor.color,
      blocked: vendor.blocked,
      models: vendor.models.map(({ id, displayName, efforts, effort, enabled, effortUnsupported }) => ({
        id,
        displayName,
        efforts,
        effort,
        enabled,
        ...(effortUnsupported ? { effortUnsupported } : {}),
      })),
    })),
  }
}

/** 兼容旧入口：汇总页的读写都由 reviewCenter 负责（延迟加载，避免循环依赖） */
function createModelHub(options) {
  return require('./reviewCenter').createReviewCenter(options)
}

module.exports = {
  HUB_FILE_INVALID_MESSAGE,
  readBytes,
  readPreferences,
  serializePreferences,
  currentSources,
  seedProviderEfforts,
  decorate,
  visibleEnabled,
  enabledOrder,
  initialOrder,
  initialPreferences,
  publicView,
  createModelHub,
}
