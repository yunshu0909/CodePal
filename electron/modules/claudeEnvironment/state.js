/** Domain state: current evidence, historical evidence and missing evidence stay distinct. */
const net = require('net')
const STALE_MS = 10 * 60 * 1000
const IDS = ['egress', 'dns', 'proxy', 'launcher', 'entry']
const TITLES = { egress: '出口网络', dns: 'DNS 解析器', proxy: '专用代理', launcher: '启动器固定 IP', entry: '启动入口' }
const HINTS = {
  egress: '从 Claude 专用受限环境探测，不是日常浏览器的出口。',
  dns: '只查专用解析路径；代理未运行时不回退系统 DNS。解析器和 HTTP 地址不同不表示泄漏。',
  proxy: '仅检查现有专用代理，不启动、停止代理或切换节点。',
  launcher: '地址与启动器登记值不同时，新会话可能被启动检查拦住；本模块不修改固定地址。',
  entry: '只核对普通 claude 入口及本轮受限进程。旧会话、IDE、其他副本和外部应用未验证。',
}
const LABELS = {
  healthy: ['出口正常', 'green'], first: ['未检测', 'gray'], proxy: ['代理未运行', 'orange'],
  entry: ['入口需复核', 'orange'], region: ['出口不在美国', 'orange'], ipchanged: ['出口 IP 已变', 'orange'],
  dns: ['DNS 待核实', 'orange'], failed: ['检测未完成', 'red'], stale: ['结果已过期', 'orange'],
  dnsRegion: ['DNS 地区需复核', 'orange'],
  changed: ['环境刚有变化', 'orange'], missing: ['未监测', 'gray'], unsupported: ['不支持', 'gray'],
  configuration: ['配置需复核', 'orange'], checked: ['检测完成', 'gray'], recovered: ['环境恢复正常', 'gray'],
}
const ip = value => typeof value === 'string' && net.isIP(value) ? value : null
const country = value => typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : null
function countryName(value) {
  if (!country(value)) return '地区未知'
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(value) } catch { return value }
}
const row = (id, kind, label, value = '', evidence = []) => ({ id, title: TITLES[id], kind, label, value, evidence, hint: HINTS[id] })

/** Reject untrusted probe fields and retain only values required by the page. */
function cleanNetwork(raw = {}) {
  const egress = raw.egress || {}
  const dns = raw.dns || {}
  const resolvers = Array.isArray(dns.resolvers) ? dns.resolvers.slice(0, 8).map(item => ({ ip: ip(item.ip), country: country(item.country) })).filter(item => item.ip) : []
  return {
    proxyReady: raw.proxyReady === true,
    isolationActive: raw.isolationActive === true,
    egress: { ip: ip(egress.ip), country: country(egress.country), ok: egress.ok === true && Boolean(ip(egress.ip) && country(egress.country)) },
    dns: { resolvers, complete: dns.complete === true && resolvers.length > 0 && resolvers.every(item => item.country) },
  }
}

function present({ metadata, sample, monitoring, busy, history, lastSuccess, now = Date.now(), revision = 0 }) {
  const records = history.map(item => ({ ...item, label: LABELS[item.code]?.[0] || '环境变化', tone: LABELS[item.code]?.[1] || 'gray' }))
  const base = { supported: metadata?.supported !== false, available: metadata?.available === true, monitoring, busy, history: records, lastSuccess, revision, checkedAt: sample?.checkedAt || null }
  let code = metadata?.available ? 'first' : metadata?.reason || 'missing'
  let checks = IDS.map(id => row(id, 'unknown', '未检测'))
  let egress = { ip: null, country: null }
  let stale = false
  if (sample && metadata?.available) {
    const network = sample.network
    egress = network.egress.ok ? { ip: network.egress.ip, country: network.egress.country } : egress
    const dnsCountries = [...new Set(network.dns.resolvers.map(item => item.country))]
    const dnsOk = network.dns.complete && dnsCountries.every(value => value === 'US')
    checks = [
      row('egress', network.egress.ok ? egress.country === 'US' ? 'ok' : 'warn' : 'unknown', network.egress.ok ? countryName(egress.country) : '本次未测到', egress.ip || '', [
        ['本轮结果', network.egress.ok ? countryName(egress.country) : '地区未知'], ['目标地区', '美国'], ['检测路径', 'Claude 专用受限环境'],
      ]),
      row('dns', dnsOk ? 'ok' : network.dns.resolvers.length ? 'warn' : 'unknown', dnsOk ? '美国' : network.dns.resolvers.length && network.dns.complete ? '地区需复核' : network.proxyReady ? '待核实' : '未检测', network.dns.resolvers.length > 1 ? `${network.dns.resolvers.length} 个解析器` : network.dns.resolvers[0]?.ip || '',
        network.dns.resolvers.length ? network.dns.resolvers.map(item => ['解析器', `${item.ip} · ${countryName(item.country)}`]) : [['本轮结果', '没有专用解析证据']]),
      row('proxy', network.proxyReady ? 'ok' : 'warn', network.proxyReady ? '可连接' : '未运行', `127.0.0.1:${metadata.proxyPort}`, [['状态', network.proxyReady ? '本轮可连接' : '未就绪；没有自动启动'], ['用途', 'Claude Code 专用路线']]),
      row('launcher', egress.ip ? egress.ip === metadata.expectedIp ? 'ok' : 'warn' : 'unknown', egress.ip ? egress.ip === metadata.expectedIp ? '一致' : '不一致' : '未比对', '', [['固定 IP', metadata.expectedIp], ['当前出口', egress.ip || '未取得本轮结果'], ['操作', '只核对，不修改']]),
      row('entry', metadata.entryManaged && network.isolationActive ? 'ok' : 'warn', !metadata.entryManaged ? '入口已变化' : network.isolationActive ? '受管入口' : '限制未核实', '', [['普通入口', metadata.entryManaged ? '~/.local/bin/claude → 专用启动器' : '未指向专用启动器'], ['本轮进程限制', network.isolationActive ? '已加载' : '未验证'], ['其他入口', '旧会话、IDE 和其他副本未验证']]),
    ]
    if (!network.proxyReady) code = 'proxy'
    else if (!metadata.entryManaged) code = 'entry'
    else if (!network.egress.ok) code = 'failed'
    else if (!network.isolationActive) code = 'entry'
    else if (egress.country !== 'US') code = 'region'
    else if (egress.ip !== metadata.expectedIp) code = 'ipchanged'
    else if (!dnsOk) code = network.dns.complete ? 'dnsRegion' : 'dns'
    else code = 'healthy'
    stale = now - sample.checkedAt > STALE_MS || sample.fingerprint !== metadata.fingerprint
    if (stale) {
      code = 'stale'
      checks = checks.map(check => ({ ...check, kind: 'unknown', label: `上次：${check.label}`, evidence: [['结果时效', '历史结果，当前尚未核实'], ...check.evidence] }))
    }
  }
  const [label, tone] = LABELS[code] || LABELS.failed
  return { ...base, code, label, tone, egress, stale, checks }
}

function cleanHistory(raw, now) {
  return (Array.isArray(raw) ? raw : []).filter(item => item && LABELS[item.code] && Number.isFinite(item.at) && item.at <= now && item.at >= now - 86400000).slice(0, 200).map(item => ({ at: item.at, code: item.code, ip: ip(item.ip), country: country(item.country) }))
}

module.exports = { present, cleanNetwork, cleanHistory, countryName, LABELS, STALE_MS }
