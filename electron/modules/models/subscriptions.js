/** Read local subscription availability without returning credential or filesystem data. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { locateClaude } = require('./claudeCli')

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Trusted executable override is used by the same local discovery contract as Claude. */
/** @param {object} env 可信主进程环境。 @param {string} homeDir 本机home。 @returns {string|null} 可执行Codex路径，仅读文件状态，不启动命令。 */
function locateCodex(env = process.env, homeDir = os.homedir()) {
  if (env.CODEPAL_CODEX_BIN) return executable(env.CODEPAL_CODEX_BIN) ? path.resolve(env.CODEPAL_CODEX_BIN) : null
  const directories = [
    ...String(env.PATH || '').split(path.delimiter),
    path.join(homeDir, '.local/bin'),
    path.join(homeDir, '.npm-global/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  for (const directory of directories) {
    if (!directory) continue
    const file = path.join(directory, 'codex')
    if (executable(file)) return path.resolve(file)
  }
  return null
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function exists(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function claudeDefault(homeDir, models) {
  let value = ''
  try {
    value = readJson(path.join(homeDir, '.claude/settings.json')).model
  } catch {}
  const alias = String(value || '')
    .toLowerCase()
    .replace(/\[1m\]$/, '')
  const match = models.find((model) => alias === model.slug || alias.startsWith(`claude-${model.slug}-`))
  return match ? match.slug : 'opus'
}

function packagedFile(relative) {
  return path.resolve(__dirname, '../../..', relative).replace(/app\.asar\.unpacked(?=[/\\])/, 'app.asar')
}

function claudeModels() {
  // Read the one bundled catalog; an unavailable catalog retains the signed four-model baseline.
  let registry = null
  try {
    registry = readJson(packagedFile('src/config/model-registry.json'))
    if (!Array.isArray(registry.models) || !Array.isArray(registry.effortLevels)) registry = null
  } catch {}
  const models = registry?.models || [
    { id: 'fable', display: 'Fable 5.1' },
    { id: 'opus', display: 'Opus 5.5' },
    { id: 'sonnet', display: 'Sonnet 5.5' },
    { id: 'haiku', display: 'Haiku 4.5' },
  ]
  const efforts = registry?.effortLevels.map((level) => level.id) || ['low', 'medium', 'high', 'xhigh', 'max']
  return models.map((item) => ({ slug: item.id, displayName: item.display || item.id, efforts: [...efforts] }))
}

/** Only the top-level quoted model string is needed; keep the unpacked CLI tree dependency-free. */
function codexDefault(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break
      const match = line.match(/^\s*model\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/)
      if (!match) continue
      if (match[1].startsWith("'")) return match[1].slice(1, -1)
      const jsonString = match[1].replace(/\\U([0-9a-fA-F]{8})/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      return JSON.parse(jsonString)
    }
  } catch {}
  return ''
}

/** Only credential presence participates in discovery; no credential value escapes this module. */
/**
 * 只读发现本机Claude/Codex可见模型与实际支持档位。
 * @param {object} [options] 可信homeDir/env及可注入的CLI定位函数。
 * @returns {Array<object>} 两订阅来源，含blocked、defaultModel及模型；不含账户或凭证值。
 * 读取设置与模型缓存，登录仅判存在；不启动CLI、不写文件，失败转为来源阻挡状态。
 */
function discoverSubscriptions({
  homeDir = os.homedir(),
  env = process.env,
  locateClaude: findClaude = locateClaude,
  locateCodex: findCodex = locateCodex,
} = {}) {
  const claude = {
    id: 'claude',
    name: 'Claude Code',
    color: 'var(--tool-claude)',
    blocked: null,
    models: [],
    defaultModel: null,
  }
  if (!findClaude(env)) claude.blocked = 'notInstalled'
  else {
    let loggedIn = false
    try {
      loggedIn = Object.hasOwn(readJson(path.join(homeDir, '.claude.json')), 'oauthAccount')
    } catch {}
    if (!loggedIn) claude.blocked = 'notLoggedIn'
    else {
      claude.models = claudeModels()
      claude.defaultModel = claudeDefault(homeDir, claude.models)
    }
  }
  const codex = {
    id: 'codex',
    name: 'Codex',
    color: 'var(--tool-codex)',
    blocked: null,
    models: [],
    defaultModel: null,
  }
  if (!findCodex(env, homeDir)) codex.blocked = 'notInstalled'
  else if (!exists(path.join(homeDir, '.codex/auth.json'))) codex.blocked = 'notLoggedIn'
  else {
    try {
      const cache = readJson(path.join(homeDir, '.codex/models_cache.json'))
      if (!Array.isArray(cache.models)) throw new Error('invalid model list')
      const seen = new Set()
      for (const item of cache.models) {
        if (
          item.visibility !== 'list' ||
          typeof item.slug !== 'string' ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(item.slug) ||
          seen.has(item.slug)
        )
          continue
        const efforts = (Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : [])
          .map((level) => level.effort)
          .filter((effort) => typeof effort === 'string' && /^[a-z0-9_-]{1,32}$/.test(effort))
        if (!efforts.length) continue
        seen.add(item.slug)
        codex.models.push({
          slug: item.slug,
          displayName: typeof item.display_name === 'string' ? item.display_name : item.slug,
          efforts: [...new Set(efforts)],
        })
      }
      if (!codex.models.length) throw new Error('empty model list')
      const configured = codexDefault(path.join(homeDir, '.codex/config.toml'))
      codex.defaultModel = codex.models.some((model) => model.slug === configured) ? configured : codex.models[0].slug
    } catch {
      codex.blocked = 'noModelList'
      codex.models = []
    }
  }
  return [claude, codex]
}

module.exports = { discoverSubscriptions, locateCodex }
