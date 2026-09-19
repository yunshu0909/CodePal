/**
 * 网络诊断服务（出口 IP）
 *
 * 负责：
 * - 获取公网 IPv4（双源降级：ipify → icanhazip）与归属地（ipinfo.io）
 * - 按需检测一次 / 用户开启的持续监控（页面内 5 秒、后台 60 秒）
 * - 持久化上次结果、近 7 天 IP 变化记录（最多 200 条）、是否比过
 * - 判定何时发系统通知：监控中 IP 变了、连续 3 次测不到；停在本页且窗口在前时不发
 *
 * 默认零请求：只有持久化开关严格为 true 时才在启动后恢复监控。
 *
 * @module electron/services/networkDiagnosticsService
 */

const https = require('https')
const { performance } = require('perf_hooks')

const REQUEST_TIMEOUT_MS = 6000

/**
 * 公网 IP 查询源配置
 * 按优先级排列，前者失败时自动降级到后者
 */
const IP_SOURCES = [
  {
    name: 'ipify',
    url: 'https://api.ipify.org?format=json',
    parseResponseBody(body) {
      const parsed = JSON.parse(body)
      return normalizeIpValue(parsed.ip)
    },
  },
  {
    name: 'icanhazip',
    url: 'https://ipv4.icanhazip.com',
    parseResponseBody(body) {
      return normalizeIpValue(body)
    },
  },
]

/**
 * 规范化公网 IP 文本
 * @param {string} value
 * @returns {string}
 */
function normalizeIpValue(value) {
  return String(value || '').trim()
}

/**
 * 发起 HTTPS 请求并返回完整响应
 * @param {Object} options
 * @param {string} options.url
 * @param {string} [options.method='GET']
 * @param {Record<string, string>} [options.headers={}]
 * @param {number} [options.timeoutMs=REQUEST_TIMEOUT_MS]
 * @returns {Promise<{statusCode: number|null, body: string, durationMs: number}>}
 */
function requestText({ url, method = 'GET', headers = {}, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const request = https.request(url, { method, headers }, (response) => {
      const chunks = []
      response.setEncoding('utf8')
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || null,
          body: chunks.join(''),
          durationMs: performance.now() - startedAt,
        })
      })
    })

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`REQUEST_TIMEOUT_${timeoutMs}MS`))
    })

    request.on('error', (error) => reject(error))
    request.end()
  })
}

/**
 * 获取当前公网 IPv4
 * @returns {Promise<{success: boolean, ip: string|null, source: string|null, durationMs: number|null, error: string|null}>}
 */
async function probePublicIp() {
  for (const source of IP_SOURCES) {
    const startedAt = performance.now()
    try {
      const response = await requestText({
        url: source.url,
        headers: {
          Accept: 'application/json, text/plain;q=0.9',
          'User-Agent': 'CodePal-Network-Diagnostics/1.0',
        },
      })
      const ip = source.parseResponseBody(response.body)
      if (ip) {
        return { success: true, ip, source: source.name, durationMs: performance.now() - startedAt, error: null }
      }
    } catch (error) {
      // 最后一个源也失败时返回错误
      if (source === IP_SOURCES[IP_SOURCES.length - 1]) {
        return { success: false, ip: null, source: source.name, durationMs: performance.now() - startedAt, error: error.message }
      }
    }
  }
  return { success: false, ip: null, source: null, durationMs: null, error: 'NO_IP_SOURCE_AVAILABLE' }
}

/* ============================================================
   归属地
   ============================================================ */

const LOCATION_URL = 'https://ipinfo.io/json'

/**
 * 国家代码转中文名；系统不认识的代码原样返回
 * @param {string} code - ISO 3166 两位代码，如 JP
 * @returns {string|null}
 */
function countryName(code) {
  const value = String(code || '').trim().toUpperCase()
  if (!value) return null
  try {
    return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(value) || value
  } catch {
    return value
  }
}

/**
 * 查询当前出口的归属地（只取国家与城市；城市没有可靠的中文来源，原样保留）
 * @returns {Promise<{country: string|null, city: string|null}|null>} 查不到返回 null
 */
async function lookupLocation() {
  try {
    const response = await requestText({
      url: LOCATION_URL,
      headers: { Accept: 'application/json', 'User-Agent': 'CodePal-Network-Diagnostics/1.0' },
    })
    const parsed = JSON.parse(response.body)
    const country = countryName(parsed.country)
    const city = typeof parsed.city === 'string' && parsed.city.trim() ? parsed.city.trim() : null
    return country || city ? { country, city } : null
  } catch {
    return null
  }
}

/* ============================================================
   通知文案
   ============================================================ */

/**
 * 归属地写成「（国家 · 城市）」；没有就返回空串
 * @param {{country: string|null, city: string|null}|null} location
 * @returns {string}
 */
function bracketLocation(location) {
  const text = [location?.country, location?.city].filter(Boolean).join(' · ')
  return text ? `（${text}）` : ''
}

/**
 * 生成系统通知的标题与正文
 * @param {'changed'|'unreachable'} kind
 * @param {{fromIp?: string, toIp?: string, fromLocation?: object|null, toLocation?: object|null}} [data]
 * @returns {{kind: string, title: string, body: string}}
 */
function buildEgressNotification(kind, data = {}) {
  if (kind === 'unreachable') {
    return { kind, title: '测不到出口 IP', body: '已连续 3 次检测失败，检查网络或代理' }
  }
  return {
    kind: 'changed',
    title: '出口 IP 变了',
    // 全角括号自带留白，括号后直接接箭头；没有归属地时箭头两侧空一格
    body: `${data.fromIp}${bracketLocation(data.fromLocation) || ' '}→ ${data.toIp}${bracketLocation(data.toLocation)}`,
  }
}

/* ============================================================
   按需检测 / 持续监控
   ============================================================ */

const CONTINUOUS_MONITORING_STORE_KEY = 'networkDiagnostics.continuousMonitoring'
const LAST_RESULT_STORE_KEY = 'networkDiagnostics.lastResult'
const CHANGE_LOG_STORE_KEY = 'networkDiagnostics.changeLog'
const HAS_COMPARED_STORE_KEY = 'networkDiagnostics.hasCompared'
const BACKGROUND_INTERVAL_MS = 60000  // 页面关闭后 60 秒
const FOREGROUND_INTERVAL_MS = 5000   // 页面打开时 5 秒
const CHANGE_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CHANGE_LOG_MAX_ENTRIES = 200
const UNREACHABLE_NOTIFY_THRESHOLD = 3

/** 只留近 7 天、最多 200 条；新的在前 */
function pruneChangeLog(log, now) {
  if (!Array.isArray(log)) return []
  return log
    .filter((entry) => entry && typeof entry.at === 'number' && entry.at >= now - CHANGE_LOG_RETENTION_MS)
    .slice(0, CHANGE_LOG_MAX_ENTRIES)
}

/** 持久化里的上次结果只接受完整形状，坏数据当作没有 */
function readLastResult(value) {
  if (!value || typeof value.ip !== 'string' || !value.ip || typeof value.checkedAt !== 'number') return null
  return { ip: value.ip, location: value.location || null, checkedAt: value.checkedAt }
}

/**
 * 创建可注入依赖的网络诊断实例
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.probePublicIpFn] - 公网 IP 探测函数
 * @param {() => Promise<object|null>} [deps.lookupLocationFn] - 归属地查询函数
 * @param {{get?: Function, set?: Function}|null} [deps.store] - electron-store 实例
 * @param {() => import('electron').BrowserWindow|null} [deps.getWindow] - 获取主窗口
 * @param {(payload: {kind: string, title: string, body: string}) => void} [deps.notify] - 发系统通知
 * @param {() => boolean} [deps.isWindowFocused] - 主窗口是否在前
 * @param {Function} [deps.setIntervalFn] - 定时器注入
 * @param {Function} [deps.clearIntervalFn] - 清理定时器注入
 * @param {() => number} [deps.nowFn] - 当前时间注入
 * @returns {object}
 */
function createNetworkDiagnosticsService({
  probePublicIpFn = probePublicIp,
  lookupLocationFn = lookupLocation,
  store = null,
  getWindow = () => null,
  notify = () => {},
  isWindowFocused,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  nowFn = Date.now,
} = {}) {
  const windowFocused = isWindowFocused || (() => {
    const win = getWindow?.()
    return Boolean(win && !win.isDestroyed() && win.isFocused())
  })

  let isEnabled = false
  let status = 'idle' // idle | detecting | stable | switched | failed | off
  let lastResult = null
  let changeLog = []
  let hasCompared = false
  let failReason = null
  let consecutiveFailCount = 0
  // 本轮连续失败是否已经通知过：只在第 3 次通知一次，成功后复位
  let unreachableNotified = false
  let intervalId = null
  let sampleIntervalMs = null
  let isForeground = false
  let samplePromise = null

  /** 返回快照，避免 renderer/测试改坏服务内部对象 */
  function getState() {
    return {
      isEnabled,
      status,
      current: lastResult ? { ...lastResult } : null,
      changeLog: pruneChangeLog(changeLog, nowFn()).map((entry) => ({ ...entry })),
      hasCompared,
      failReason,
      consecutiveFailCount,
    }
  }

  /** 将当前快照推给 renderer；窗口不可用时不影响服务 */
  function emitState() {
    try {
      const mainWindow = getWindow?.()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('network:ipStateUpdate', getState())
      }
    } catch {
      // 窗口不可用时静默，后台监控继续
    }
  }

  /** 写持久化；失败只影响下次启动，不打断检测 */
  function persist(key, value) {
    try {
      store?.set?.(key, value)
    } catch (error) {
      console.warn('[network] persist failed:', key, error?.message || error)
    }
  }

  /** 停在本页且窗口在前：页面自己会显示，不再弹系统通知 */
  function shouldNotify() {
    if (!isEnabled) return false
    try {
      return !(isForeground && windowFocused())
    } catch {
      return true
    }
  }

  function sendNotification(kind, data) {
    if (!shouldNotify()) return
    try {
      notify(buildEgressNotification(kind, data))
    } catch (error) {
      console.warn('[network] notify failed:', error?.message || error)
    }
  }

  /** 清理现有 interval，并同步公开的当前频率 */
  function clearSchedule() {
    if (intervalId !== null) {
      clearIntervalFn(intervalId)
      intervalId = null
    }
    sampleIntervalMs = null
  }

  /** 仅在用户已开启持续监控时建立唯一 interval */
  function restartSchedule() {
    clearSchedule()
    if (!isEnabled) return
    sampleIntervalMs = isForeground ? FOREGROUND_INTERVAL_MS : BACKGROUND_INTERVAL_MS
    // 返回 promise 便于测试等待一次采样完成；定时器本身忽略返回值
    intervalId = setIntervalFn(() => runSample({ allowWhenDisabled: false }).catch(() => {}), sampleIntervalMs)
  }

  /**
   * 归属地：第一次拿到 IP、IP 变了、或上次没查到时才查
   * @param {string} ip
   * @param {object|null} previous
   */
  async function resolveLocation(ip, previous) {
    if (previous && previous.ip === ip && previous.location) return previous.location
    try {
      return (await lookupLocationFn(ip)) || null
    } catch {
      return null
    }
  }

  /**
   * 处理一次成功采样：比对上次结果、写记录、决定通知
   * @param {string} ip
   * @param {boolean} enabledAtStart - 发起时监控是否开着（区分手动发现）
   */
  async function handleSuccess(ip, enabledAtStart) {
    const previous = lastResult
    const location = await resolveLocation(ip, previous)
    const now = nowFn()
    const changed = Boolean(previous && previous.ip !== ip)

    lastResult = { ip, location, checkedAt: now }
    persist(LAST_RESULT_STORE_KEY, lastResult)

    if (previous && !hasCompared) {
      hasCompared = true
      persist(HAS_COMPARED_STORE_KEY, true)
    }

    consecutiveFailCount = 0
    unreachableNotified = false
    failReason = null
    status = changed ? 'switched' : 'stable'

    if (changed) {
      const entry = {
        at: now,
        fromIp: previous.ip,
        toIp: ip,
        fromLocation: previous.location || null,
        toLocation: location,
        foundByManual: !enabledAtStart,
      }
      changeLog = pruneChangeLog([entry, ...changeLog], now)
      persist(CHANGE_LOG_STORE_KEY, changeLog)
      sendNotification('changed', entry)
    }
  }

  /** 处理一次失败采样：保留上次结果，只在第 3 次连续失败时通知 */
  function handleFailure(error) {
    consecutiveFailCount += 1
    failReason = String(error || '').startsWith('REQUEST_TIMEOUT_') ? 'timeout' : 'other'
    status = 'failed'
    if (consecutiveFailCount >= UNREACHABLE_NOTIFY_THRESHOLD && !unreachableNotified) {
      unreachableNotified = true
      sendNotification('unreachable')
    }
  }

  /**
   * 执行一次采样；同一时刻只允许一个请求在飞
   * @param {{allowWhenDisabled: boolean}} options
   * @returns {Promise<object>}
   */
  async function runSample({ allowWhenDisabled }) {
    if (!isEnabled && !allowWhenDisabled) return getState()
    if (samplePromise) return samplePromise

    const startedWhileEnabled = isEnabled
    status = 'detecting'
    emitState()

    samplePromise = (async () => {
      let result
      try {
        result = await probePublicIpFn()
      } catch (error) {
        result = { success: false, ip: null, source: null, error: error?.message || 'IP_PROBE_FAILED' }
      }

      if (result?.success && result.ip) {
        await handleSuccess(result.ip, startedWhileEnabled)
      } else {
        handleFailure(result?.error)
      }

      // 请求发出时开关为开、完成前被关闭：结果保留，但状态不能从 off 反弹为 stable/failed
      if (startedWhileEnabled && !isEnabled) {
        status = lastResult ? 'off' : 'idle'
      }
      emitState()
      return getState()
    })()

    try {
      return await samplePromise
    } finally {
      samplePromise = null
    }
  }

  /** 读持久化并按开关决定是否恢复监控；默认或读取失败均为关闭 */
  function initialize() {
    const read = (key, fallback) => {
      try {
        return store?.get?.(key, fallback) ?? fallback
      } catch {
        return fallback
      }
    }
    lastResult = readLastResult(read(LAST_RESULT_STORE_KEY, null))
    changeLog = pruneChangeLog(read(CHANGE_LOG_STORE_KEY, []), nowFn())
    hasCompared = read(HAS_COMPARED_STORE_KEY, false) === true
    isEnabled = read(CONTINUOUS_MONITORING_STORE_KEY, false) === true
    failReason = null
    consecutiveFailCount = 0
    unreachableNotified = false
    status = isEnabled ? 'detecting' : (lastResult ? 'off' : 'idle')

    if (isEnabled) {
      runSample({ allowWhenDisabled: false }).catch(() => {})
      restartSchedule()
    }
    return getState()
  }

  /** 单次检测：无论持续监控是否开启，都只复用本次请求，不创建新 timer */
  function probeIpOnce() {
    return runSample({ allowWhenDisabled: true })
  }

  /** 页面打开/关闭只改变已开启持续监控的频率，绝不改变开关 */
  function setForeground(foreground) {
    const nextForeground = Boolean(foreground)
    if (nextForeground !== isForeground) {
      isForeground = nextForeground
      restartSchedule()
      emitState()
    }
    return getState()
  }

  /** 用户明确开启/关闭持续监控，并同步持久化；写入失败抛错且状态不变 */
  function setContinuousMonitoring(enabled) {
    const nextEnabled = Boolean(enabled)
    try {
      store?.set?.(CONTINUOUS_MONITORING_STORE_KEY, nextEnabled)
    } catch (error) {
      const persistError = new Error(error?.message || 'PREFERENCE_WRITE_FAILED')
      persistError.code = 'PREFERENCE_WRITE_FAILED'
      throw persistError
    }

    isEnabled = nextEnabled
    // 「连续失败」只算本轮监控期间的：开关一动就重新计数，关着时手动失败不带进来
    consecutiveFailCount = 0
    unreachableNotified = false
    if (nextEnabled) {
      status = 'detecting'
      runSample({ allowWhenDisabled: false }).catch(() => {})
      restartSchedule()
    } else {
      clearSchedule()
      status = lastResult ? 'off' : 'idle'
      emitState()
    }
    return getState()
  }

  /** 释放 interval，供应用退出和测试清理 */
  function dispose() {
    clearSchedule()
  }

  return {
    initialize,
    getState,
    probeIpOnce,
    setForeground,
    setContinuousMonitoring,
    dispose,
  }
}

/** 默认实例：由 main 注入 electron-store、窗口引用与通知 */
let defaultIpService = createNetworkDiagnosticsService()

function initializeIpMonitor({ store, getWindow, notify }) {
  defaultIpService.dispose()
  defaultIpService = createNetworkDiagnosticsService({ store, getWindow, notify })
  return defaultIpService.initialize()
}

function getIpMonitorState() {
  return defaultIpService.getState()
}

function probeIpOnce() {
  return defaultIpService.probeIpOnce()
}

function setIpMonitorFastMode(fast) {
  return defaultIpService.setForeground(fast)
}

function toggleIpMonitor(enabled) {
  return defaultIpService.setContinuousMonitoring(enabled)
}

module.exports = {
  probePublicIp,
  lookupLocation,
  buildEgressNotification,
  createNetworkDiagnosticsService,
  initializeIpMonitor,
  getIpMonitorState,
  probeIpOnce,
  setIpMonitorFastMode,
  toggleIpMonitor,
  CONTINUOUS_MONITORING_STORE_KEY,
  BACKGROUND_INTERVAL_MS,
  FOREGROUND_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
}
