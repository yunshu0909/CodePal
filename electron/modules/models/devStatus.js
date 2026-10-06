/**
 * dev 插件两端的安装状态（后-09、§7.4）：只读，不启动任何命令
 *
 * - Claude Code 端：~/.claude/skills/dev-workflow/.claude-plugin/plugin.json 的 version
 * - Codex 端：~/.codex/config.toml 里开着的 [plugins."dev-workflow@<来源>"]，到 [marketplaces.<来源>] 的本地来源读
 *   plugins/dev-workflow/.codex-plugin/plugin.json 的 version，再核对 ~/.codex/plugins/cache/<来源>/dev-workflow/<版本>/ 存在
 * - 每端：ok（≥ 最低版本）/ none（没装或没开）/ old（低于最低版本）/ unknown（读不出、判断不了）；版本未知不算支持
 *
 * @module electron/modules/models/devStatus
 */
const fs = require('fs')
const path = require('path')
const { compareVersions } = require('./reviewDefaults')

function readVersion(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof value?.version !== 'string' || Number.isNaN(compareVersions(value.version, '0'))) throw new Error('no version')
  return value.version
}

function grade(version, minVersion) {
  return compareVersions(version, minVersion) >= 0 ? 'ok' : 'old'
}

function claudeEnd(homeDir, minVersion) {
  const root = path.join(homeDir, '.claude/skills/dev-workflow')
  if (!fs.existsSync(root)) return 'none'
  try {
    return grade(readVersion(path.join(root, '.claude-plugin/plugin.json')), minVersion)
  } catch {
    return 'unknown'
  }
}

/** 只认本模块需要的几行 TOML：节标题、enabled、source_type、source（双引号字符串） */
function parseCodexConfig(text) {
  const sections = new Map()
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line) continue
    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      current = header[1].trim()
      sections.set(current, sections.get(current) || {})
      continue
    }
    if (!current) continue
    const pair = line.match(/^([A-Za-z_]+)\s*=\s*(.+)$/)
    if (!pair) continue
    const [, key, rawValue] = pair
    let value = rawValue
    if (rawValue === 'true' || rawValue === 'false') value = rawValue === 'true'
    else if (/^"(?:[^"\\]|\\.)*"$/.test(rawValue)) value = JSON.parse(rawValue)
    sections.get(current)[key] = value
  }
  return sections
}

function codexEnd(homeDir, minVersion) {
  let text
  try {
    text = fs.readFileSync(path.join(homeDir, '.codex/config.toml'), 'utf8')
  } catch (error) {
    return error.code === 'ENOENT' ? 'none' : 'unknown'
  }
  try {
    const sections = parseCodexConfig(text)
    const markets = []
    for (const [name, values] of sections) {
      const match = name.match(/^plugins\."dev-workflow@([^"]+)"$/)
      if (match && values.enabled === true) markets.push(match[1])
    }
    if (markets.length === 0) return 'none'
    if (markets.length > 1) return 'unknown'
    const market = markets[0]
    const source = sections.get(`marketplaces.${market}`)
    if (!source || source.source_type !== 'local' || typeof source.source !== 'string') return 'unknown'
    const version = readVersion(path.join(source.source, 'plugins/dev-workflow/.codex-plugin/plugin.json'))
    const cached = path.join(homeDir, '.codex/plugins/cache', market, 'dev-workflow', version)
    if (!fs.statSync(cached).isDirectory()) return 'unknown'
    return grade(version, minVersion)
  } catch {
    return 'unknown'
  }
}

/**
 * @param {{homeDir: string, minVersion: string}} options 可信 home 与最低版本
 * @returns {{claude: 'ok'|'none'|'old'|'unknown', codex: 'ok'|'none'|'old'|'unknown'}}
 */
function readDevStatus({ homeDir, minVersion }) {
  return { claude: claudeEnd(homeDir, minVersion), codex: codexEnd(homeDir, minVersion) }
}

module.exports = { readDevStatus, compareVersions }
