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
 * - 总入口 codepal（v2.1.22 在终端里用）：随安装 / 更新 / 同步一起写，指向同目录的选择程序 picker.cjs；
 *   ~/.local/bin/codepal 是别人的就不覆盖、不删除（后-09）；以前装过命令、从没写过总入口时进入页面补上（后-17）
 * - 选择程序列哪些模型（readyModels，后-01）：填了 Key 且读得到、最近一次「测一下」可用、单模型命令在且是 CodePal 生成的
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
const ENTRY_NAME = 'codepal'
const PICKER_FILE = 'picker.cjs'
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

/** 选择程序和命令行脚本在同一个目录（打包后同在 app.asar.unpacked 里） */
const pickerPathOf = (cliPath) => path.join(path.dirname(cliPath), PICKER_FILE)

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

/**
 * 总入口 codepal 的内容：先看三个标准流是不是终端（被脚本调用、接管道时不进列表，后-07），
 * 再让选择程序把选中的单模型命令写到标准输出，由这个脚本 exec 成它，参数原样往后传（后-03）
 * @param {{appExecPath: string, pickerPath: string}} p
 * @returns {string}
 */
function entryContent({ appExecPath, pickerPath }) {
  return [
    '#!/bin/sh',
    `${GENERATED_MARK}：列出测过能用的模型，选一个在当前文件夹打开 Claude Code。请在 CodePal「模型接入」里管理，不要手改。`,
    'if [ -t 0 ] && [ -t 1 ] && [ -t 2 ]; then CODEPAL_PICKER_TTY=1; else CODEPAL_PICKER_TTY=0; fi',
    `choice=$(CODEPAL_PICKER_TTY=$CODEPAL_PICKER_TTY ELECTRON_RUN_AS_NODE=1 ${shellQuote(appExecPath)} ${shellQuote(pickerPath)}) || exit $?`,
    'exec "$choice" "$@"',
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

/**
 * 写总入口；~/.local/bin/codepal 已在且不是 CodePal 生成的就不动它
 * @returns {'written'|'taken'}
 */
function writeEntry({ appExecPath, cliPath }) {
  const file = path.join(binDir(), ENTRY_NAME)
  const text = readOrNull(file)
  if (text !== null && !isGenerated(text)) return 'taken'
  writeExecutable(file, entryContent({ appExecPath, pickerPath: pickerPathOf(cliPath) }))
  return 'written'
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
 * 安装命令（用户点「安装命令」「更新命令」时调用）
 * @param {{appExecPath: string, cliPath: string}} paths
 * @returns {{installed: string[], entry: 'written'|'taken'|'failed'}} entry = codepal 总入口写好 / 名字被占跳过 / 没写进去
 * @throws 单模型命令或每家入口写不进去、名字被占时抛错（整批不写）
 */
function installCommands({ appExecPath, cliPath }) {
  const cfg = store.readConfig()
  const wanted = wantedCommands(cfg)
  const installed = writeAll(wanted, { appExecPath, cliPath })
  // 单模型命令写好就算装好：之后的总入口、删旧命令、记「已安装」失败都不改结果（后-08），下次进入页面照实显示
  let entry
  try { entry = writeEntry({ appExecPath, cliPath }) } catch { entry = 'failed' }
  try { removeOrphans(wanted) } catch {}
  rememberPaths(cfg, appExecPath, cliPath)
  if (entry === 'written') cfg.entryInstalled = true
  try { store.writeConfig(cfg) } catch {}
  return { installed, entry }
}

/** 装过命令后，按当前模型同步命令文件；没装过什么都不做 */
function syncCommands() {
  const cfg = store.readConfig()
  if (!cfg.commandsInstalled || !cfg.commandPaths) return { installed: [] }
  const wanted = wantedCommands(cfg)
  const installed = writeAll(wanted, cfg.commandPaths)
  // 写过总入口、而且它还在、还是 CodePal 的，才跟着更新；用户自己删掉的不补回（后-16、后-17-例5），
  // 从没写过的交给 ensureEntry（后-17）
  if (cfg.entryInstalled && isGenerated(readOrNull(path.join(binDir(), ENTRY_NAME)))) writeEntry(cfg.commandPaths)
  removeOrphans(wanted)
  return { installed }
}

/**
 * 升级后补总入口（后-17、A-101）：以前装过命令、从没写过总入口时写上；名字被占、从没装过、写过又被删的都不补。
 * 写不进去不抛错，照实返回 failed，页面按实际状态显示、下次进入再试。
 * @returns {{status: 'written'|'skipped'|'failed'}}
 */
function ensureEntry() {
  let cfg
  try { cfg = store.readConfig() } catch { return { status: 'skipped' } }
  if (!cfg.commandsInstalled || !cfg.commandPaths || cfg.entryInstalled) return { status: 'skipped' }
  const text = readOrNull(path.join(binDir(), ENTRY_NAME))
  if (text !== null) return { status: 'skipped' }
  try {
    writeEntry(cfg.commandPaths)
    cfg.entryInstalled = true
    store.writeConfig(cfg)
    return { status: 'written' }
  } catch {
    return { status: 'failed' }
  }
}

/** 测过能用（与模型汇总 hub.js tested() 同一口径：有「测一下」记录看它，后台审核的结果不算） */
function tested(status) {
  if (!status) return false
  return Object.hasOwn(status, 'lastTest') ? status.lastTest?.ok === true : status.ok === true
}

/**
 * 选择程序列哪些模型（后-01）：顺序同模型接入页（各家预设顺序，再按家里的模型顺序）
 * @param {object} [cfg] - 不传就读当前配置（读不出抛 read_failed）
 * @returns {Array<{providerId: string, providerName: string, model: string, command: string, file: string}>}
 */
function readyModels(cfg = store.readConfig()) {
  const statuses = store.readStatuses()
  const out = []
  for (const preset of Object.values(PRESETS)) {
    const prov = cfg.providers[preset.id]
    if (!prov || !prov.keySet || !prov.models.length) continue
    if (!store.keyState(preset.id).keyReadable) continue
    for (const m of prov.models) {
      if (!tested(statuses[`${preset.id}__${m.id}`])) continue
      const name = commandName(m.name, preset.id)
      const file = path.join(binDir(), name)
      if (!isGenerated(readOrNull(file))) continue
      out.push({ providerId: preset.id, providerName: preset.name, model: m.name, command: name, file })
    }
  }
  return out
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
  const entryText = readOrNull(path.join(binDir(), ENTRY_NAME))
  const entry = entryText === null ? 'missing' : !isGenerated(entryText) ? 'taken' : 'ok'
  let readyCount = 0
  try { readyCount = readyModels(cfg).length } catch {}
  return { installed: Boolean(cfg.commandsInstalled), missing, missingEntries, stale, onPath, binDir: displayDir(), otherApp, entry, readyCount }
}

module.exports = {
  GENERATED_MARK,
  ENTRY_NAME,
  entryContent,
  ensureEntry,
  readyModels,
  pickerPathOf,
  isGenerated,
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
