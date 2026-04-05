/**
 * 网络诊断服务
 *
 * 负责：
 * - 获取公网 IPv4（双源降级：ipify → icanhazip）
 * - DNS 解析测速
 * - TLS 握手测速
 * - HTTP 可达性检测
 * - 端点三段式完整探测（DNS → TLS → HTTP）
 *
 * 从 scripts/network/runVpnDiagnosticsDemo.js 提取核心函数，
 * 去除 CLI 相关逻辑，供 IPC Handler 调用。
 *
 * @module electron/services/networkDiagnosticsService
 */

const dns = require('dns').promises
const https = require('https')
const tls = require('tls')
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
 * API 端点探测配置
 * expectedStatuses 中的状态码均视为"可达"（握手成功，不验证凭证）
 */
const ENDPOINT_PROBES = [
  {
    id: 'openai-api',
    label: 'OpenAI',
    host: 'api.openai.com',
    method: 'GET',
    path: '/v1/models',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CodePal-Network-Diagnostics/1.0',
    },
    expectedStatuses: new Set([200, 401, 403]),
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic',
    host: 'api.anthropic.com',
    method: 'HEAD',
    path: '/v1/messages',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CodePal-Network-Diagnostics/1.0',
    },
    expectedStatuses: new Set([200, 401, 403, 405]),
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

/**
 * 测量 DNS 查询耗时
 * @param {string} host
 * @returns {Promise<{success: boolean, address: string|null, family: number|null, durationMs: number|null, error: string|null}>}
 */
async function probeDns(host) {
  const startedAt = performance.now()
  try {
    const result = await dns.lookup(host)
    return { success: true, address: result.address, family: result.family, durationMs: performance.now() - startedAt, error: null }
  } catch (error) {
    return { success: false, address: null, family: null, durationMs: performance.now() - startedAt, error: error.message }
  }
}

/**
 * 测量 TLS 握手耗时
 * @param {string} host
 * @param {number} [port=443]
 * @returns {Promise<{success: boolean, protocol: string|null, cipher: string|null, durationMs: number|null, error: string|null}>}
 */
function probeTls(host, port = 443) {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    let settled = false
    const socket = tls.connect({ host, port, servername: host, timeout: REQUEST_TIMEOUT_MS, rejectUnauthorized: true })

    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.on('secureConnect', () => {
      finish({ success: true, protocol: socket.getProtocol() || null, cipher: socket.getCipher()?.name || null, durationMs: performance.now() - startedAt, error: null })
    })
    socket.on('timeout', () => {
      finish({ success: false, protocol: null, cipher: null, durationMs: performance.now() - startedAt, error: `TLS_TIMEOUT_${REQUEST_TIMEOUT_MS}MS` })
    })
    socket.on('error', (error) => {
      finish({ success: false, protocol: null, cipher: null, durationMs: performance.now() - startedAt, error: error.message })
    })
  })
}

/**
 * 测量 API 端点 HTTP 可达性
 * @param {Object} probe - 端点配置
 * @returns {Promise<{success: boolean, statusCode: number|null, durationMs: number|null, error: string|null}>}
 */
async function probeHttp(probe) {
  try {
    const response = await requestText({
      url: `https://${probe.host}${probe.path}`,
      method: probe.method,
      headers: probe.headers,
    })
    return {
      success: response.statusCode !== null && probe.expectedStatuses.has(response.statusCode),
      statusCode: response.statusCode,
      durationMs: response.durationMs,
      error: null,
    }
  } catch (error) {
    return { success: false, statusCode: null, durationMs: null, error: error.message }
  }
}

/**
 * 执行单个端点的三段式探测（DNS → TLS → HTTP）
 * @param {Object} probe - 端点配置
 * @returns {Promise<{id: string, label: string, host: string, dns: Object, tls: Object, http: Object, reachable: boolean}>}
 */
async function probeEndpoint(probe) {
  const failStub = { success: false, durationMs: null, error: null }
  const dnsResult = await probeDns(probe.host)

  // DNS 失败时短路，不浪费时间执行后续探测
  if (!dnsResult.success) {
    return {
      id: probe.id, label: probe.label, host: probe.host,
      dns: dnsResult,
      tls: { ...failStub, protocol: null, cipher: null },
      http: { ...failStub, statusCode: null },
      reachable: false,
    }
  }

  const tlsResult = await probeTls(probe.host)

  // TLS 失败时短路
  if (!tlsResult.success) {
    return {
      id: probe.id, label: probe.label, host: probe.host,
      dns: dnsResult, tls: tlsResult,
      http: { ...failStub, statusCode: null },
      reachable: false,
    }
  }

  const httpResult = await probeHttp(probe)

  return {
    id: probe.id, label: probe.label, host: probe.host,
    dns: dnsResult, tls: tlsResult, http: httpResult,
    reachable: httpResult.success,
  }
}

/**
 * 并行检测所有配置的 API 端点
 * @returns {Promise<Array<{id, label, host, dns, tls, http, reachable}>>}
 */
async function probeAllEndpoints() {
  return Promise.all(ENDPOINT_PROBES.map((probe) => probeEndpoint(probe)))
}

/* ============================================================
   IP 监控后台常驻服务
   应用启动即运行，主进程维护状态，渲染进程只读
   ============================================================ */

const BACKGROUND_INTERVAL_MS = 30000  // 后台 30 秒
const FOREGROUND_INTERVAL_MS = 5000   // 页面打开时 5 秒
const MAX_TIMELINE_POINTS = 30
const ROUND_DURATION_MS = 30 * 60 * 1000

/** 单例状态 */
let monitorState = createInitialState()
let intervalId = null
let currentIntervalMs = BACKGROUND_INTERVAL_MS
let getMainWindowFn = null  // 延迟获取 mainWindow 的函数

function createInitialState() {
  return {
    isEnabled: true,
    status: 'detecting',  // detecting | stable | switched | failed | off
    currentIp: null,
    currentSource: null,
    previousIp: null,
    sampleCount: 0,
    uniqueIps: [],
    switchCount: 0,
    timeline: [],
    consecutiveFailCount: 0,
    successCount: 0,
    roundStartTime: null,
  }
}

/**
 * 处理一次采样结果，更新 monitorState
 * @param {{success: boolean, ip: string|null, source: string|null}} result
 */
function handleSampleResult(result) {
  // 先检查 30 分钟轮次是否到期，到期则重置再写入新数据
  if (monitorState.roundStartTime && Date.now() - monitorState.roundStartTime >= ROUND_DURATION_MS) {
    monitorState.sampleCount = 0
    monitorState.switchCount = 0
    monitorState.uniqueIps = monitorState.currentIp ? [monitorState.currentIp] : []
    monitorState.timeline = []
    monitorState.consecutiveFailCount = 0
    monitorState.successCount = 0
    monitorState.roundStartTime = Date.now()
  }

  if (result.success && result.ip) {
    const isFirstSample = monitorState.currentIp === null
    const isSwitched = !isFirstSample && result.ip !== monitorState.currentIp

    if (!monitorState.uniqueIps.includes(result.ip)) {
      monitorState.uniqueIps.push(result.ip)
    }

    monitorState.previousIp = isFirstSample ? null : monitorState.currentIp
    monitorState.currentIp = result.ip
    monitorState.currentSource = result.source
    monitorState.sampleCount += 1
    monitorState.successCount += 1
    monitorState.consecutiveFailCount = 0
    monitorState.switchCount += isSwitched ? 1 : 0
    monitorState.status = isSwitched ? 'switched' : 'stable'
    monitorState.timeline.push({ type: isSwitched ? 'switch' : 'stable', ip: result.ip, timestamp: Date.now() })
    if (!monitorState.roundStartTime) monitorState.roundStartTime = Date.now()
  } else {
    monitorState.sampleCount += 1
    monitorState.consecutiveFailCount += 1
    monitorState.status = 'failed'
    monitorState.timeline.push({ type: 'fail', ip: null, timestamp: Date.now() })
    if (!monitorState.roundStartTime) monitorState.roundStartTime = Date.now()
  }

  // 时间线最多保留 MAX_TIMELINE_POINTS
  if (monitorState.timeline.length > MAX_TIMELINE_POINTS) {
    monitorState.timeline = monitorState.timeline.slice(-MAX_TIMELINE_POINTS)
  }
}

/** 执行一次采样并推送给渲染进程 */
async function doSample() {
  if (!monitorState.isEnabled) return

  const result = await probePublicIp()
  const previousIp = monitorState.currentIp
  handleSampleResult(result)

  // 推送状态更新给渲染进程
  try {
    const mainWindow = getMainWindowFn?.()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('network:ipStateUpdate', monitorState)
    }
  } catch {
    // 窗口不可用时静默
  }
}

/** 启动/重启定时器 */
function restartInterval(intervalMs) {
  clearInterval(intervalId)
  currentIntervalMs = intervalMs
  intervalId = setInterval(doSample, intervalMs)
}

/**
 * 启动 IP 监控（应用启动时调用一次）
 * @param {() => import('electron').BrowserWindow|null} getWindow - 获取主窗口的函数
 */
function startIpMonitor(getWindow) {
  getMainWindowFn = getWindow
  doSample().catch(() => {})  // 首次采样，异常由 handleSampleResult 处理
  restartInterval(BACKGROUND_INTERVAL_MS)
}

/**
 * 获取当前监控状态（页面打开时拉取）
 * @returns {Object}
 */
function getIpMonitorState() {
  return { ...monitorState }
}

/**
 * 页面打开时切换到快速采样模式
 * @param {boolean} fast - true=5秒 false=30秒
 */
function setIpMonitorFastMode(fast) {
  const targetMs = fast ? FOREGROUND_INTERVAL_MS : BACKGROUND_INTERVAL_MS
  if (targetMs !== currentIntervalMs) {
    restartInterval(targetMs)
  }
}

/**
 * 暂停/恢复 IP 监控
 * @param {boolean} enabled
 */
function toggleIpMonitor(enabled) {
  if (enabled) {
    monitorState = createInitialState()
    doSample().catch(() => {})
    restartInterval(currentIntervalMs)
  } else {
    monitorState.isEnabled = false
    monitorState.status = 'off'
    clearInterval(intervalId)
  }
}

module.exports = {
  probePublicIp,
  probeAllEndpoints,
  startIpMonitor,
  getIpMonitorState,
  setIpMonitorFastMode,
  toggleIpMonitor,
  REQUEST_TIMEOUT_MS,
  ENDPOINT_PROBES,
}
