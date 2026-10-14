/**
 * 第三方模型接入 · 主进程接口（models:*）
 *
 * 负责：
 * - 通道：models:list / setKey / test / addModel / updateModel / removeModel / recheckClaude / installCommands
 *   models:hubList / hubSetEnabled / hubSetEffort / hubSetOrder（模型汇总的模型页签）
 *   models:rulesGet / rulesSet / rulesReset / configRepublish（审核规则页签与给 dev 的审核配置）
 * - 统一返回 { success, data, error: { code, message } }；渲染层只传 ID，永远拿不到 Key 原文
 * - 「测一下」起一个命令行子进程（和审核走同一个入口），结束后读回状态文件
 * - 监听 status/ 目录：命令行（含 dev-workflow 审核）写回结果时推 models:changed 给页面
 * - 装过命令后，加模型 / 改名 / 移除 / 存 Key 时同步终端命令
 * - 在终端里用（v2.1.22）：models:list 带回终端找不找得到 codepal（用登录 shell 判断，同一时间只跑一次、1 秒内合并）、
 *   要写的 shell 文件与总入口状态，进入页面时给旧版装过命令的补上总入口（后-17）；models:addToPath 确认后替用户加一行
 *
 * @module electron/modules/models/ipc
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')
const store = require('./store')
const { createReviewCenter } = require('./reviewCenter')
const commands = require('./commands')
const shellProfile = require('./shellProfile')
const { PRESETS, modelCapabilities } = require('./presets')
const { locateClaude, checkClaudeVersion, MIN_CLAUDE_VERSION } = require('./claudeCli')

const WRITE_DENIED = '配置目录没有写入权限，检查权限后重试'
const INSTALL_DENIED = '安装失败：~/.local/bin 没有写入权限，检查权限后重试'
const BUSINESS_CODES = new Set(['invalid_input', 'duplicate', 'not_found', 'read_failed', 'occupied', 'reserved_flag',
  'write_denied', 'HUB_FILE_INVALID', 'RULES_FILE_INVALID', 'LOCK_BUSY', 'ROLLBACK_FAILED',
  'unsupported_shell', 'target_changed', 'changed_meanwhile'])
const UNSUPPORTED_SHELL = '这个 shell 不能自动加入 PATH，请手动把 ~/.local/bin 加进它的 PATH'
// 「测一下」的外层兜底：命令行自己 60 秒超时，这里再多给 15 秒收尾
const TEST_GUARD_MS = 75000

/** 打包后 cli.cjs 在 app.asar.unpacked 里，命令行要能直接读到文件 */
function defaultCliPath() {
  return path.join(__dirname, 'cli.cjs').replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked')
}

/** 把异常翻成接口错误 */
function toError(err, { install = false } = {}) {
  if (err && BUSINESS_CODES.has(err.code)) {
    // 目标变了时带回新目标，页面据此重新确认（后-13-例6）
    if (!err.profile) return { code: err.code, message: err.message }
    return { code: err.code, message: err.message, profile: err.profile, identity: err.identity || null }
  }
  if (err && ['EACCES', 'EPERM', 'EROFS'].includes(err.code)) return { code: 'write_denied', message: install ? INSTALL_DENIED : WRITE_DENIED }
  return { code: 'unknown', message: (err && err.message) || '出错了' }
}

const ok = (data) => ({ success: true, data, error: null })
const bad = (err, opts) => ({ success: false, data: null, error: toError(err, opts) })

/** 给模型带上这家这个模型可选的思考强度（按模型算，M3 这类没有档位的是空数组），页面照它显示菜单 */
function withEfforts(providerId, model) {
  const preset = PRESETS[providerId]
  return { ...model, efforts: preset ? [...modelCapabilities(preset, model.name).efforts] : [] }
}

/** 某家给页面看的数据（不含 Key） */
function providerView(cfg, statuses, providerId) {
  const prov = cfg.providers[providerId]
  if (!prov) return { keySet: false, keyReadable: false, models: [] }
  const { keySet, keyReadable } = store.keyState(providerId)
  return {
    keySet,
    keyReadable,
    models: prov.models.map((m) => ({ ...withEfforts(providerId, m), lastResult: statuses[`${providerId}__${m.id}`] || null })),
  }
}

/**
 * 注册 models:* 通道
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {() => import('electron').BrowserWindow|null} deps.getMainWindow
 * @param {string} [deps.cliPath] - 命令行脚本路径（默认本目录的 cli.cjs，打包后换成 unpacked 路径）
 * @param {string} [deps.appExecPath] - 用来跑命令行的可执行文件（默认 process.execPath，即 CodePal 本身）
 * @param {() => string} [deps.loginPath] - 旧注入口：直接给一个 PATH（测试用），等同判断成功
 * @param {() => Promise<{status: 'ok', path: string, codepal: string|null}|{status: 'unknown'}>} [deps.loginEnv]
 *   - 读登录 shell 的 PATH（默认 shellProfile.readLoginEnv；测试注入以模拟判断不了）
 * @param {{shell?: string, home?: string, zdotdir?: string|null, binDir?: string, reprobeMs?: number}} [deps.shellOptions]
 *   - 用哪个 shell、家目录、ZDOTDIR、命令目录，以及多久内的判断结果可以直接沿用（默认 1 秒）
 * @returns {{stop: () => void}}
 */
function registerModelsHandlers({ ipcMain, getMainWindow, cliPath = defaultCliPath(), appExecPath = process.execPath, loginPath, loginEnv, shellOptions = {}, hubOptions = {} }) {
  // 模型汇总两页签与给 dev 的审核配置：唯一写方是 reviewCenter
  const center = createReviewCenter(hubOptions)
  // 模型接入里的事件（测一下、增删改、存 Key、装命令、状态文件变化）之后重新生成审核配置；失败由页面下一次读取报告
  const refreshHubQuietly = () => center.refreshQuietly()
  const hubError = (error) => {
    const translated = toError(error)
    if (translated.code === 'unknown') translated.message = '出错了'
    return { success: false, data: null, error: translated }
  }
  const hubChannels = [
    ['models:hubList', () => center.list()],
    ['models:hubSetEnabled', (payload) => center.setEnabled(payload)],
    ['models:hubSetEffort', (payload) => center.setEffort(payload)],
    ['models:hubSetOrder', (payload) => center.setOrder(payload)],
    ['models:rulesGet', () => center.rulesGet()],
    ['models:rulesSet', (payload) => center.rulesSet(payload)],
    ['models:rulesReset', () => center.rulesReset()],
    ['models:configRepublish', () => center.republish()],
  ]
  for (const [channel, handler] of hubChannels) {
    ipcMain.handle(channel, (_event, payload) => {
      try {
        return ok(handler(payload))
      } catch (error) {
        return hubError(error)
      }
    })
  }
  // 启动对账：处理保存到一半留下的恢复记录，再按设置重新生成审核配置（后-10、后-17）；不打开页面也有审核配置
  try {
    center.reconcile()
  } catch {
    // 对账失败不阻止接入管理启动；页面读取时再报告
  }
  let claudeCache = null
  const claudeInfo = () => {
    if (!claudeCache) {
      const bin = locateClaude()
      if (!bin) claudeCache = { found: false, version: null, tooOld: false, required: MIN_CLAUDE_VERSION }
      else {
        const v = checkClaudeVersion(bin)
        claudeCache = { found: true, version: v.current, tooOld: !v.ok, required: v.required }
      }
    }
    return claudeCache
  }

  // ── 终端找不找得到 codepal（后-12）──
  // 用哪个 shell 每次现取：CodePal 开着时改了登录 shell 也跟得上（后-13）
  const currentShell = () => shellOptions.shell || shellProfile.loginShell()
  const home = shellOptions.home || os.homedir()
  const reprobeMs = shellOptions.reprobeMs ?? 1000
  const binDir = () => shellOptions.binDir || commands.binDir()
  // 判断用的环境：显式给了 zdotdir（测试）就按它；否则原样交给登录 shell，ZDOTDIR 由它自己的启动文件决定
  const probeEnv = () => {
    const env = { ...process.env }
    if (shellOptions.zdotdir === undefined) return env
    if (shellOptions.zdotdir) env.ZDOTDIR = shellOptions.zdotdir
    else delete env.ZDOTDIR
    return env
  }
  /** 读登录 shell 的环境：测试可注入 loginEnv；旧注入口 loginPath 当作判断成功；默认真的启动一次登录 shell */
  const readEnv = () => {
    if (loginEnv) return loginEnv()
    if (loginPath) return Promise.resolve({ status: 'ok', path: loginPath(), codepal: null })
    return shellProfile.readLoginEnv({ shell: currentShell(), home: shellOptions.home, env: probeEnv() })
  }
  // cached：最近一次判断成功的结果，reprobeMs 内直接沿用；判断不了不记住（后-12-例3）
  let cached = null
  // lastEnv：最近一次判断的结果（含判断不了），写操作顺带返回命令状态时用，不为此再启动 shell
  let lastEnv = null
  // lastOkEnv：最近一次判断成功的结果；之后判断不了时，要写的文件仍按它读到的 ZDOTDIR 算（后-13）
  let lastOkEnv = null
  // inflight：正在跑的那次判断；同一时间只跑一次
  let inflight = null
  const startProbe = () => {
    const me = { startedAt: Date.now() }
    me.promise = Promise.resolve()
      .then(() => readEnv())
      .catch(() => ({ status: 'unknown' }))
      .then((result) => {
        const value = result && result.status === 'ok' ? result : { status: 'unknown' }
        if (inflight === me) inflight = null
        lastEnv = value
        if (value.status === 'ok') lastOkEnv = value
        cached = value.status === 'ok' ? { at: me.startedAt, result: value } : null
        return value
      })
    inflight = me
    return me.promise
  }
  /**
   * 判断一次；force = 动作成功后必须重新判断（不沿用缓存，正在跑的那次结束后再跑一次）
   * @returns {Promise<{status: 'ok', path: string, codepal: string|null}|{status: 'unknown'}>}
   */
  const detect = async ({ force = false } = {}) => {
    if (!force && cached && Date.now() - cached.at < reprobeMs) return cached.result
    if (inflight && !force && Date.now() - inflight.startedAt < reprobeMs) return inflight.promise
    if (inflight) {
      const old = inflight
      await old.promise
      if (inflight && inflight !== old) return inflight.promise
    }
    return startProbe()
  }
  /**
   * 加入 PATH 写哪个文件（后-13、A-102）：shell 种类现取；ZDOTDIR 以登录 shell 实际读到的为准
   * （常在 ~/.zshenv 里设，CodePal 自己的环境里没有），判断不了时才退回 CodePal 自己环境里的
   */
  const profileTarget = (env) => {
    return shellProfile.profileTarget({ kind: shellProfile.shellKind(currentShell()), home, zdotdir: zdotdirFor(env) })
  }
  /** ZDOTDIR：测试显式给了就用它；这次判断成功用这次的；判断不了用上次成功的；从没成功过才看 CodePal 自己的环境 */
  const zdotdirFor = (env) => {
    if (shellOptions.zdotdir !== undefined) return shellOptions.zdotdir
    const known = env && env.status === 'ok' ? env : lastOkEnv
    if (known) return known.zdotdir || null
    return process.env.ZDOTDIR || null
  }
  /** 命令状态 + 终端找不找得到 + 要写的文件；env 为空时按「判断不了」算 */
  const terminalState = (env) => {
    const probe = env || { status: 'unknown' }
    const base = commands.commandsState({ pathEnv: probe.status === 'ok' ? probe.path : '', current: { appExecPath, cliPath } })
    const pathStatus = shellProfile.pathStatus(probe, binDir())
    const target = profileTarget(probe)
    // 终端里输入 codepal 先找到别处的程序，也算名字被占（后-09 第二种）
    const entry = base.entry === 'ok' && shellProfile.entryShadowed(probe, binDir()) ? 'taken' : base.entry
    // profileIdentity：确认框打开时那个文件的身份（显示路径 + 真实路径 + 链接），点「加入」时带回来核对
    return { ...base, onPath: pathStatus === 'found', entry, pathStatus, shell: shellProfile.shellKind(currentShell()),
      profile: target ? target.display : null, profileIdentity: target ? target.identity : null }
  }
  const terminalView = async (opts) => terminalState(await detect(opts))

  /** 装过命令就跟着配置同步；同步失败不影响本次操作结果 */
  const syncQuietly = () => {
    try { commands.syncCommands() } catch {}
    refreshHubQuietly()
  }

  /** 终端命令状态：写操作后一并带回，页面不用整页重读就能更新「终端命令未安装」那一行 */
  const commandsView = () => {
    try { return terminalState(lastEnv) } catch { return null }
  }

  // 进入页面只读不写；唯一例外是旧版装过命令、从没写过总入口时补上它，补不上照实显示（后-16、后-17）
  ipcMain.handle('models:list', async () => {
    try {
      commands.ensureEntry()
      const cfg = store.readConfig()
      const statuses = store.readStatuses()
      const providers = {}
      for (const id of Object.keys(PRESETS)) providers[id] = providerView(cfg, statuses, id)
      return ok({ claudeCode: claudeInfo(), commands: await terminalView(), providers })
    } catch (err) {
      return bad(err)
    }
  })

  ipcMain.handle('models:setKey', (_e, { providerId, key } = {}) => {
    try {
      store.setKey(providerId, key)
      syncQuietly()
      return ok({ provider: providerView(store.readConfig(), store.readStatuses(), providerId), commands: commandsView() })
    } catch (err) {
      return bad(err)
    }
  })

  ipcMain.handle('models:test', (_e, { providerId, modelId } = {}) => new Promise((resolve) => {
    // 本次调用编号：只认命令行这次写回的结果，旧状态文件不能冒充这次的结果
    const runId = crypto.randomUUID()
    const child = spawn(appExecPath, [cliPath, 'launch', providerId, modelId, '--test'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEPAL_RUN_ID: runId },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000) })
    const guard = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, TEST_GUARD_MS)
    child.on('error', (err) => { clearTimeout(guard); resolve(bad(err)) })
    child.on('close', () => {
      clearTimeout(guard)
      const record = store.readStatuses()[`${providerId}__${modelId}`]
      // 命令行在启动 claude 之前就退出（没找到 Claude Code、没填 Key 等）时没有本次结果，把提示原样带回
      if (!record || record.runId !== runId) {
        resolve({ success: false, data: null, error: { code: 'test_failed', message: stderr.trim().split('\n').pop() || '测试没有完成' } })
        return
      }
      refreshHubQuietly()
      const { runId: _runId, ...lastResult } = record
      // 带上命令状态：测过能用的模型数变了，顶上一行跟着变（后-11）
      resolve(ok({ lastResult, commands: commandsView() }))
    })
  }))

  ipcMain.handle('models:addModel', (_e, { providerId, name } = {}) => {
    try {
      store.addModel(providerId, name)
      syncQuietly()
      return ok({ provider: providerView(store.readConfig(), store.readStatuses(), providerId), commands: commandsView() })
    } catch (err) {
      return bad(err)
    }
  })

  ipcMain.handle('models:updateModel', (_e, { providerId, modelId, patch } = {}) => {
    try {
      const model = withEfforts(providerId, store.updateModel(providerId, modelId, patch || {}))
      syncQuietly()
      return ok({ model, commands: commandsView() })
    } catch (err) {
      return bad(err)
    }
  })

  ipcMain.handle('models:removeModel', (_e, { providerId, modelId } = {}) => {
    try {
      store.removeModel(providerId, modelId)
      syncQuietly()
      return ok({ provider: providerView(store.readConfig(), store.readStatuses(), providerId), commands: commandsView() })
    } catch (err) {
      return bad(err)
    }
  })

  ipcMain.handle('models:recheckClaude', () => {
    claudeCache = null
    refreshHubQuietly()
    return ok(claudeInfo())
  })

  // 安装 / 更新成功后重新判断终端（名字可能被别处的 codepal 挡住）
  ipcMain.handle('models:installCommands', async () => {
    let result
    try {
      result = commands.installCommands({ appExecPath, cliPath })
    } catch (err) {
      return bad(err, { install: true })
    }
    refreshHubQuietly()
    let view = null
    try { view = await terminalView({ force: true }) } catch {}
    return ok({ ...result, commands: view })
  })

  // 加入 PATH（后-13～后-15）：写哪个文件只由这里决定；页面带回它确认时看到的文件，不一样就不写、带回新目标
  ipcMain.handle('models:addToPath', async (_e, { expectedProfile, expectedIdentity } = {}) => {
    try {
      // 点「加入」时按现在的 shell、ZDOTDIR 和链接再算一次，和确认框里的不一样就不写（后-13-例6）
      // 不沿用确认框打开前的判断结果：这里重新判断一次再算（后-13）
      const target = profileTarget(await detect({ force: true }))
      if (!target) throw Object.assign(new Error(UNSUPPORTED_SHELL), { code: 'unsupported_shell' })
      if (expectedProfile !== target.display || (expectedIdentity !== undefined && expectedIdentity !== target.identity)) {
        throw Object.assign(new Error(`要写的文件变成了 ${target.display}，请重新确认`),
          { code: 'target_changed', profile: target.display, identity: target.identity })
      }
      const { added } = shellProfile.addToPath({ target, expectedIdentity })
      const view = await terminalView({ force: true })
      return ok({ profile: target.display, added, pathStatus: view.pathStatus, commands: view })
    } catch (err) {
      return bad(err)
    }
  })

  // 状态目录有变化（命令行写回结果）就推给页面；同一个文件 100 毫秒内的多次变化合并成一次
  let watcher = null
  const timers = new Map()
  try {
    store.ensureDir(store.statusDir())
    watcher = fs.watch(store.statusDir(), (_event, name) => {
      if (!name || !name.endsWith('.json')) return
      clearTimeout(timers.get(name))
      timers.set(name, setTimeout(() => {
        timers.delete(name)
        const key = name.slice(0, -5)
        const lastResult = store.readStatuses()[key]
        refreshHubQuietly()
        const win = getMainWindow && getMainWindow()
        if (!lastResult || !win || (win.isDestroyed && win.isDestroyed())) return
        // 供应商 id 里没有 __，按第一个分隔符拆；模型名本身可以带 __
        const cut = key.indexOf('__')
        if (cut < 0) return
        const providerId = key.slice(0, cut)
        const modelId = key.slice(cut + 2)
        win.webContents.send('models:changed', { providerId, modelId, lastResult, commands: commandsView() })
      }, 100))
    })
  } catch {}

  // Codex 的模型清单、默认模型或登录状态在 CodePal 运行中变了（新增、下架、换档位）：不用打开页面就重新生成审核配置
  // （CL-659、CL-788）。清单常以「写临时文件再改名」替换，按文件名过滤、200 毫秒内的多次变化合并成一次。
  // 系统的目录变化通知偶尔会丢，另外每 2 秒看一次这三个文件的修改时间兜底（文件后来才出现也能看到）
  const CODEX_FILES = ['models_cache.json', 'config.toml', 'auth.json']
  const codexDir = path.join(hubOptions.homeDir || os.homedir(), '.codex')
  let codexWatcher = null
  let codexTimer = null
  const codexChanged = () => {
    clearTimeout(codexTimer)
    codexTimer = setTimeout(() => {
      codexTimer = null
      refreshHubQuietly()
    }, 200)
  }
  try {
    codexWatcher = fs.watch(codexDir, (_event, name) => {
      if (!name || CODEX_FILES.includes(String(name))) codexChanged()
    })
  } catch {
    // 没装 Codex（目录不存在）：靠下面的定时查看，装好后也能发现
  }
  const codexPolled = CODEX_FILES.map((name) => path.join(codexDir, name))
  for (const file of codexPolled) fs.watchFile(file, { interval: 2000 }, codexChanged)

  return {
    stop: () => {
      for (const t of timers.values()) clearTimeout(t)
      if (watcher) watcher.close()
      clearTimeout(codexTimer)
      if (codexWatcher) codexWatcher.close()
      for (const file of codexPolled) fs.unwatchFile(file, codexChanged)
      center.stop()
    },
  }
}

module.exports = { registerModelsHandlers }
