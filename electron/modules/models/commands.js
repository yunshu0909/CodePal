/**
 * 第三方模型接入 · 终端命令
 *
 * 负责：
 * - 用户点「安装命令」后，在 ~/.local/bin 为每个模型写渠道专属命令（DeepSeek 保留旧名），为每家写稳定入口
 *   codepal-<供应商>（运行时取这家列表第一个模型，给 dev-workflow 审核用，改名不断）
 * - 命令是三行 shell：用 ELECTRON_RUN_AS_NODE=1 以 CodePal 自带的 Node 跑 cli.cjs；路径一律单引号转义，
 *   路径里的 $()、反引号不会被执行；命令里不含 Key
 * - 只动自己生成的文件（第二行带生成标记）；同名但不是 CodePal 生成的文件一律不覆盖
 * - 装过一次后，加模型 / 改名 / 移除时同步命令文件
 * - 状态：哪些模型缺命令、命令指向的 CodePal 是否还在、是不是当前运行的这一个、命令目录在不在 PATH 里
 *
 * 测试用覆盖口 CODEPAL_BIN_DIR。
 *
 * @module electron/modules/models/commands
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const store = require('./store')
const { PRESETS } = require('./presets')

const GENERATED_MARK = '# 由 CodePal 生成'
const PREFIX = 'codepal-'
const EXEC_MODE = 0o755

/** @returns {string} 命令目录 */
function binDir() {
  return process.env.CODEPAL_BIN_DIR || path.join(os.homedir(), '.local', 'bin')
}

/** 界面与报错里显示的目录写法（家目录写成 ~） */
function displayDir() {
  const dir = binDir()
  const home = os.homedir()
  return dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir
}

const commandName = (model, providerId = 'deepseek') => providerId === 'deepseek'
  ? `${PREFIX}${model}`
  : `${PREFIX}${providerId}--${model}`
const providerCommandName = (providerId) => `${PREFIX}${providerId}`

/** 单引号转义：整体包在单引号里，内部的 ' 写成 '\'' */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`
}

/** 解析命令第三行里的可执行文件与命令行脚本路径（shellQuote 的逆操作）；不是生成格式返回 null */
function targetOf(text) {
  const line = String(text).split('\n')[2] || ''
  const m = line.match(/^ELECTRON_RUN_AS_NODE=1 exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/)
  const unquote = (v) => v.replace(/'\\''/g, "'")
  return m ? { appExecPath: unquote(m[1]), cliPath: unquote(m[2]) } : null
}

/** 命令第三行里的可执行文件路径 */
const execPathOf = (text) => targetOf(text)?.appExecPath ?? null

const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/

/** 只读取版本号；文件缺失或格式不对时返回 null，不影响命令状态 */
function readVersion(read) {
  try {
    const version = read()
    return typeof version === 'string' && VERSION_RE.test(version) ? version : null
  } catch {
    return null
  }
}

/**
 * 说明命令指向的是哪个 CodePal：打包版（脚本在 .app 的 app.asar.unpacked 里）读 Info.plist 的版本号；
 * 开发版读代码目录的 package.json（Electron.app 自己的 Info.plist 是 Electron 的版本，不能用）
 * @param {{appExecPath: string, cliPath: string}} target
 * @returns {{version: string|null, location: string, dev: boolean}}
 */
function describeApp({ cliPath }) {
  const marker = `${path.sep}Contents${path.sep}Resources${path.sep}app.asar.unpacked${path.sep}`
  const i = cliPath.indexOf(marker)
  if (i !== -1) {
    const app = cliPath.slice(0, i)
    const version = readVersion(() => {
      const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8')
      return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/)?.[1]
    })
    return { version, location: app, dev: false }
  }
  // 开发版脚本在 <代码目录>/electron/modules/models/cli.cjs
  const root = path.resolve(path.dirname(cliPath), '..', '..', '..')
  const version = readVersion(() => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version)
  return { version, location: root, dev: true }
}

/**
 * 生成命令文件内容
 * @param {{appExecPath: string, cliPath: string, preset: object, modelArg: string}} p
 * @returns {string}
 */
function launcherContent({ appExecPath, cliPath, preset, modelArg }) {
  const note = modelArg === '@first'
    ? `${GENERATED_MARK}：用 ${preset.name} 列表里的第一个模型启动 Claude Code（给 dev-workflow 审核用）。请在 CodePal「模型接入」里管理，不要手改。`
    : `${GENERATED_MARK}：用 ${preset.name}（${modelArg}）启动 Claude Code。请在 CodePal「模型接入」里管理，不要手改。`
  return [
    '#!/bin/sh',
    note,
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(appExecPath)} ${shellQuote(cliPath)} launch ${preset.id} ${modelArg} -- "$@"`,
    '',
  ].join('\n')
}

// 文件在但读不了（权限等）：认不出是不是自己生成的，一律当别人的，不覆盖、不删除
const UNREADABLE = Symbol('unreadable')

/** 读文件；不存在返回 null，读不了返回 UNREADABLE */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    return err && err.code === 'ENOENT' ? null : UNREADABLE
  }
}

/** 是 CodePal 生成的命令文件 */
const isGenerated = (text) => typeof text === 'string' && (text.split('\n')[1] || '').startsWith(GENERATED_MARK)

/** 原子写一个 0755 文件 */
function writeExecutable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: EXEC_MODE })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, text, { mode: EXEC_MODE, flag: 'wx' })
  try {
    fs.chmodSync(tmp, EXEC_MODE)
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** 按当前配置列出应有的命令：[{ name, preset, modelArg }] */
function wantedCommands(cfg) {
  const out = []
  for (const [id, prov] of Object.entries(cfg.providers)) {
    const preset = PRESETS[id]
    if (!preset || !prov.keySet || !prov.models.length) continue
    for (const m of prov.models) out.push({ name: commandName(m.name, id), preset, modelArg: m.name, model: m.name })
    out.push({ name: providerCommandName(id), preset, modelArg: '@first', model: null })
  }
  return out
}

/** 记下上次安装用的路径，之后同步时沿用 */
function rememberPaths(cfg, appExecPath, cliPath) {
  cfg.commandsInstalled = true
  cfg.commandPaths = { appExecPath, cliPath }
}

/**
 * 写命令文件：先检查全部占用情况，一个被占就整体不写
 * @param {Array} wanted
 * @param {{appExecPath: string, cliPath: string}} paths
 * @returns {string[]} 写出的命令名
 */
function writeAll(wanted, { appExecPath, cliPath }) {
  // 先验整批目标，避免后面的同名渠道覆盖前面的内容；macOS 默认大小写不敏感。
  const names = new Set()
  for (const w of wanted) {
    const folded = w.name.toLowerCase()
    if (names.has(folded)) {
      const err = new Error(`安装失败：命令名冲突 ${w.name}，请修改模型名`)
      err.code = 'occupied'
      throw err
    }
    names.add(folded)
  }
  for (const w of wanted) {
    const text = readOrNull(path.join(binDir(), w.name))
    if (text !== null && !isGenerated(text)) {
      const err = new Error(`安装失败：${displayDir()}/${w.name} 已被别的程序占用`)
      err.code = 'occupied'
      throw err
    }
  }
  for (const w of wanted) writeExecutable(path.join(binDir(), w.name), launcherContent({ appExecPath, cliPath, preset: w.preset, modelArg: w.modelArg }))
  return wanted.map((w) => w.name)
}

/** 删掉自己生成、但已经不需要的命令（模型改名或移除后） */
function removeOrphans(wanted) {
  const keep = new Set(wanted.map((w) => w.name))
  let names = []
  try { names = fs.readdirSync(binDir()) } catch { return }
  for (const n of names) {
    if (!n.startsWith(PREFIX) || keep.has(n)) continue
    const file = path.join(binDir(), n)
    if (isGenerated(readOrNull(file))) fs.rmSync(file, { force: true })
  }
}

/**
 * 安装命令（用户点「安装命令」时调用）
 * @param {{appExecPath: string, cliPath: string}} paths
 * @returns {{installed: string[]}}
 */
function installCommands({ appExecPath, cliPath }) {
  const cfg = store.readConfig()
  const wanted = wantedCommands(cfg)
  const installed = writeAll(wanted, { appExecPath, cliPath })
  removeOrphans(wanted)
  rememberPaths(cfg, appExecPath, cliPath)
  store.writeConfig(cfg)
  return { installed }
}

/** 装过命令后，按当前模型同步命令文件；没装过什么都不做 */
function syncCommands() {
  const cfg = store.readConfig()
  if (!cfg.commandsInstalled || !cfg.commandPaths) return { installed: [] }
  const wanted = wantedCommands(cfg)
  const installed = writeAll(wanted, cfg.commandPaths)
  removeOrphans(wanted)
  return { installed }
}

/** 删掉某个模型的命令（只删自己生成的） */
function removeCommand(model, providerId = 'deepseek') {
  const file = path.join(binDir(), commandName(model, providerId))
  if (isGenerated(readOrNull(file))) fs.rmSync(file, { force: true })
}

/**
 * 命令状态
 * @param {{pathEnv?: string, current?: {appExecPath: string, cliPath: string}}} [opts]
 *   pathEnv：用来判断 onPath 的 PATH（主进程传登录 shell 的 PATH）；current：当前运行的 CodePal，不传就不比
 * @returns {{installed: boolean, missing: string[], missingEntries: string[], stale: boolean, onPath: boolean, binDir: string,
 *   otherApp: {version: string|null, location: string, dev: boolean}|null}}
 *   missing：缺命令的模型名；missingEntries：缺稳定入口 codepal-<供应商> 的供应商；
 *   otherApp：现有命令交给别的 CodePal 执行（老版本可能不认识这里新加的供应商），点「安装命令」会改用当前这个
 */
function commandsState({ pathEnv = process.env.PATH, current } = {}) {
  const cfg = store.readConfig()
  const missing = []
  const missingEntries = []
  let stale = false
  let otherApp = null
  const wanted = wantedCommands(cfg)
  const counts = new Map()
  for (const w of wanted) {
    const name = w.name.toLowerCase()
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  for (const w of wanted) {
    const text = readOrNull(path.join(binDir(), w.name))
    const exec = isGenerated(text) ? execPathOf(text) : null
    const broken = exec !== null && !fs.existsSync(exec)
    if (broken) stale = true
    const target = !broken && isGenerated(text) ? targetOf(text) : null
    if (!otherApp && current && target && (target.appExecPath !== current.appExecPath || target.cliPath !== current.cliPath)) {
      otherApp = describeApp(target)
    }
    // 同步失败会保留旧文件；文件存在不代表它仍指向当前渠道。
    const targetMatches = isGenerated(text) && (text.split('\n')[2] || '').endsWith(` launch ${w.preset.id} ${w.modelArg} -- "$@"`)
    const unique = counts.get(w.name.toLowerCase()) === 1
    if (targetMatches && unique && !broken) continue
    // 缺模型命令记模型名；缺每家稳定入口（dev-workflow 审核走它）记供应商
    if (w.model) missing.push(w.model)
    else missingEntries.push(w.preset.id)
  }
  const onPath = String(pathEnv || '').split(path.delimiter).some((d) => d && path.resolve(d) === path.resolve(binDir()))
  return { installed: Boolean(cfg.commandsInstalled), missing, missingEntries, stale, onPath, binDir: displayDir(), otherApp }
}

module.exports = {
  GENERATED_MARK,
  binDir,
  commandName,
  providerCommandName,
  shellQuote,
  launcherContent,
  installCommands,
  syncCommands,
  removeCommand,
  commandsState,
}
