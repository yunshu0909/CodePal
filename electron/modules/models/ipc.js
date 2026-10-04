/**
 * 第三方模型接入 · 主进程接口（models:*）
 *
 * 负责：
 * - 通道：models:list / setKey / test / addModel / updateModel / removeModel / recheckClaude / installCommands
 *   models:hubList / hubSetEnabled / hubSetEffort（汇总设置与公开审核清单）
 * - 统一返回 { success, data, error: { code, message } }；渲染层只传 ID，永远拿不到 Key 原文
 * - 「测一下」起一个命令行子进程（和审核走同一个入口），结束后读回状态文件
 * - 监听 status/ 目录：命令行（含 dev-workflow 审核）写回结果时推 models:changed 给页面
 * - 装过命令后，加模型 / 改名 / 移除 / 存 Key 时同步终端命令
 *
 * @module electron/modules/models/ipc
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const store = require('./store')
const { createModelHub } = require('./hub')
const commands = require('./commands')
const { PRESETS } = require('./presets')
const { locateClaude, checkClaudeVersion, MIN_CLAUDE_VERSION } = require('./claudeCli')

const WRITE_DENIED = '配置目录没有写入权限，检查权限后重试'
const INSTALL_DENIED = '安装失败：~/.local/bin 没有写入权限，检查权限后重试'
const BUSINESS_CODES = new Set(['invalid_input', 'duplicate', 'not_found', 'read_failed', 'occupied', 'reserved_flag'])
// 「测一下」的外层兜底：命令行自己 60 秒超时，这里再多给 15 秒收尾
const TEST_GUARD_MS = 75000

/** 打包后 cli.cjs 在 app.asar.unpacked 里，命令行要能直接读到文件 */
function defaultCliPath() {
  return path.join(__dirname, 'cli.cjs').replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked')
}

/** 登录 shell 的 PATH（Finder 启动的 CodePal 拿不到用户终端的 PATH），只取一次 */
let loginPathCache = null
function defaultLoginPath() {
  if (loginPathCache === null) {
    try {
      const r = spawnSync('/bin/bash', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 })
      loginPathCache = r.status === 0 ? r.stdout : (process.env.PATH || '')
    } catch {
      loginPathCache = process.env.PATH || ''
    }
  }
  return loginPathCache
}

/** 把异常翻成接口错误 */
function toError(err, { install = false } = {}) {
  if (err && BUSINESS_CODES.has(err.code)) return { code: err.code, message: err.message }
  if (err && ['EACCES', 'EPERM', 'EROFS'].includes(err.code)) return { code: 'write_denied', message: install ? INSTALL_DENIED : WRITE_DENIED }
  return { code: 'unknown', message: (err && err.message) || '出错了' }
}

const ok = (data) => ({ success: true, data, error: null })
const bad = (err, opts) => ({ success: false, data: null, error: toError(err, opts) })

/** 某家给页面看的数据（不含 Key） */
function providerView(cfg, statuses, providerId) {
  const prov = cfg.providers[providerId]
  if (!prov) return { keySet: false, keyReadable: false, models: [] }
  const { keySet, keyReadable } = store.keyState(providerId)
  return {
    keySet,
    keyReadable,
    models: prov.models.map((m) => ({ ...m, lastResult: statuses[`${providerId}__${m.id}`] || null })),
  }
}

/**
 * 注册 models:* 通道
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {() => import('electron').BrowserWindow|null} deps.getMainWindow
 * @param {string} [deps.cliPath] - 命令行脚本路径（默认本目录的 cli.cjs，打包后换成 unpacked 路径）
 * @param {string} [deps.appExecPath] - 用来跑命令行的可执行文件（默认 process.execPath，即 CodePal 本身）
 * @param {() => string} [deps.loginPath] - 判断命令目录在不在 PATH 用
 * @returns {{stop: () => void}}
 */
function registerModelsHandlers({ ipcMain, getMainWindow, cliPath = defaultCliPath(), appExecPath = process.execPath, loginPath = defaultLoginPath, hubOptions = {} }) {
  const hub = createModelHub(hubOptions)
  const refreshHubQuietly = () => {
    try {
      hub.refresh()
    } catch {
      // 启动和外部状态刷新失败由下一次显式读取报告，不阻止接入管理启动。
    }
  }
  const hubError = (error) => {
    if (error.code === 'HUB_FILE_INVALID') return { success: false, data: null, error: { code: error.code, message: error.message } }
    const translated = toError(error)
    if (translated.code === 'unknown') translated.message = '出错了'
    return { success: false, data: null, error: translated }
  }
  const hubChannels = [
    ['models:hubList', () => hub.list()],
    ['models:hubSetEnabled', (payload) => hub.setEnabled(payload)],
    ['models:hubSetEffort', (payload) => hub.setEffort(payload)],
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
  // First-use preferences and the review snapshot exist from startup, even without opening the page.
  refreshHubQuietly()
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

  /** 装过命令就跟着配置同步；同步失败不影响本次操作结果 */
  const syncQuietly = () => {
    try { commands.syncCommands() } catch {}
    refreshHubQuietly()
  }

  /** 终端命令状态：写操作后一并带回，页面不用整页重读就能更新「终端命令未安装」那一行 */
  const commandsView = () => {
    try { return commands.commandsState({ pathEnv: loginPath() }) } catch { return null }
  }

  ipcMain.handle('models:list', () => {
    try {
      const cfg = store.readConfig()
      const statuses = store.readStatuses()
      const providers = {}
      for (const id of Object.keys(PRESETS)) providers[id] = providerView(cfg, statuses, id)
      return ok({ claudeCode: claudeInfo(), commands: commands.commandsState({ pathEnv: loginPath() }), providers })
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
      resolve(ok({ lastResult }))
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
      const model = store.updateModel(providerId, modelId, patch || {})
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

  ipcMain.handle('models:installCommands', () => {
    try {
      const result = commands.installCommands({ appExecPath, cliPath })
      refreshHubQuietly()
      return ok(result)
    } catch (err) {
      return bad(err, { install: true })
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
        win.webContents.send('models:changed', { providerId, modelId, lastResult })
      }, 100))
    })
  } catch {}

  return {
    stop: () => {
      for (const t of timers.values()) clearTimeout(t)
      if (watcher) watcher.close()
    },
  }
}

module.exports = { registerModelsHandlers }
