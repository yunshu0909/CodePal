/** Own model-hub preferences and coordinate private changes with the public review snapshot. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const store = require('./store')
const { PRESETS, modelCapabilities } = require('./presets')
const { discoverSubscriptions } = require('./subscriptions')
const { atomicWrite, writeReviewModels } = require('./reviewModels')

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
      if (preset.id.startsWith('minimax-') && !store.keyState(preset.id).keyReadable) continue
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

function currentSources(options) {
  const providers = providerSources()
  return {
    vendors: [...discoverSubscriptions(options), ...providers.vendors],
    providerConfigError: providers.providerConfigError,
  }
}

const isSubscription = (vendorId) => vendorId === 'claude' || vendorId === 'codex'

/**
 * 接入模型第一次出现在汇总里时，把它此刻在模型接入里的强度抄一份进汇总设置：
 * 拆分后两边各管各的（接入管终端，汇总管审核），抄这一次保证审核清单的值不因拆分改变。
 * 已有条目、没有档位的模型（MiniMax M3）都不动。
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

/** 汇总里显示的强度：订阅默认 high；接入模型用汇总自己的设置，设置里没有或不再合法时退回接入的值 */
function hubEffort(vendorId, model, preferences, id) {
  const saved = preferences.effort[id]
  if (isSubscription(vendorId)) return saved || 'high'
  return model.efforts.includes(saved) ? saved : model.effort
}

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
          effort: hubEffort(vendor.id, model, preferences, id),
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
 * 首次读取创建0600 hub.json；接入模型第一次出现时把接入强度抄进hub.json；读取和成功保存原子更新0644 review-models.json。
 * 读取或保存失败时hub.json逐字节退回操作前（原本没有就删掉）；坏hub抛HUB_FILE_INVALID，非法输入抛invalid_input/not_found。
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
    const preferences = initialize(sources)
    if (seedProviderEfforts(sources, preferences)) atomicWrite(hubFile, JSON.stringify(preferences, null, 2) + '\n', 0o600)
    return decorate(sources, preferences)
  }

  /** 把汇总设置放回操作前的字节；原本没有就删掉，内容没变就不动 */
  function restoreHub(before) {
    const now = readBytes(hubFile)
    if (before === null) {
      if (now !== null) fs.rmSync(hubFile, { force: true })
    } else if (now === null || !now.equals(before)) {
      atomicWrite(hubFile, before, 0o600)
    }
  }

  /**
   * 一次读取或保存是一件事：期间可能新建 hub.json、补抄接入强度、写这次的改动，
   * 任何一步失败（含非法输入、公开清单写失败）都把 hub.json 退回操作前，不留半套
   */
  function transaction(work) {
    const before = readBytes(hubFile)
    try {
      return work()
    } catch (error) {
      restoreHub(before)
      throw error
    }
  }

  function publish() {
    const data = state()
    writeReviewModels(root, data.vendors)
    return data
  }

  function refresh() {
    return transaction(() => publicView(publish()))
  }

  function savePreference(mutate) {
    const preferences = readPreferences(hubFile)
    mutate(preferences)
    atomicWrite(hubFile, JSON.stringify(preferences, null, 2) + '\n', 0o600)
    publish()
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
    return transaction(() => {
      find(id)
      savePreference((preferences) => {
        preferences.reviewEnabled[id] = enabled
      })
      return { id, enabled }
    })
  }

  /** 审核用的强度只写汇总设置；接入模型在终端用的强度（models.json）归模型接入页管，这里不碰 */
  function setEffort({ id, effort } = {}) {
    return transaction(() => {
      const { model } = find(id)
      if (typeof effort !== 'string' || !model.efforts.includes(effort)) throw fault('invalid_input', '思考强度不对')
      savePreference((preferences) => {
        preferences.effort[id] = effort
      })
      return { id, effort }
    })
  }

  return { list: refresh, refresh, setEnabled, setEffort }
}

module.exports = { createModelHub }
