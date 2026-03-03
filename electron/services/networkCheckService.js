/**
 * 网络环境诊断服务
 *
 * 负责：
 * - 检测 macOS 系统代理配置（scutil）
 * - 检测 TUN 接口与分流路由（ifconfig / netstat）
 * - 对比直连与代理的出口国家（curl ifconfig.co）
 * - 探测 Anthropic API 可达性（curl api.anthropic.com）
 * - 扫描 Claude Code 最近日志中的 403 记录
 *
 * 所有检查函数返回统一结构 { name, status, detail }，
 * runAllChecks 编排并汇总为 { overall, passCount, warnCount, failCount, checks }。
 *
 * @module electron/services/networkCheckService
 */

const { exec } = require('child_process')
const fs = require('fs/promises')
const path = require('path')
const os = require('os')

/** 单项 curl 超时（秒），与原脚本保持一致 */
const CURL_TIMEOUT = 8

// ─── 工具函数 ──────────────────────────────────────────

/**
 * 包装 exec 为 Promise
 * @param {string} command - 要执行的命令
 * @param {number} [timeout=15000] - 超时毫秒数
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execAsync(command, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '' })
      }
    })
  })
}

/**
 * 从 scutil --proxy 输出中提取指定 key 的值
 * @param {string} scutilOutput - scutil --proxy 完整输出
 * @param {string} key - 字典 key（如 "HTTPEnable"）
 * @returns {string} 值字符串，未找到返回空字符串
 */
function scutilKey(scutilOutput, key) {
  const regex = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm')
  const match = scutilOutput.match(regex)
  return match ? match[1].trim() : ''
}

/**
 * 从 scutil --proxy 输出中探测可用的代理地址
 *
 * 优先级：HTTP > HTTPS > fallback 127.0.0.1:7897
 *
 * @param {string} scutilOutput - scutil --proxy 完整输出
 * @returns {string} 代理 URL，如 "http://127.0.0.1:7897"
 */
function detectProxyUrl(scutilOutput) {
  let host = scutilKey(scutilOutput, 'HTTPProxy')
  let port = scutilKey(scutilOutput, 'HTTPPort')

  if (!host || !port) {
    host = scutilKey(scutilOutput, 'HTTPSProxy')
    port = scutilKey(scutilOutput, 'HTTPSPort')
  }

  if (!host || !port) {
    host = '127.0.0.1'
    port = '7897'
  }

  return `http://${host}:${port}`
}

// ─── 5 项检查 ──────────────────────────────────────────

/**
 * 检查 macOS 系统代理配置
 *
 * 判定规则：HTTP + HTTPS 都开启 → PASS，否则 → WARN
 *
 * @returns {Promise<{check: {name: string, status: string, detail: string}, proxyUrl: string}>}
 */
async function checkSystemProxy() {
  const name = '系统代理'
  try {
    const { stdout } = await execAsync('scutil --proxy')
    const httpEnable = scutilKey(stdout, 'HTTPEnable')
    const httpsEnable = scutilKey(stdout, 'HTTPSEnable')
    const proxyUrl = detectProxyUrl(stdout)

    if (httpEnable === '1' && httpsEnable === '1') {
      return {
        check: { name, status: 'pass', detail: 'HTTP + HTTPS 代理已开启' },
        proxyUrl,
      }
    }
    return {
      check: { name, status: 'warn', detail: 'HTTP/HTTPS 代理未完全开启' },
      proxyUrl,
    }
  } catch {
    return {
      check: { name, status: 'fail', detail: '无法读取系统代理配置' },
      proxyUrl: 'http://127.0.0.1:7897',
    }
  }
}

/**
 * 检查 TUN 接口与分流路由
 *
 * 判定规则：
 * - utun 接口不存在 → FAIL
 * - utun 存在但 1/128.0 路由不全在 utun 上 → WARN
 * - 都正常 → PASS
 *
 * @returns {Promise<{name: string, status: string, detail: string}>}
 */
async function checkTunRoute() {
  const name = 'TUN 路由'
  try {
    const [ifconfigResult, netstatResult] = await Promise.all([
      execAsync('ifconfig'),
      execAsync('netstat -rn -f inet'),
    ])

    // 统计 utun 接口数量
    const utunMatches = ifconfigResult.stdout.match(/^utun\d+:/gm)
    const utunCount = utunMatches ? utunMatches.length : 0

    if (utunCount === 0) {
      return { name, status: 'fail', detail: '未检测到 utun 接口（TUN 可能未启动）' }
    }

    // 检查分流路由：1 和 128.0/1 是否在 utun 上
    const lines = netstatResult.stdout.split('\n')
    const route1 = lines.find(l => /^\s*1\s/.test(l) && /utun/.test(l))
    const route128 = lines.find(l => /128\.0\/1/.test(l) && /utun/.test(l))

    if (route1 && route128) {
      return { name, status: 'pass', detail: `utun 接口正常（${utunCount} 个），分流路由已配置` }
    }
    return { name, status: 'warn', detail: `utun 接口存在（${utunCount} 个），但分流路由不完整` }
  } catch {
    return { name, status: 'fail', detail: '无法检测 TUN 和路由状态' }
  }
}

/**
 * 对比直连与代理的出口国家
 *
 * 判定规则：
 * - 两者一致 → PASS
 * - 不一致 → WARN（可能旁路泄露）
 * - 无法获取 → WARN
 *
 * @param {string} proxyUrl - 代理地址
 * @returns {Promise<{name: string, status: string, detail: string}>}
 */
async function checkEgressCountry(proxyUrl) {
  const name = '出口国家'
  try {
    const [directResult, proxyResult] = await Promise.allSettled([
      execAsync(`curl --max-time ${CURL_TIMEOUT} -s https://ifconfig.co/country-iso`),
      execAsync(`curl --max-time ${CURL_TIMEOUT} -s -x "${proxyUrl}" https://ifconfig.co/country-iso`),
    ])

    const directCountry = directResult.status === 'fulfilled'
      ? directResult.value.stdout.trim().replace(/\s/g, '')
      : ''
    const proxyCountry = proxyResult.status === 'fulfilled'
      ? proxyResult.value.stdout.trim().replace(/\s/g, '')
      : ''

    if (!directCountry && !proxyCountry) {
      return { name, status: 'warn', detail: '无法获取出口国家信息' }
    }

    if (directCountry && proxyCountry && directCountry === proxyCountry) {
      return { name, status: 'pass', detail: `直连与代理出口一致（${directCountry}）` }
    }

    if (directCountry && proxyCountry) {
      return { name, status: 'warn', detail: `直连 ${directCountry} / 代理 ${proxyCountry}，出口不一致` }
    }

    // 只拿到一边
    const known = directCountry || proxyCountry
    return { name, status: 'warn', detail: `仅获取到部分出口信息（${known}）` }
  } catch {
    return { name, status: 'warn', detail: '出口国家检测异常' }
  }
}

/**
 * 探测 Anthropic API 可达性
 *
 * 判定规则：
 * - 直连+代理都返回 401（未认证但可达） → PASS
 * - 直连 403 但代理 401 → FAIL（Claude 可能绕过了代理）
 * - 有超时/无响应 → FAIL
 * - 其他情况 → WARN
 *
 * @param {string} proxyUrl - 代理地址
 * @returns {Promise<{name: string, status: string, detail: string}>}
 */
async function checkAnthropicReachability(proxyUrl) {
  const name = 'API 连通'
  try {
    const curlFlags = `--max-time ${CURL_TIMEOUT} -s -o /dev/null -w '%{http_code}'`
    const target = 'https://api.anthropic.com/api/oauth/profile'

    const [directResult, proxyResult] = await Promise.allSettled([
      execAsync(`curl ${curlFlags} ${target}`),
      execAsync(`curl ${curlFlags} -x "${proxyUrl}" ${target}`),
    ])

    const directCode = directResult.status === 'fulfilled'
      ? directResult.value.stdout.trim().replace(/\s/g, '')
      : '000'
    const proxyCode = proxyResult.status === 'fulfilled'
      ? proxyResult.value.stdout.trim().replace(/\s/g, '')
      : '000'

    if (directCode === '401' && proxyCode === '401') {
      return { name, status: 'pass', detail: '直连与代理均可达（401 未认证属正常）' }
    }

    if (directCode === '403' && proxyCode === '401') {
      return { name, status: 'fail', detail: '直连被封（403）但代理正常，Claude 可能绕过了代理' }
    }

    if (directCode === '000' || proxyCode === '000') {
      return { name, status: 'fail', detail: `网络探测超时/失败（直连=${directCode}，代理=${proxyCode}）` }
    }

    return { name, status: 'warn', detail: `非预期状态码（直连=${directCode}，代理=${proxyCode}）` }
  } catch {
    return { name, status: 'fail', detail: 'API 可达性检测异常' }
  }
}

/**
 * 扫描 Claude Code 最近 debug 日志中的 403/forbidden 记录
 *
 * 判定规则：
 * - 日志文件不存在 → WARN
 * - 最近 500 行无 forbidden → PASS
 * - 有 forbidden → WARN
 *
 * @returns {Promise<{name: string, status: string, detail: string}>}
 */
async function checkRecentLogs() {
  const name = '403 监测'
  const latestLink = path.join(os.homedir(), '.claude', 'debug', 'latest')

  try {
    // 读取 symlink 指向的实际日志路径
    const realPath = await fs.realpath(latestLink)
    const content = await fs.readFile(realPath, 'utf-8')
    const lines = content.split('\n')
    const tail500 = lines.slice(-500)

    // 统计 403 相关模式
    const forbiddenPattern = /Request not allowed|status=403|\{"type":"forbidden"/i
    const count = tail500.filter(line => forbiddenPattern.test(line)).length

    if (count > 0) {
      return { name, status: 'warn', detail: `最近日志发现 ${count} 条 forbidden 记录` }
    }
    return { name, status: 'pass', detail: '最近日志无 forbidden 记录' }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { name, status: 'warn', detail: '未找到 Claude debug 日志' }
    }
    return { name, status: 'warn', detail: `日志读取失败: ${error.message}` }
  }
}

// ─── 编排 ──────────────────────────────────────────────

/**
 * 执行全部 5 项网络诊断
 *
 * 执行步骤：
 * 1. 先跑 checkSystemProxy 拿到 proxyUrl
 * 2. 并行跑剩余 4 项（其中 2 项依赖 proxyUrl）
 * 3. 汇总 overall / passCount / warnCount / failCount
 *
 * @returns {Promise<{overall: string, passCount: number, warnCount: number, failCount: number, checks: Array<{name: string, status: string, detail: string}>}>}
 */
async function runAllChecks() {
  // 先跑系统代理检查，获取 proxyUrl 供后续使用
  const proxyResult = await checkSystemProxy()
  const { proxyUrl } = proxyResult

  // 并行执行剩余 4 项
  const [tunResult, countryResult, apiResult, logResult] = await Promise.all([
    checkTunRoute(),
    checkEgressCountry(proxyUrl),
    checkAnthropicReachability(proxyUrl),
    checkRecentLogs(),
  ])

  const checks = [
    proxyResult.check,
    tunResult,
    countryResult,
    apiResult,
    logResult,
  ]

  let passCount = 0
  let warnCount = 0
  let failCount = 0

  for (const c of checks) {
    if (c.status === 'pass') passCount++
    else if (c.status === 'warn') warnCount++
    else if (c.status === 'fail') failCount++
  }

  let overall = 'pass'
  if (failCount > 0) overall = 'fail'
  else if (warnCount > 0) overall = 'warn'

  return { overall, passCount, warnCount, failCount, checks }
}

module.exports = { runAllChecks }
