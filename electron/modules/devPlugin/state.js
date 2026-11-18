/**
 * 插件管理 · 读 dev-workflow 两边的安装与开关（只读，后-01〜后-04、后-06、后-07、后-14〜后-20、后-26）
 *
 * - Claude Code：~/.claude/skills/dev-workflow/.claude-plugin/plugin.json 在 = 装了；
 *   ~/.claude/settings.json 的 enabledPlugins["dev-workflow@skills-dir"]：false 关，true 或没写开；
 *   系统管理设置（managed-settings）写了这一项就按它显示并锁定
 * - Codex：~/.codex/config.toml 里唯一的 [plugins."dev-workflow@<来源>"] 节 + 能找到插件包 = 装了；enabled 决定开关。
 *   插件包：本地来源看来源目录；git 等其他来源看 ~/.codex/plugins/cache/<来源>/dev-workflow/<版本>/（#83）
 * - 任何一边读不出（格式坏、类型不对、多个插件节、配置根不在默认位置、管理设置读不出）整页读取失败，原因写明是哪一处
 * - 不写任何文件，不修坏掉的配置；项目自己的 .claude/settings.json 不读
 *
 * 插件管理页与写入前复验（toggle.js）都用这里的读取，不另写一套解析（后-23）。
 *
 * @module electron/modules/devPlugin/state
 */

const fs = require('fs/promises')
const path = require('path')
const claudeSettings = require('../../services/claudeSettingsService')
const { parseToml } = require('../../services/tomlSafeEdit')

const PLUGIN_NAME = 'dev-workflow'
const CLAUDE_KEY = 'dev-workflow@skills-dir'
const SETTINGS_LABEL = '~/.claude/settings.json'
const CONFIG_LABEL = '~/.codex/config.toml'
const READ_FAILED_PREFIX = '读不到插件的安装信息：'

/** 读取失败：message 直接显示在整页「读取失败」下面 */
function readFailure(message) {
  return Object.assign(new Error(message), { code: 'read_failed' })
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 读文件时意外出错的中文原因（#83）；没列到的一律「读不出来」
const IO_REASONS = {
  EACCES: '没有读取权限',
  EPERM: '没有读取权限',
  EISDIR: '是个文件夹，不是文件',
  ELOOP: '是个绕成圈的链接',
  ENOTDIR: '的路径中间有一段不是文件夹',
}

/** 给页面看的路径：家目录里的写成 ~ 开头，不露出完整用户目录 */
function shownPath(file, homeDir) {
  const relative = path.relative(homeDir, file)
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  return relative && !outside ? `~/${relative}` : file
}

/** 读 JSON 文件；不存在返回 null，其余读不出的情况变成写明文件和原因的读取失败 */
async function readJsonIfExists(file, homeDir) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw readFailure(`${shownPath(file, homeDir)} ${IO_REASONS[error.code] || '读不出来'}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** 插件 manifest 里的 name / version；读不出的字段为 null（name 不是 dev-workflow 时调用方按没装处理） */
function manifestInfo(manifest) {
  return {
    name: isPlainObject(manifest) && typeof manifest.name === 'string' ? manifest.name : null,
    version: isPlainObject(manifest) && typeof manifest.version === 'string' && manifest.version ? manifest.version : null,
  }
}

async function realpathOrSelf(target) {
  try {
    return await fs.realpath(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * CLAUDE_CONFIG_DIR 把 Claude Code 配置指到别处时这一版不支持（后-17）
 * @param {string} homeDir
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<boolean>}
 */
async function claudeRootMoved(homeDir, env) {
  const configured = env && env.CLAUDE_CONFIG_DIR
  if (typeof configured !== 'string' || configured.trim() === '') return false
  return (await realpathOrSelf(configured.trim())) !== (await realpathOrSelf(path.join(homeDir, '.claude')))
}

/**
 * Claude Code 那边插件目录的身份：装没装、实际指向哪、manifest 写的名字与版本
 * @param {string} homeDir
 * @returns {Promise<{installed: boolean, realDir: string|null, name: string|null, version: string|null}>}
 */
async function readClaudePlugin(homeDir) {
  const dir = path.join(homeDir, '.claude/skills', PLUGIN_NAME)
  const manifest = await readJsonIfExists(path.join(dir, '.claude-plugin/plugin.json'), homeDir)
  const info = manifest === null ? null : manifestInfo(manifest)
  // 目录里放的不是 dev-workflow（name 不对或 manifest 坏了）按没装，开关不能点，不让每次点都报「别处改过」
  if (!info || info.name !== PLUGIN_NAME) return { installed: false, realDir: null, name: null, version: null }
  return { installed: true, realDir: await realpathOrSelf(dir), ...info }
}

/**
 * 系统管理设置里 dev-workflow 这一项（后-14、B-002）
 * 默认路径用 Claude 设置写入口自己的那份清单，保证读和写看的是同一组文件。
 * @param {string[]|null} managedPaths - 测试注入；缺省走平台默认
 * @returns {Promise<{value: boolean|undefined}>} value 为 undefined 表示没写
 */
async function readManagedEntry(managedPaths) {
  const paths = managedPaths || claudeSettings.__testing.managedSettingsPaths()
  let value
  for (const file of paths) {
    const state = await claudeSettings.readSettingsFileState(file)
    if (state.kind === 'missing') continue
    if (state.kind !== 'valid') throw readFailure('系统管理设置读不出来，看不出 Claude Code 这一项有没有被锁定')
    const plugins = state.data.enabledPlugins
    if (plugins === undefined || !isPlainObject(plugins) || !Object.prototype.hasOwnProperty.call(plugins, CLAUDE_KEY)) continue
    if (typeof plugins[CLAUDE_KEY] !== 'boolean') throw readFailure('系统管理设置里 dev-workflow 这一项不是 true / false')
    value = plugins[CLAUDE_KEY]
  }
  return { value }
}

/**
 * 用户级 settings.json 里的开关：没写或文件不存在算开（后-02、后-18、后-20）
 * @param {string} homeDir
 * @returns {Promise<boolean>}
 */
async function readClaudeEnabled(homeDir) {
  const state = await claudeSettings.readSettingsFileState(path.join(homeDir, '.claude/settings.json'))
  if (state.kind === 'missing') return true
  if (state.kind === 'corrupt') throw readFailure(`${SETTINGS_LABEL} 不是合法的 JSON`)
  if (state.kind !== 'valid') throw readFailure(`${SETTINGS_LABEL} 读不出来`)
  const plugins = state.data.enabledPlugins
  if (plugins === undefined) return true
  if (!isPlainObject(plugins)) throw readFailure(`${SETTINGS_LABEL} 里的 enabledPlugins 不是对象`)
  const value = plugins[CLAUDE_KEY]
  if (value === undefined) return true
  if (typeof value !== 'boolean') throw readFailure(`${SETTINGS_LABEL} 里 enabledPlugins 的 dev-workflow 一项不是 true / false`)
  return value
}

/**
 * 读 Claude Code 一边
 * @returns {Promise<{installed: boolean, enabled: boolean, locked: boolean, version: string|null, identity: object|null}>}
 */
async function readClaudeSide({ homeDir, env, managedPaths }) {
  if (await claudeRootMoved(homeDir, env)) throw readFailure('Claude Code 配置不在默认位置，这一版不支持')
  const plugin = await readClaudePlugin(homeDir)
  const userEnabled = await readClaudeEnabled(homeDir)
  const managed = await readManagedEntry(managedPaths)
  const locked = managed.value !== undefined
  return {
    installed: plugin.installed,
    enabled: locked ? managed.value : userEnabled,
    locked,
    version: plugin.version,
    identity: plugin.installed ? { realDir: plugin.realDir, name: plugin.name } : null,
  }
}

/**
 * 解析 config.toml 里 dev-workflow 插件节；config.toml 不存在返回 null
 * @param {string} homeDir
 * @returns {Promise<{doc: object, key: string|null, section: object|null}|null>}
 */
async function readCodexConfig(homeDir) {
  let text
  try {
    text = await fs.readFile(path.join(homeDir, '.codex/config.toml'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw readFailure(`${CONFIG_LABEL} 读不出来`)
  }
  let doc
  try {
    doc = parseToml(text, 'TOML_INVALID')
  } catch {
    throw readFailure(`${CONFIG_LABEL} 不是合法的 TOML`)
  }
  const plugins = isPlainObject(doc.plugins) ? doc.plugins : {}
  const keys = Object.keys(plugins).filter((key) => key.startsWith(`${PLUGIN_NAME}@`))
  if (keys.length > 1) throw readFailure(`Codex 配置里有 ${keys.length} 个 dev-workflow 插件节`)
  if (keys.length === 0) return { doc, key: null, section: null }
  return { doc, key: keys[0], section: plugins[keys[0]] }
}

/**
 * 插件节对应的本地来源里的插件包；找不到返回 null（按没装显示，真-03）
 * @returns {Promise<{realSource: string, name: string|null, version: string|null}|null>}
 */
async function readCodexPackage(doc, key, homeDir) {
  const market = key.slice(PLUGIN_NAME.length + 1)
  const entry = isPlainObject(doc.marketplaces) ? doc.marketplaces[market] : null
  if (!isPlainObject(entry)) return null
  // 从 git 等非本地来源装的：插件只在 Codex 插件缓存里（#83）；本地来源照旧看来源目录，找不到按没装（真-03）
  if (entry.source_type !== 'local') {
    const pkg = await readCodexCache(homeDir, market)
    // 来源类型和地址也进身份：页面打开后被别处换了来源，开关写入前的复验要能发现
    return pkg && { ...pkg, origin: `${entry.source_type}:${entry.source}` }
  }
  if (typeof entry.source !== 'string') return null
  const manifest = await readJsonIfExists(path.join(entry.source, 'plugins', PLUGIN_NAME, '.codex-plugin/plugin.json'), homeDir)
  const info = manifest === null ? null : manifestInfo(manifest)
  if (!info || info.name !== PLUGIN_NAME) return null
  return { realSource: await realpathOrSelf(entry.source), ...info }
}

/** 都是 1.2.3 这样的纯数字版本号才能比大小 */
const plainVersion = (value) => typeof value === 'string' && /^\d+(\.\d+)*$/.test(value)
function newerVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? a : b
  }
  return a
}

/**
 * 非本地来源装的插件包：~/.codex/plugins/cache/<来源>/dev-workflow/<版本>/.codex-plugin/plugin.json（#83）
 * 缓存里常留着好几个旧版本，Codex 实际用哪个没有文档，不猜：都是纯数字版本号就显示最高的，比不了就「看不出版本」
 * @returns {Promise<{realSource: string, name: string, version: string|null}|null>} 没有 dev-workflow 包返回 null
 */
async function readCodexCache(homeDir, market) {
  if (!market || market.includes('/') || market.includes('\\') || market.startsWith('.')) return null
  const dir = path.join(homeDir, '.codex/plugins/cache', market, PLUGIN_NAME)
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw readFailure(`${shownPath(dir, homeDir)} ${IO_REASONS[error.code] || '读不出来'}`)
  }
  const versions = []
  for (const name of names.sort()) {
    // 只看版本文件夹（或指向文件夹的链接）：.DS_Store、Codex 自己的安装记录、断掉的链接都跳过
    const entry = path.join(dir, name)
    const stat = await fs.stat(entry).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null   // 断掉的链接
      throw readFailure(`${shownPath(entry, homeDir)} ${IO_REASONS[error.code] || '读不出来'}`)
    })
    if (!stat || !stat.isDirectory()) continue
    const manifest = await readJsonIfExists(path.join(dir, name, '.codex-plugin/plugin.json'), homeDir)
    const info = manifest === null ? null : manifestInfo(manifest)
    if (info && info.name === PLUGIN_NAME) versions.push(info.version)
  }
  if (!versions.length) return null
  const version = versions.every(plainVersion) ? versions.reduce(newerVersion) : versions.length === 1 ? versions[0] : null
  return { realSource: await realpathOrSelf(dir), name: PLUGIN_NAME, version }
}

/**
 * 读 Codex 一边
 * @returns {Promise<{installed: boolean, enabled: boolean, locked: boolean, version: string|null, identity: object|null}>}
 */
async function readCodexSide({ homeDir }) {
  const config = await readCodexConfig(homeDir)
  if (!config || !config.key) return { installed: false, enabled: false, locked: false, version: null, identity: null }
  if (!isPlainObject(config.section)) throw readFailure(`${CONFIG_LABEL} 里 dev-workflow 插件节不是表`)
  const { enabled } = config.section
  // Codex 对没写 enabled 的默认值未核实（B-001）：不猜，按读取失败
  if (enabled === undefined) throw readFailure(`${CONFIG_LABEL} 里 dev-workflow 插件节没写 enabled`)
  if (typeof enabled !== 'boolean') throw readFailure(`${CONFIG_LABEL} 里 dev-workflow 插件节的 enabled 不是 true / false`)
  const pkg = await readCodexPackage(config.doc, config.key, homeDir)
  if (!pkg) return { installed: false, enabled, locked: false, version: null, identity: null }
  return {
    installed: true,
    enabled,
    locked: false,
    version: pkg.version,
    identity: { key: config.key, realSource: pkg.realSource, name: pkg.name, ...(pkg.origin ? { origin: pkg.origin } : {}) },
  }
}

/** 版本号位置的文字（后-01、后-19、后-26） */
function versionText(claude, codex) {
  const side = claude.installed ? claude : codex.installed ? codex : null
  if (!side) return '没装'
  return side.version || '看不出版本'
}

const publicSide = ({ installed, enabled, locked }) => ({ installed, enabled, locked })

/**
 * 读两边的状态（只读）
 * @param {object} options
 * @param {string} options.homeDir - 可信家目录（主进程给）
 * @param {Record<string, string|undefined>} [options.env] - 环境变量，看 CLAUDE_CONFIG_DIR
 * @param {string[]|null} [options.managedPaths] - 系统管理设置路径；缺省走平台默认
 * @returns {Promise<{ok: true, data: {versionText: string, claude: object, codex: object, identity: {claude: object|null, codex: object|null}}}
 *   | {ok: false, error: {code: string, message: string}}>} identity 只给主进程写前复验用，不发给页面
 */
async function readDevPluginState({ homeDir, env = process.env, managedPaths = null }) {
  try {
    const claude = await readClaudeSide({ homeDir, env, managedPaths })
    const codex = await readCodexSide({ homeDir })
    return {
      ok: true,
      data: {
        versionText: versionText(claude, codex),
        claude: publicSide(claude),
        codex: publicSide(codex),
        identity: { claude: claude.identity, codex: codex.identity },
      },
    }
  } catch (error) {
    // 原因前统一冠「读不到插件的安装信息：」（定稿文案），后面写明是哪个文件、哪一项
    // 分不出原因的意外错误不显示程序原文（英文、可能带完整路径，#83）
    const reason = error && error.code === 'read_failed' ? error.message : '读的时候出了意外问题，重试一次；还不行就重启 CodePal'
    return { ok: false, error: { code: 'read_failed', message: `${READ_FAILED_PREFIX}${reason}` } }
  }
}

module.exports = {
  readDevPluginState,
  readClaudeSide,
  readCodexSide,
  readCodexConfig,
  claudeRootMoved,
  CLAUDE_KEY,
  SETTINGS_LABEL,
  CONFIG_LABEL,
}
