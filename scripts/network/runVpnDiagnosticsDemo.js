/**
 * VPN 稳定度检测 Demo 脚本
 *
 * 负责：
 * - 定时采样公网 IPv4，判断出口是否发生切换
 * - 检测 OpenAI / Anthropic API 的 DNS、TLS、HTTP 连通性
 * - 聚合每轮结果，输出可读的稳定度结论
 *
 * @module scripts/network/runVpnDiagnosticsDemo
 */

const dns = require('dns').promises
const https = require('https')
const tls = require('tls')
const { performance } = require('perf_hooks')

const DEFAULT_DURATION_SECONDS = 30
const DEFAULT_INTERVAL_SECONDS = 5
const REQUEST_TIMEOUT_MS = 6000

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

const ENDPOINT_PROBES = [
  {
    id: 'openai-api',
    label: 'OpenAI API',
    host: 'api.openai.com',
    method: 'GET',
    path: '/v1/models',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CodePal-VPN-Diagnostics-Demo/1.0',
    },
    expectedStatuses: new Set([200, 401, 403]),
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic API',
    host: 'api.anthropic.com',
    method: 'HEAD',
    path: '/v1/messages',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CodePal-VPN-Diagnostics-Demo/1.0',
    },
    expectedStatuses: new Set([200, 401, 403, 405]),
  },
]

/**
 * 解析命令行参数
 * @param {string[]} argv - 传入参数
 * @returns {{durationSeconds: number, intervalSeconds: number}}
 */
function parseArgs(argv) {
  const options = {
    durationSeconds: DEFAULT_DURATION_SECONDS,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  }

  for (const arg of argv) {
    if (arg.startsWith('--duration=')) {
      options.durationSeconds = clampPositiveInteger(arg.split('=')[1], DEFAULT_DURATION_SECONDS)
    }
    if (arg.startsWith('--interval=')) {
      options.intervalSeconds = clampPositiveInteger(arg.split('=')[1], DEFAULT_INTERVAL_SECONDS)
    }
  }

  if (options.intervalSeconds > options.durationSeconds) {
    options.intervalSeconds = options.durationSeconds
  }

  return options
}

/**
 * 将输入归一为正整数
 * @param {string} value - 待解析值
 * @param {number} fallbackValue - 兜底值
 * @returns {number}
 */
function clampPositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue
}

/**
 * 延迟指定毫秒
 * @param {number} ms - 延迟时长
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 规范化公网 IP 文本
 * @param {string} value - 原始文本
 * @returns {string}
 */
function normalizeIpValue(value) {
  return String(value || '').trim()
}

/**
 * 发起 HTTPS 请求并返回完整响应
 * @param {Object} options - 请求配置
 * @param {string} options.url - 完整 URL
 * @param {string} [options.method='GET'] - HTTP 方法
 * @param {Record<string, string>} [options.headers={}] - 请求头
 * @param {number} [options.timeoutMs=REQUEST_TIMEOUT_MS] - 超时时间
 * @returns {Promise<{statusCode: number|null, headers: Record<string, string|string[]|undefined>, body: string, durationMs: number}>}
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
          headers: response.headers,
          body: chunks.join(''),
          durationMs: performance.now() - startedAt,
        })
      })
    })

    request.setTimeout(timeoutMs, () => {
      // 主动销毁连接，让调用方拿到明确的超时错误。
      request.destroy(new Error(`REQUEST_TIMEOUT_${timeoutMs}MS`))
    })

    request.on('error', (error) => {
      reject(error)
    })

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
          'User-Agent': 'CodePal-VPN-Diagnostics-Demo/1.0',
        },
      })
      const ip = source.parseResponseBody(response.body)

      if (ip) {
        return {
          success: true,
          ip,
          source: source.name,
          durationMs: performance.now() - startedAt,
          error: null,
        }
      }
    } catch (error) {
      // 回退到下一个出口服务，避免单点服务抖动导致误判。
      if (source === IP_SOURCES[IP_SOURCES.length - 1]) {
        return {
          success: false,
          ip: null,
          source: source.name,
          durationMs: performance.now() - startedAt,
          error: error.message,
        }
      }
    }
  }

  return { success: false, ip: null, source: null, durationMs: null, error: 'NO_IP_SOURCE_AVAILABLE' }
}

/**
 * 测量 DNS 查询耗时
 * @param {string} host - 域名
 * @returns {Promise<{success: boolean, address: string|null, family: number|null, durationMs: number|null, error: string|null}>}
 */
async function probeDns(host) {
  const startedAt = performance.now()

  try {
    const result = await dns.lookup(host)
    return {
      success: true,
      address: result.address,
      family: result.family,
      durationMs: performance.now() - startedAt,
      error: null,
    }
  } catch (error) {
    return {
      success: false,
      address: null,
      family: null,
      durationMs: performance.now() - startedAt,
      error: error.message,
    }
  }
}

/**
 * 测量 TLS 握手耗时
 * @param {string} host - 域名
 * @param {number} [port=443] - 端口
 * @returns {Promise<{success: boolean, protocol: string|null, cipher: string|null, durationMs: number|null, error: string|null}>}
 */
function probeTls(host, port = 443) {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    let settled = false
    const socket = tls.connect({
      host,
      port,
      servername: host,
      timeout: REQUEST_TIMEOUT_MS,
      rejectUnauthorized: true,
    })

    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.on('secureConnect', () => {
      finish({
        success: true,
        protocol: socket.getProtocol() || null,
        cipher: socket.getCipher()?.name || null,
        durationMs: performance.now() - startedAt,
        error: null,
      })
    })

    socket.on('timeout', () => {
      finish({
        success: false,
        protocol: null,
        cipher: null,
        durationMs: performance.now() - startedAt,
        error: `TLS_TIMEOUT_${REQUEST_TIMEOUT_MS}MS`,
      })
    })

    socket.on('error', (error) => {
      finish({
        success: false,
        protocol: null,
        cipher: null,
        durationMs: performance.now() - startedAt,
        error: error.message,
      })
    })
  })
}

/**
 * 测量 API 端点 HTTP 可达性
 * @param {Object} probe - 端点配置
 * @param {string} probe.host - 域名
 * @param {string} probe.method - 方法
 * @param {string} probe.path - 路径
 * @param {Record<string, string>} probe.headers - 请求头
 * @param {Set<number>} probe.expectedStatuses - 预期状态码集合
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
    return {
      success: false,
      statusCode: null,
      durationMs: null,
      error: error.message,
    }
  }
}

/**
 * 执行单个端点的三段式探测
 * @param {Object} probe - 端点配置
 * @returns {Promise<{id: string, label: string, host: string, dns: Object, tls: Object, http: Object, reachable: boolean}>}
 */
async function probeEndpoint(probe) {
  const dnsResult = await probeDns(probe.host)
  const tlsResult = await probeTls(probe.host)
  const httpResult = await probeHttp(probe)

  return {
    id: probe.id,
    label: probe.label,
    host: probe.host,
    dns: dnsResult,
    tls: tlsResult,
    http: httpResult,
    reachable: dnsResult.success && tlsResult.success && httpResult.success,
  }
}

/**
 * 执行一次完整采样
 * @param {number} roundIndex - 当前采样轮次
 * @returns {Promise<{roundIndex: number, sampledAt: string, publicIp: Object, endpointResults: Array}>}
 */
async function runSample(roundIndex) {
  const [publicIp, endpointResults] = await Promise.all([
    probePublicIp(),
    Promise.all(ENDPOINT_PROBES.map((probe) => probeEndpoint(probe))),
  ])

  return {
    roundIndex,
    sampledAt: new Date().toISOString(),
    publicIp,
    endpointResults,
  }
}

/**
 * 统计数组中的均值
 * @param {number[]} values - 数值列表
 * @returns {number|null}
 */
function average(values) {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * 生成摘要报告
 * @param {Array<Object>} samples - 全部采样结果
 * @param {{durationSeconds: number, intervalSeconds: number, startedAt: string, finishedAt: string}} meta - 元信息
 * @returns {Object}
 */
function buildReport(samples, meta) {
  const ipCounts = new Map()
  let ipSuccessCount = 0

  for (const sample of samples) {
    if (sample.publicIp.success && sample.publicIp.ip) {
      ipSuccessCount += 1
      ipCounts.set(sample.publicIp.ip, (ipCounts.get(sample.publicIp.ip) || 0) + 1)
    }
  }

  const endpointSummary = ENDPOINT_PROBES.map((probe) => {
    const rows = samples.map((sample) => sample.endpointResults.find((item) => item.id === probe.id)).filter(Boolean)
    const reachableCount = rows.filter((item) => item.reachable).length
    const dnsDurations = rows.filter((item) => item.dns.durationMs !== null).map((item) => item.dns.durationMs)
    const tlsDurations = rows.filter((item) => item.tls.durationMs !== null).map((item) => item.tls.durationMs)
    const httpDurations = rows.filter((item) => item.http.durationMs !== null).map((item) => item.http.durationMs)
    const lastRow = rows[rows.length - 1] || null

    return {
      id: probe.id,
      label: probe.label,
      host: probe.host,
      reachableCount,
      totalCount: rows.length,
      lastStatusCode: lastRow?.http.statusCode || null,
      averageDnsMs: average(dnsDurations),
      averageTlsMs: average(tlsDurations),
      averageHttpMs: average(httpDurations),
      lastError: lastRow && !lastRow.reachable
        ? lastRow.http.error || lastRow.tls.error || lastRow.dns.error
        : null,
    }
  })

  return {
    meta,
    samples,
    ip: {
      successCount: ipSuccessCount,
      totalCount: samples.length,
      uniqueCount: ipCounts.size,
      counts: Array.from(ipCounts.entries()).map(([ip, count]) => ({ ip, count })),
      stable: ipCounts.size <= 1 && ipSuccessCount > 0,
    },
    endpoints: endpointSummary,
  }
}

/**
 * 生成一句综合结论
 * @param {Object} report - 聚合报告
 * @returns {string}
 */
function buildConclusion(report) {
  const allEndpointsReachable = report.endpoints.every((endpoint) => endpoint.reachableCount === endpoint.totalCount)

  if (report.ip.stable && allEndpointsReachable) {
    return '公网 IP 稳定，OpenAI / Anthropic API 握手均成功，当前未发现短时波动。'
  }

  if (!report.ip.stable && allEndpointsReachable) {
    return 'AI API 端点可达，但公网 IP 发生切换，VPN 出口存在波动。'
  }

  if (report.ip.stable && !allEndpointsReachable) {
    return '公网 IP 没切换，但目标 API 存在失败或超时，更像链路抖动或目标服务偶发问题。'
  }

  return '公网 IP 与 API 端点都出现波动，当前 VPN 稳定性偏弱。'
}

/**
 * 将数值格式化为毫秒字符串
 * @param {number|null} value - 毫秒数
 * @returns {string}
 */
function formatMs(value) {
  return typeof value === 'number' ? `${value.toFixed(0)}ms` : '-'
}

/**
 * 打印最终报告
 * @param {Object} report - 聚合报告
 * @returns {void}
 */
function printReport(report) {
  console.log('\n=== VPN 稳定度检测 Demo 报告 ===')
  console.log(`采样区间: ${report.meta.startedAt} -> ${report.meta.finishedAt}`)
  console.log(`计划时长: ${report.meta.durationSeconds}s, 采样间隔: ${report.meta.intervalSeconds}s, 共 ${report.samples.length} 次采样`)

  console.log('\n[公网 IP]')
  console.log(`成功采样: ${report.ip.successCount}/${report.ip.totalCount}`)
  console.log(`唯一 IP 数量: ${report.ip.uniqueCount}`)
  for (const row of report.ip.counts) {
    console.log(`- ${row.ip}: ${row.count} 次`)
  }
  if (report.ip.counts.length === 0) {
    console.log('- 未获取到公网 IP')
  }
  console.log(`稳定结论: ${report.ip.stable ? '稳定' : '存在切换或采样失败'}`)

  console.log('\n[API 端点]')
  for (const endpoint of report.endpoints) {
    console.log(`- ${endpoint.label} (${endpoint.host})`)
    console.log(`  可达轮次: ${endpoint.reachableCount}/${endpoint.totalCount}`)
    console.log(`  最近状态码: ${endpoint.lastStatusCode || '-'}`)
    console.log(`  平均 DNS: ${formatMs(endpoint.averageDnsMs)}, TLS: ${formatMs(endpoint.averageTlsMs)}, HTTP: ${formatMs(endpoint.averageHttpMs)}`)
    if (endpoint.lastError) {
      console.log(`  最近错误: ${endpoint.lastError}`)
    }
  }

  console.log('\n[综合结论]')
  console.log(buildConclusion(report))
}

/**
 * 主流程
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = new Date()
  const sampleCount = Math.max(1, Math.floor(options.durationSeconds / options.intervalSeconds) + 1)
  const samples = []

  console.log('开始执行 VPN 稳定度检测 Demo...')
  console.log(`目标: 采样 ${sampleCount} 次，每 ${options.intervalSeconds}s 一次，总时长约 ${options.durationSeconds}s`)

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = await runSample(index + 1)
    samples.push(sample)

    const ipText = sample.publicIp.success ? sample.publicIp.ip : `失败(${sample.publicIp.error})`
    const endpointText = sample.endpointResults
      .map((result) => `${result.label}:${result.http.statusCode || result.http.error || 'ERR'}`)
      .join(' | ')

    console.log(`[${sample.roundIndex}/${sampleCount}] ${sample.sampledAt} | IP=${ipText} | ${endpointText}`)

    // 最后一轮不再等待，避免报告前多停一次。
    if (index < sampleCount - 1) {
      await delay(options.intervalSeconds * 1000)
    }
  }

  const finishedAt = new Date()
  const report = buildReport(samples, {
    durationSeconds: options.durationSeconds,
    intervalSeconds: options.intervalSeconds,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  })

  printReport(report)
}

main().catch((error) => {
  console.error('\nVPN 稳定度检测 Demo 执行失败:')
  console.error(error)
  process.exitCode = 1
})
