/**
 * 审核配置的唯一写方（后-01）：模型汇总两页签的读写与给 dev 的审核配置都经过这里
 *
 * 负责：
 * - 读：模型页签（来源 + 本页设置）、审核规则页签（规则 + dev 两端 + 审核配置写没写进去）；打开只读不写，
 *   只有第一次打开写初始开关与顺序（A-014）；审核配置的状态按硬盘上的文件和上一次重新生成的结果显示（A-009）
 * - 存：每次保存两步——先写本页设置或审核规则，再重新生成审核配置；第二步失败把第一步按字节退回（后-10）
 *   保存前写恢复记录 .save-journal.json：state=saving（保存途中）/ rollback（明确失败且退回也失败）
 * - 有没做完的恢复记录时，任何写入都在同一把锁里先把它处理完（rollback → 还原旧字节；saving → 以已落盘的为准），
 *   处理不完就拒绝这次写入、不动记录
 * - 启动对账（reconcile）：按恢复记录处理，再按设置重新生成审核配置（后-10、后-17）
 * - 模型接入事件后（refreshQuietly）：接入模型首次出现时抄等级，再重新生成
 * - 写入锁：同一配置目录只允许一个 CodePal 写（后-12）
 *
 * @module electron/modules/models/reviewCenter
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const store = require('./store')
const hub = require('./hub')
const defaultsModule = require('./reviewDefaults')
const { readOverrides, serialize: serializeRules } = require('./reviewRules')
const { atomicWrite, buildReviewConfig, readReviewConfig, writeReviewConfig } = require('./reviewModels')
const { readDevStatus } = require('./devStatus')
const { createWriteLock } = require('./writeLock')

const WRITE_DENIED = '配置目录没有写入权限，检查权限后重试'
const ROLLBACK_FAILED_MESSAGE = '保存失败，也没能退回原来的设置；检查配置目录的权限后重启 CodePal'
const JOURNAL = '.save-journal.json'
const PASS_THROUGH = new Set(['HUB_FILE_INVALID', 'RULES_FILE_INVALID', 'LOCK_BUSY', 'ROLLBACK_FAILED', 'write_denied', 'invalid_input', 'not_found'])

function fault(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 文件系统错误翻成页面能读的原因；业务错误原样 */
function translate(error) {
  if (error && PASS_THROUGH.has(error.code)) return error
  if (error && ['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return fault('write_denied', WRITE_DENIED)
  return error
}

/**
 * @param {object} [options]
 * @param {string} [options.homeDir] 可信 home（测试注入）
 * @param {object} [options.env] 可信环境
 * @param {Function} [options.locateClaude] / [options.locateCodex] 可注入的命令定位
 * @param {{version: string, values: object}} [options.defaults] 默认值正本（测试注入升级场景）
 * @returns {object} list / setEnabled / setEffort / setOrder / rulesGet / rulesSet / rulesReset / republish /
 *   reconcile / refreshQuietly / stop；读写失败抛带 code 的错误（HUB_FILE_INVALID、RULES_FILE_INVALID、
 *   LOCK_BUSY、ROLLBACK_FAILED、write_denied、invalid_input、not_found）
 */
function createReviewCenter(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const env = options.env || process.env
  const root = store.resolveModelsHome({ homeDir, env })
  const discovery = { ...options, homeDir, env }
  const defaults = options.defaults
    ? { version: options.defaults.version, values: options.defaults.values }
    : { version: defaultsModule.DEFAULTS_VERSION, values: defaultsModule.DEFAULTS }
  const files = {
    'hub.json': path.join(root, 'hub.json'),
    'review-rules.json': path.join(root, 'review-rules.json'),
  }
  const journalFile = path.join(root, JOURNAL)
  const lock = createWriteLock(root)
  let exportOk = true

  // ---- 读 ----

  /**
   * 来源 + 本页设置；还没有设置（或旧版没有顺序）时写一次初始开关与顺序并随即按它重新生成审核配置
   * （A-014 允许的唯一写入；通常启动对账已先做过）。拿不到锁就只在内存里用
   */
  function load() {
    const sources = hub.currentSources(discovery)
    let preferences = hub.readPreferences(files['hub.json'])
    if (preferences && Array.isArray(preferences.order)) return { sources, preferences }
    preferences = preferences
      ? { ...preferences, order: hub.initialOrder(sources, preferences.reviewEnabled) }
      : hub.initialPreferences(sources)
    try {
      lock.acquire()
      store.ensureDir(root)
      atomicWrite(files['hub.json'], hub.serializePreferences(preferences), 0o600)
      writeReviewConfig(root, configFor(sources, preferences))
      exportOk = true
    } catch {
      // 另一个 CodePal 在写或目录写不进：这次先按初始值显示，下次能写时再落盘；红字只由重新生成路径报
    }
    return { sources, preferences }
  }

  /** 生效的审核规则；规则文件坏了时沿用上一份有效审核配置里的规则，没有就用默认值（后-06） */
  function rulesForConfig() {
    try {
      return defaultsModule.effectiveRules(readOverrides(files['review-rules.json']) || {}, defaults.values)
    } catch (error) {
      if (error.code !== 'RULES_FILE_INVALID') throw error
      const current = readReviewConfig(root)
      if (current.state === 'valid') {
        const { selfReview, gates, advanced } = current.config
        return structuredClone({ selfReview, gates, advanced })
      }
      return defaultsModule.effectiveRules({}, defaults.values)
    }
  }

  function configFor(sources, preferences) {
    const data = hub.decorate(sources, preferences)
    const visible = hub.visibleEnabled(data)
    const models = hub.enabledOrder(data, preferences).map((id) => visible.get(id))
    return buildReviewConfig(models, rulesForConfig(), defaults)
  }

  /** 按磁盘上的设置重新生成审核配置（内容没变不写）；失败抛出 */
  function publish() {
    const { sources, preferences } = load()
    store.ensureDir(root)
    writeReviewConfig(root, configFor(sources, preferences))
    exportOk = true
  }

  function list() {
    const { sources, preferences } = load()
    const data = hub.decorate(sources, preferences)
    return hub.publicView(data, hub.enabledOrder(data, preferences))
  }

  /** 和这个版本的建议值一样吗（A-003：一样时「恢复默认」变灰；改过记录另由 A-010 管升级跟随） */
  const differsFromDefaults = (effective) =>
    JSON.stringify(effective) !== JSON.stringify(defaultsModule.effectiveRules({}, defaults.values))

  function rulesGet() {
    load()
    const overrides = readOverrides(files['review-rules.json']) || {}
    const effective = defaultsModule.effectiveRules(overrides, defaults.values)
    // 只读：红字只看上一次重新生成（启动对账、模型接入事件、重试）有没有写进去；发现文件没了 / 坏了不在这里报，
    // 交给下一次重新生成去修（定稿「发现就重新生成、不提示」）。写不进去时 dev 在用什么按硬盘状态说（SRC-007）：
    // 还有有效的上一份 → previous；没有或坏了 → defaults
    const ok = exportOk
    const usable = ok || readReviewConfig(root).state === 'valid'
    return {
      effective,
      overrides,
      changed: differsFromDefaults(effective),
      suggested: defaultsModule.effectiveRules({}, defaults.values),
      defaultsVersion: defaults.version,
      dev: readDevStatus({ homeDir, minVersion: defaultsModule.MIN_DEV_WORKFLOW }),
      exportOk: ok,
      exportUsing: ok ? null : usable ? 'previous' : 'defaults',
    }
  }

  // ---- 两步保存 ----

  function writeJournal(state, name, before) {
    store.ensureDir(root)
    const record = { schemaVersion: 1, state, file: name, before: before === null ? null : before.toString('base64'), startedAt: new Date().toISOString() }
    atomicWrite(journalFile, JSON.stringify(record) + '\n', 0o600)
  }

  function restore(name, before) {
    if (before === null) fs.rmSync(files[name], { force: true })
    else atomicWrite(files[name], before, 0o600)
  }

  /**
   * 处理上一次没做完的保存（调用方已持锁）：rollback 记录按原字节还原；saving 记录以已落盘的设置为准；
   * 再按设置重新生成审核配置并删掉记录
   * @returns {boolean} 处理完了（或本来就没有）；处理不完返回 false，记录原样保留
   */
  function recoverPending() {
    let record
    try {
      record = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return true
      record = null
    }
    try {
      if (record && Object.hasOwn(files, record.file) && record.state === 'rollback')
        restore(record.file, record.before === null ? null : Buffer.from(record.before, 'base64'))
      publish()
      fs.rmSync(journalFile, { force: true })
      return true
    } catch {
      exportOk = false
      return false
    }
  }

  /**
   * 先写 name 这份文件（next 返回新文本），再重新生成审核配置；第二步失败把第一步按字节退回
   * @param {'hub.json'|'review-rules.json'} name
   * @param {(context: {sources: object, preferences: object}) => string} next 计算新文本；非法输入在这里抛，什么都还没写
   */
  function save(name, next) {
    try {
      lock.acquire()
      if (!recoverPending()) throw fault('ROLLBACK_FAILED', ROLLBACK_FAILED_MESSAGE)
      const context = load()
      const text = next(context)
      const before = hub.readBytes(files[name])
      writeJournal('saving', name, before)
      try {
        atomicWrite(files[name], text, 0o600)
      } catch (error) {
        fs.rmSync(journalFile, { force: true })
        throw error
      }
      try {
        publish()
      } catch (error) {
        try {
          restore(name, before)
          fs.rmSync(journalFile, { force: true })
        } catch {
          try {
            writeJournal('rollback', name, before)
          } catch {
            // 连「要退回」都没写进去：之后按「保存中」处理，以当时磁盘上的设置为准，两份文件仍一致
          }
          throw fault('ROLLBACK_FAILED', ROLLBACK_FAILED_MESSAGE)
        }
        throw error
      }
      // 两份文件都已提交：删不掉恢复记录不算保存失败；留下的「保存中」记录在下一次写入或启动时按已落盘的设置处理
      try {
        fs.rmSync(journalFile, { force: true })
      } catch {
        // 留着无害
      }
    } catch (error) {
      throw translate(error)
    }
  }

  function findModel({ sources, preferences }, id) {
    if (typeof id !== 'string') throw fault('invalid_input', '没有这个模型')
    const data = hub.decorate(sources, preferences)
    for (const vendor of data.vendors) {
      if (vendor.blocked) continue
      const model = vendor.models.find((item) => item.id === id)
      if (model) return model
    }
    throw fault('not_found', '没有这个模型')
  }

  function setEnabled({ id, enabled } = {}) {
    if (typeof enabled !== 'boolean') throw fault('invalid_input', '开关值不对')
    save('hub.json', (context) => {
      findModel(context, id)
      const preferences = structuredClone(context.preferences)
      preferences.reviewEnabled[id] = enabled
      preferences.order = preferences.order.filter((item) => item !== id)
      if (enabled) preferences.order.push(id)
      return hub.serializePreferences(preferences)
    })
    return { id, enabled }
  }

  /** 审核用的等级只写本页设置；终端用的等级（models.json）归模型接入页管 */
  function setEffort({ id, effort } = {}) {
    save('hub.json', (context) => {
      const model = findModel(context, id)
      if (typeof effort !== 'string' || !model.efforts.includes(effort)) throw fault('invalid_input', '思考强度不对')
      const preferences = structuredClone(context.preferences)
      preferences.effort[id] = effort
      return hub.serializePreferences(preferences)
    })
    return { id, effort }
  }

  /**
   * 整串保存审核在用的顺序（后-15）：只接受当前可见审核在用模型的一个排列；
   * 暂时消失的模型留在原下标，可见的按新顺序依次填进其余位置
   */
  function setOrder({ order } = {}) {
    save('hub.json', ({ sources, preferences }) => {
      const data = hub.decorate(sources, preferences)
      const visible = hub.enabledOrder(data, preferences)
      if (
        !Array.isArray(order) ||
        order.length !== visible.length ||
        new Set(order).size !== order.length ||
        !order.every((id) => typeof id === 'string' && visible.includes(id))
      )
        throw fault('invalid_input', '顺序不对')
      const full = [...preferences.order]
      for (const id of visible) if (!full.includes(id)) full.push(id)
      const queue = [...order]
      const merged = full.map((id) => (visible.includes(id) ? queue.shift() : id))
      return hub.serializePreferences({ ...preferences, order: merged })
    })
    return { order: [...order] }
  }

  function rulesSet(payload) {
    if (!payload || typeof payload !== 'object') throw fault('invalid_input', '这项规则的取值不对')
    const { key, value } = payload
    let next
    save('review-rules.json', () => {
      next = defaultsModule.applyOverride(readOverrides(files['review-rules.json']) || {}, key, value, defaults.values)
      return serializeRules(next)
    })
    return { key, value, changed: differsFromDefaults(defaultsModule.effectiveRules(next, defaults.values)) }
  }

  /** 恢复默认：清空改过的规则项（后-14），不动模型的开关、顺序、等级 */
  function rulesReset() {
    save('review-rules.json', () => serializeRules({}))
    return { effective: defaultsModule.effectiveRules({}, defaults.values), changed: false }
  }

  // ---- 重新生成与对账 ----

  /**
   * F13「重试」：按设置重新生成审核配置
   * 另一个 CodePal 占着写入锁时不改红字状态（和后台重新生成一致），抛 LOCK_BUSY 让页面说明原因
   */
  function republish() {
    try {
      lock.acquire()
    } catch (error) {
      if (error.code === 'LOCK_BUSY') throw error
      exportOk = false
      return { exportOk }
    }
    try {
      if (recoverPending()) publish()
    } catch {
      exportOk = false
    }
    return { exportOk }
  }

  /** 模型接入事件后、启动时：接入模型首次出现抄等级，再重新生成；拿不到锁就跳过 */
  function refreshQuietly() {
    try {
      lock.acquire()
      if (!recoverPending()) return
      const { sources, preferences } = load()
      if (hub.seedProviderEfforts(sources, preferences)) atomicWrite(files['hub.json'], hub.serializePreferences(preferences), 0o600)
      publish()
    } catch (error) {
      if (error.code !== 'LOCK_BUSY') exportOk = false
    }
  }

  /** 启动对账：先处理恢复记录（要退回 → 还原；保存中 → 以已落盘的设置为准），再抄等级、重新生成 */
  function reconcile() {
    refreshQuietly()
  }

  function stop() {
    lock.release()
  }

  const wrap = (fn) => (...args) => {
    try {
      return fn(...args)
    } catch (error) {
      throw translate(error)
    }
  }

  return {
    list: wrap(list),
    refresh: wrap(list),
    rulesGet: wrap(rulesGet),
    setEnabled,
    setEffort,
    setOrder,
    rulesSet,
    rulesReset,
    republish,
    reconcile,
    refreshQuietly,
    stop,
  }
}

module.exports = { createReviewCenter, ROLLBACK_FAILED_MESSAGE }
