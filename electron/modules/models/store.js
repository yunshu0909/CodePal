/**
 * 第三方模型接入 · 本机存储
 *
 * 负责：
 * - 目录 ~/Library/Application Support/CodePal/models/（0700）：models.json（配置，不含 Key）、
 *   secrets/<供应商>.key（Key 原文）、status/<供应商>__<模型>.json（最近一次调用结果）
 * - 所有文件 0600、原子替换写入；Key 只写不回读给渲染层（readKey 只给主进程与命令行用）
 * - 模型名规则：字母数字与 . - _，1–64 字，同家不区分大小写不重名，不能与供应商同名
 *
 * 写方约定：models.json 与 secrets/ 只由主进程写；status/ 只由命令行写（每个文件一个写方）。
 * 测试用覆盖口 CODEPAL_MODELS_HOME。
 *
 * @module electron/modules/models/store
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { PRESETS, MAX_OUTPUT_CAP, modelDefaults, modelCapabilities } = require('./presets')

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * 业务错误：code 给调用方判断，message 是可以直接展示的中文
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** @param {object} options Trusted home/environment overrides. @returns {string} Model root without reading credentials. */
function resolveModelsHome({ homeDir = os.homedir(), env = process.env } = {}) {
  return env.CODEPAL_MODELS_HOME || path.join(homeDir, 'Library', 'Application Support', 'CodePal', 'models')
}

/** 建目录；已存在时只收紧（去掉组和其他人的权限），不放宽用户自己设的权限 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const mode = fs.statSync(dir).mode & 0o777
  if (mode & 0o077) fs.chmodSync(dir, mode & DIR_MODE)
}

/**
 * 原子写一个 0600 文件：先写同目录临时文件再改名，读者永远看不到写了一半的内容
 * @param {string} file
 * @param {string} text
 */
function writePrivate(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, text, { mode: FILE_MODE, flag: 'wx' })
  try {
    fs.chmodSync(tmp, FILE_MODE)
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

const configFile = () => path.join(resolveModelsHome(), 'models.json')
const secretFile = (providerId) => path.join(resolveModelsHome(), 'secrets', `${providerId}.key`)
const statusDir = () => path.join(resolveModelsHome(), 'status')
const statusFile = (providerId, modelId) => path.join(statusDir(), `${providerId}__${modelId}.json`)

/**
 * 读配置；文件不存在给默认空配置，内容坏了抛 read_failed 且不动文件
 * @returns {{schemaVersion: number, providers: object, commandsInstalled: boolean}}
 */
function readConfig() {
  let text
  try {
    text = fs.readFileSync(configFile(), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { schemaVersion: 1, providers: {}, commandsInstalled: false }
    throw fail('read_failed', '模型配置文件读不出')
  }
  try {
    const cfg = JSON.parse(text)
    if (!cfg || typeof cfg !== 'object' || typeof cfg.providers !== 'object') throw new Error('shape')
    return { schemaVersion: 1, commandsInstalled: false, ...cfg }
  } catch {
    throw fail('read_failed', '模型配置文件无法解析')
  }
}

/** @param {object} cfg - 完整配置，整体替换写入 */
function writeConfig(cfg) {
  writePrivate(configFile(), JSON.stringify(cfg, null, 2) + '\n')
}

/** @param {string} providerId @returns {object} 预设，不认识的供应商抛 not_found */
function presetOf(providerId) {
  const preset = PRESETS[providerId]
  if (!preset) throw fail('not_found', `不认识的供应商：${providerId}`)
  return preset
}

/**
 * 校验 Key：非空字符串、无控制字符；有官方前缀的渠道再校验前缀
 * @param {string} providerId
 * @param {string} key
 */
function validateKey(providerId, key) {
  const preset = presetOf(providerId)
  if (typeof key !== 'string' || !key.trim() || /\p{Cc}/u.test(key)) throw fail('invalid_input', 'Key 格式不对')
  if (!key.startsWith(preset.keyPrefix) || key.length <= preset.keyPrefix.length) {
    throw fail('invalid_input', `${preset.name} 的 Key 以 ${preset.keyPrefix} 开头`)
  }
}

/**
 * 生成一个模型条目（id 即名字）
 * uid 标识这一个模型实例：移除后同名重加是新实例，旧调用的结果不能写到它头上
 */
function makeModel(preset, name) {
  return { id: name, name, uid: crypto.randomBytes(6).toString('hex'), ...modelDefaults(preset, name) }
}

/**
 * 保存 Key；这家第一次存 Key 时自动加入预设默认模型
 * @param {string} providerId
 * @param {string} key
 * @returns {{keySet: true}}
 */
function setKey(providerId, key) {
  validateKey(providerId, key)
  const preset = presetOf(providerId)
  const cfg = readConfig()
  writePrivate(secretFile(providerId), key)
  const prov = cfg.providers[providerId] || { models: [] }
  if (!prov.keySet && prov.models.length === 0) prov.models.push(makeModel(preset, preset.defaultModel))
  prov.keySet = true
  cfg.providers[providerId] = prov
  writeConfig(cfg)
  return { keySet: true }
}

/** @returns {{keySet: boolean, keyReadable: boolean}} */
function keyState(providerId) {
  const prov = readConfig().providers[providerId]
  const keySet = Boolean(prov && prov.keySet)
  let keyReadable = false
  if (keySet) {
    try {
      fs.accessSync(secretFile(providerId), fs.constants.R_OK)
      keyReadable = fs.readFileSync(secretFile(providerId), 'utf8').length > 0
    } catch {}
  }
  return { keySet, keyReadable }
}

/** 读 Key 原文（只给主进程与命令行；绝不经 IPC 回给渲染层）；读不到返回 null */
function readKey(providerId) {
  try {
    const key = fs.readFileSync(secretFile(providerId), 'utf8')
    return key || null
  } catch {
    return null
  }
}

/**
 * 校验模型名（添加与改名共用）
 * @param {object} prov - 当前这家的配置
 * @param {string} name - 新名字
 * @param {string} [selfId] - 改名时自己原来的 id，不算重名
 */
function validateModelName(prov, name, selfId) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw fail('invalid_input', '只能用字母、数字和 . - _')
  // 名字会变成命令文件名，和每家的稳定入口 codepal-<供应商> 撞名就会互相覆盖
  if (Object.keys(PRESETS).some((id) => id.toLowerCase() === name.toLowerCase())) throw fail('invalid_input', '不能和供应商同名')
  // macOS 文件名默认不区分大小写，只差大小写的两个命令会互相覆盖
  const clash = prov.models.find((m) => m.id !== selfId && m.name.toLowerCase() === name.toLowerCase())
  if (clash) throw fail('duplicate', '已经有这个模型了')
}

/** 取某家配置，没填过 Key 的抛 not_found */
function providerOf(cfg, providerId) {
  presetOf(providerId)
  const prov = cfg.providers[providerId]
  if (!prov) throw fail('not_found', '这家还没填 Key')
  return prov
}

/** @returns {object} 新模型 */
function addModel(providerId, rawName) {
  const cfg = readConfig()
  const prov = providerOf(cfg, providerId)
  const name = typeof rawName === 'string' ? rawName.trim() : rawName
  validateModelName(prov, name)
  const model = makeModel(presetOf(providerId), name)
  prov.models.push(model)
  writeConfig(cfg)
  return model
}

/** 正整数（上限类参数） */
const positiveInt = (v) => Number.isInteger(v) && v > 0

/**
 * 改模型：名字 / 思考强度 / 上下文上限 / 输出上限；改名即换 id
 * @returns {object} 改后的模型
 */
function updateModel(providerId, modelId, patch = {}) {
  const cfg = readConfig()
  const prov = providerOf(cfg, providerId)
  const model = prov.models.find((m) => m.id === modelId)
  if (!model) throw fail('not_found', '没有这个模型')
  const next = { ...model }
  if ('name' in patch) {
    const name = typeof patch.name === 'string' ? patch.name.trim() : patch.name
    validateModelName(prov, name, model.id)
    next.name = name
    next.id = name
    // 改名算新实例：A→B→A 之后，改名前发起的调用也不能写回
    if (name !== model.name) next.uid = crypto.randomBytes(6).toString('hex')
  }
  const preset = presetOf(providerId)
  const capabilities = modelCapabilities(preset, next.name)
  if (providerId.startsWith('minimax-') && next.name !== model.name && !capabilities.efforts.includes(next.effort)) {
    next.effort = modelDefaults(preset, next.name).effort
  }
  if ('effort' in patch) {
    if (!capabilities.efforts.includes(patch.effort)) throw fail('invalid_input', '思考强度不对')
    next.effort = patch.effort
  }
  for (const k of ['contextTokens', 'maxOutputTokens']) {
    if (k in patch) {
      if (!positiveInt(patch[k])) throw fail('invalid_input', '填正整数')
      if (k === 'maxOutputTokens' && patch[k] > MAX_OUTPUT_CAP) throw fail('invalid_input', '最多 128,000')
      next[k] = patch[k]
    }
  }
  prov.models[prov.models.indexOf(model)] = next
  writeConfig(cfg)
  // 名字变了，旧名字的测试结果不再算数
  if (next.id !== model.id) fs.rmSync(statusFile(providerId, model.id), { force: true })
  return next
}

/** 移除模型并删掉它的状态文件；Key 不动 */
function removeModel(providerId, modelId) {
  const cfg = readConfig()
  const prov = providerOf(cfg, providerId)
  const before = prov.models.length
  prov.models = prov.models.filter((m) => m.id !== modelId)
  if (prov.models.length === before) throw fail('not_found', '没有这个模型')
  writeConfig(cfg)
  fs.rmSync(statusFile(providerId, modelId), { force: true })
}

/**
 * 写一次调用结果（命令行在后台调用结束后写，页面「测一下」同一份）
 * @param {string} providerId
 * @param {string} modelId
 * @param {{ok: boolean, reason?: string|null, message?: string|null, source: 'test'|'review', runId?: string}} result
 *   runId：页面「测一下」给的本次调用编号，主进程只认带着它的结果
 */
function writeStatus(providerId, modelId, result) {
  ensureDir(resolveModelsHome())
  const record = { ok: Boolean(result.ok), reason: result.reason || null, message: result.message || null, at: new Date().toISOString(), source: result.source }
  if (result.runId) record.runId = result.runId
  // Review calls update the latest result, while availability retains the latest explicit test.
  let previous = null
  try {
    previous = JSON.parse(fs.readFileSync(statusFile(providerId, modelId), 'utf8'))
  } catch {}
  if (result.source === 'test') record.lastTest = { ok: record.ok, reason: record.reason, at: record.at }
  else if (previous && Object.hasOwn(previous, 'lastTest')) record.lastTest = previous.lastTest
  else if (previous) {
    // Legacy availability used the previous top-level result. Carry it when writing a new review,
    // without rewriting old records during reads or treating this new review as a new test.
    record.lastTest = { ok: previous.ok === true, reason: previous.reason || null, at: previous.at || null }
  } else record.lastTest = null
  writePrivate(statusFile(providerId, modelId), JSON.stringify(record))
  return record
}

/**
 * 调用开始时的那个模型实例现在还在不在（调用期间被移除、改名、同名重加都算不在）
 * @param {string} providerId
 * @param {{id: string, uid?: string}} model - 调用开始时读到的模型
 * @returns {boolean}
 */
function isCurrentModel(providerId, model) {
  try {
    const prov = readConfig().providers[providerId]
    const now = prov && prov.models.find((m) => m.id === model.id)
    return Boolean(now) && now.uid === model.uid
  } catch {
    return false
  }
}

/** @returns {Object<string, object>} 键为 <供应商>__<模型> */
function readStatuses() {
  const out = {}
  let names = []
  try { names = fs.readdirSync(statusDir()) } catch { return out }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try { out[n.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(statusDir(), n), 'utf8')) } catch {}
  }
  return out
}

module.exports = {
  resolveModelsHome,
  ensureDir,
  readConfig,
  writeConfig,
  validateKey,
  setKey,
  keyState,
  readKey,
  addModel,
  updateModel,
  removeModel,
  writeStatus,
  isCurrentModel,
  readStatuses,
  statusDir,
}
