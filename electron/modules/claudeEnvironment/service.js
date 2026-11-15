/** One sampler and one settings owner for the Claude-specific environment. */
const { inspectEnvironment } = require('./inspect')
const { runProbe } = require('./probeRunner')
const { present, cleanNetwork, cleanHistory } = require('./state')

const STORE_KEY = 'claudeEnvironment'
const INTERVAL_MS = 5 * 60 * 1000

function createClaudeEnvironmentService({ store, inspect = inspectEnvironment, probe = runProbe, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, notify = () => {}, isWindowFocused = () => false } = {}) {
  const saved = store?.get(STORE_KEY, {}) || {}
  let metadata = { supported: true, available: false, reason: 'missing' }
  let enabled = saved.enabled === true
  let history = cleanHistory(saved.history, now())
  let lastSuccess = null
  let sample = null
  let busy = false
  let foreground = false
  let disposed = false
  let initialized = false
  let initializing = null
  let pending = null
  let controller = null
  let trigger = null
  let timer = null
  let revision = 0
  let lastTransition = typeof saved.lastTransition === 'string' && saved.lastTransition.length < 100 ? saved.lastTransition : null
  const listeners = new Set()

  const snapshot = () => present({ metadata, sample, monitoring: enabled, busy, history: cleanHistory(history, now()), lastSuccess, now: now(), revision })
  function publish() {
    revision += 1
    const state = snapshot()
    for (const listener of listeners) { try { listener(state) } catch { /* A closing renderer does not stop sampling. */ } }
    return state
  }
  function persist(override = {}) {
    store?.set(STORE_KEY, { enabled, history, lastTransition, ...override })
  }
  function stopSchedule() {
    if (timer !== null) clearIntervalFn(timer)
    timer = null
  }
  function schedule() {
    stopSchedule()
    if (!enabled || disposed) return
    timer = setIntervalFn(() => { sampleOnce('automatic').catch(() => {}) }, INTERVAL_MS)
    timer?.unref?.()
  }

  async function readState() {
    const value = await inspect()
    if (!disposed) metadata = value
    revision += 1
    return snapshot()
  }

  async function sampleOnce(origin = 'manual') {
    if (disposed) throw Error('SERVICE_CLOSED')
    if (pending) {
      if (origin === 'manual') trigger = 'manual'
      return pending
    }
    controller = new AbortController()
    const signal = controller.signal
    trigger = origin
    busy = true
    publish()
    pending = (async () => {
      const before = await inspect()
      if (disposed || signal.aborted) return snapshot()
      metadata = before
      if (!before.available) return snapshot()
      let network
      try {
        network = cleanNetwork(await probe({ metadata: before, signal }))
      } catch {
        if (disposed || signal.aborted) return snapshot()
        network = cleanNetwork({ proxyReady: true })
      }
      const after = await inspect()
      if (disposed || signal.aborted) return snapshot()
      metadata = after
      if (!after.available || before.fingerprint !== after.fingerprint) {
        // A late sample cannot certify a profile or entry that changed while it ran.
        sample = { checkedAt: now(), fingerprint: before.fingerprint, network }
        return snapshot()
      }
      sample = { checkedAt: now(), fingerprint: before.fingerprint, network }
      if (network.egress.ok) lastSuccess = { ...network.egress, checkedAt: sample.checkedAt }
      const state = snapshot()
      const transition = `${state.code}|${state.egress.ip || ''}|${state.egress.country || ''}`
      if (transition !== lastTransition || trigger === 'manual') {
        const code = state.code === 'healthy' ? lastTransition && !lastTransition.startsWith('healthy|') ? 'recovered' : 'checked' : state.code
        history.unshift({ at: sample.checkedAt, code, ip: state.egress.ip, country: state.egress.country })
        history = cleanHistory(history, now())
      }
      if (enabled && transition !== lastTransition && !(foreground && isWindowFocused())) {
        if (state.code !== 'healthy' || lastTransition && !lastTransition.startsWith('healthy|')) {
          try {
            notify({ kind: state.code === 'healthy' ? 'recovered' : state.tone === 'red' ? 'unreachable' : 'changed', title: `Claude 环境 · ${state.code === 'healthy' ? '恢复正常' : '需要复核'}`, body: state.code === 'healthy' ? '已测出口与 DNS 均符合美国目标' : state.label })
          } catch { /* OS notification availability does not invalidate network facts. */ }
        }
      }
      lastTransition = transition
      try { persist() } catch { /* A failed history write must not replace valid probe evidence. */ }
      return snapshot()
    })().finally(() => {
      pending = null
      controller = null
      trigger = null
      busy = false
      if (!disposed) publish()
    }).then(() => snapshot())
    return pending
  }

  async function initialize() {
    if (initialized) return snapshot()
    if (initializing) return initializing
    initializing = (async () => {
      metadata = await inspect()
      if (disposed) return snapshot()
      // The selected design starts monitoring an already configured environment.
      // Computers without that environment remain idle and send no network requests.
      if (typeof saved.enabled !== 'boolean' && typeof store?.get(STORE_KEY, {})?.enabled !== 'boolean') enabled = metadata.available
      initialized = true
      schedule()
      publish()
      if (enabled && metadata.available) sampleOnce('automatic').catch(() => {})
      return snapshot()
    })()
    return initializing
  }

  async function setMonitoring(value) {
    if (typeof value !== 'boolean') throw Error('INVALID_INPUT')
    metadata = await inspect()
    if (disposed) throw Error('SERVICE_CLOSED')
    if (value && !metadata.available) throw Error('ENVIRONMENT_UNAVAILABLE')
    try { persist({ enabled: value }) } catch { throw Error('PREFERENCES_FAILED') }
    enabled = value
    if (!value && trigger === 'automatic') controller?.abort()
    schedule()
    publish()
    if (value) sampleOnce('automatic').catch(() => {})
    return snapshot()
  }

  async function dispose() {
    disposed = true
    stopSchedule()
    listeners.clear()
    controller?.abort()
    if (pending) await pending.catch(() => {})
  }

  return {
    initialize, readState, sampleOnce, setMonitoring, dispose,
    setForeground: value => { foreground = value === true },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

module.exports = { createClaudeEnvironmentService, INTERVAL_MS, STORE_KEY }
