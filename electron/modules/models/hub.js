/** Own model-hub preferences and coordinate private changes with the public review snapshot. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const store = require('./store')
const { PRESETS } = require('./presets')
const { discoverSubscriptions } = require('./subscriptions')
const { atomicWrite, writeReviewModels } = require('./reviewModels')

const COLORS = {
  deepseek: 'var(--ic-blue)',
  'mimo-api': 'var(--ic-orange)',
  'zhipu-api': 'var(--ic-green)',
  'kimi-api': 'var(--ic-purple)',
  'zhipu-coding': 'var(--ic-green)',
  'kimi-coding': 'var(--ic-purple)',
}
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
    return value
  } catch {
    throw fault('HUB_FILE_INVALID', '模型汇总的设置文件无法解析，修好或删除它后重试')
  }
}

/** A test result determines availability; a later review result cannot erase that fact. */
function tested(status) {
  if (!status) return false
  return Object.hasOwn(status, 'lastTest') ? status.lastTest?.ok === true : status.ok === true
}

function providerSources() {
  const vendors = []
  let providerConfigError = false
  try {
    const config = store.readConfig()
    const statuses = store.readStatuses()
    for (const preset of Object.values(PRESETS)) {
      const provider = config.providers[preset.id]
      if (!provider || provider.keySet !== true) continue
      if (!Array.isArray(provider.models)) throw new Error('invalid provider models')
      const models = provider.models
        .filter((model) => tested(statuses[`${preset.id}__${model.id}`]))
        .map((model) => ({
          slug: model.id,
          displayName: model.name,
          efforts: [...preset.efforts],
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

function currentSources(options) {
  const providers = providerSources()
  return {
    vendors: [...discoverSubscriptions(options), ...providers.vendors],
    providerConfigError: providers.providerConfigError,
  }
}

function decorate(sources, preferences) {
  return {
    providerConfigError: sources.providerConfigError,
    vendors: sources.vendors.map((vendor) => ({
      ...vendor,
      models: vendor.models.map((model) => {
        const id = `${vendor.id}:${model.slug}`
        const subscription = vendor.id === 'claude' || vendor.id === 'codex'
        return {
          ...model,
          id,
          enabled: preferences.reviewEnabled[id] === true,
          effort: subscription ? preferences.effort[id] || 'high' : model.effort,
        }
      }),
    })),
  }
}

function publicView(data) {
  return {
    providerConfigError: data.providerConfigError,
    vendors: data.vendors.map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      color: vendor.color,
      blocked: vendor.blocked,
      models: vendor.models.map(({ id, displayName, efforts, effort, enabled }) => ({
        id,
        displayName,
        efforts,
        effort,
        enabled,
      })),
    })),
  }
}

/**
 * 汇总偏好与公开审核清单的唯一写方。
 * @param {object} [options] 主进程提供的可信homeDir、env及CLI定位函数，不接收渲染层路径。
 * @returns {{list: Function, refresh: Function, setEnabled: Function, setEffort: Function}}
 * list/refresh返回不含凭证的来源列表；保存返回{id, enabled}或{id, effort}。
 * 首次读取创建0600 hub.json；读取和成功保存原子更新0644 review-models.json。
 * 保存失败逐字节恢复原设置；坏hub抛HUB_FILE_INVALID，非法输入抛invalid_input/not_found。
 */
function createModelHub(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const env = options.env || process.env
  const root = store.resolveModelsHome({ homeDir, env })
  const hubFile = path.join(root, 'hub.json')
  const discovery = { ...options, homeDir, env }

  function initialize(sources) {
    const existing = readPreferences(hubFile)
    if (existing) return existing
    const preferences = { schemaVersion: 1, initializedAt: new Date().toISOString(), reviewEnabled: {}, effort: {} }
    for (const vendor of sources.vendors) {
      if (vendor.blocked) continue
      const chosen =
        vendor.id === 'claude' || vendor.id === 'codex'
          ? vendor.models.find((model) => model.slug === vendor.defaultModel)
          : vendor.id === 'deepseek'
            ? vendor.models[0]
            : null
      if (chosen) preferences.reviewEnabled[`${vendor.id}:${chosen.slug}`] = true
    }
    store.ensureDir(root)
    atomicWrite(hubFile, JSON.stringify(preferences, null, 2) + '\n', 0o600)
    return preferences
  }

  function state() {
    const sources = currentSources(discovery)
    return decorate(sources, initialize(sources))
  }

  function refresh() {
    const data = state()
    writeReviewModels(root, data.vendors)
    return publicView(data)
  }

  /** Private updates are rolled back byte-for-byte if replacing the public file fails. */
  function commit(file, update) {
    const before = readBytes(file)
    try {
      update()
      const data = state()
      writeReviewModels(root, data.vendors)
    } catch (error) {
      if (before === null) fs.rmSync(file, { force: true })
      else atomicWrite(file, before, 0o600)
      throw error
    }
  }

  function find(id) {
    if (typeof id !== 'string') throw fault('invalid_input', '没有这个模型')
    const data = state()
    for (const vendor of data.vendors) {
      if (vendor.blocked) continue
      const model = vendor.models.find((item) => item.id === id)
      if (model) return { vendor, model }
    }
    throw fault('not_found', '没有这个模型')
  }

  function setEnabled({ id, enabled } = {}) {
    if (typeof enabled !== 'boolean') throw fault('invalid_input', '开关值不对')
    find(id)
    commit(hubFile, () => {
      const preferences = readPreferences(hubFile)
      preferences.reviewEnabled[id] = enabled
      atomicWrite(hubFile, JSON.stringify(preferences, null, 2) + '\n', 0o600)
    })
    return { id, enabled }
  }

  function setEffort({ id, effort } = {}) {
    const { vendor, model } = find(id)
    if (typeof effort !== 'string' || !model.efforts.includes(effort)) throw fault('invalid_input', '思考强度不对')
    if (vendor.id === 'claude' || vendor.id === 'codex') {
      commit(hubFile, () => {
        const preferences = readPreferences(hubFile)
        preferences.effort[id] = effort
        atomicWrite(hubFile, JSON.stringify(preferences, null, 2) + '\n', 0o600)
      })
    } else {
      commit(path.join(root, 'models.json'), () => store.updateModel(vendor.id, model.slug, { effort }))
    }
    return { id, effort }
  }

  return { list: refresh, refresh, setEnabled, setEffort }
}

module.exports = { createModelHub }
