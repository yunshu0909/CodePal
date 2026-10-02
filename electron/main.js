/**
 * Electron 主进程
 *
 * 负责：
 * - 创建和管理应用窗口
 * - 处理 IPC 通信；各领域的 IPC 在 handlers/ 与 modules/ 里注册，这里只组装
 *
 * @module electron/main
 */

const { app, BrowserWindow, ipcMain, dialog, shell, powerMonitor, net, Notification } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const Store = require('electron-store').default
const os = require('os')
const dotenv = require('dotenv')

// V1.7：单实例锁——拒绝同机第二个 CodePal 启动（避免对同一 ~/.codex-switcher/ 并发读写）
// CJS 模块顶层的 `return` 等于早退本模块（Node 把文件包成函数 wrapper），所以后续 require 与 handler 注册不会发生。
// V1.7 P1-8 修复：dev 工作流允许多实例（设 ELECTRON_DEV_ALLOW_MULTI=1）
// 用 app.exit(0) 同步立退而不是 app.quit()（避免后续代码继续跑导致行为未定义）
const v17AllowMulti = !!process.env.ELECTRON_DEV_ALLOW_MULTI
const v17SingleInstanceLock = v17AllowMulti ? true : app.requestSingleInstanceLock()
if (!v17SingleInstanceLock) {
  // 以前这里悄悄退出，开发时正式版开着会以为 npm run dev 坏了
  console.error('[CodePal] 已经有一个 CodePal 在运行，本次启动退出。先退出正在运行的 CodePal；开发时要和它同时开，用 ELECTRON_DEV_ALLOW_MULTI=1 npm run dev')
  app.exit(0)
  // eslint-disable-next-line no-restricted-syntax
  return
}
// 第二实例尝试启动时把窗口聚焦回来（避免用户以为 CodePal 没响应）
// 注：mainWindow 在 line 89 用 let 声明，触发时已出 TDZ；移除多余的 typeof 检查
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed?.()) {
    if (mainWindow.isMinimized?.()) mainWindow.restore()
    mainWindow.focus?.()
  }
})

// 加载环境变量（从 .env 文件）
const ENV_FILE_PATH = path.resolve(__dirname, '..', '.env')
dotenv.config({ path: ENV_FILE_PATH })

const { installAppMenu, applyDevDockIcon } = require('./appMenu')
const { registerAppUpdateHandlers } = require('./handlers/registerAppUpdateHandlers')
const { registerUsageAggregationHandlers } = require('./handlers/registerUsageAggregationHandlers')
const { setDshIsolatedRunner } = require('./services/usageLogScanService')
const { createDshWorkerRunner } = require('./services/dshUsageWorkerClient')
const { registerSkillUsageHandlers } = require('./handlers/registerSkillUsageHandlers')
const { registerSkillControlHandlers } = require('./handlers/registerSkillControlHandlers')
const { registerProjectInitHandlers } = require('./handlers/registerProjectInitHandlers')
const { registerPermissionModeHandlers } = require('./handlers/permissionModeHandlers')
const { registerModelConfigHandlers } = require('./handlers/modelConfigHandlers')
const { registerPricingRegistryHandlers } = require('./handlers/registerPricingRegistryHandlers')
const { registerPlanHandlers, isReservedPlanKey } = require('./ipc/registerPlanHandlers')
const { createPlanStoreService } = require('./services/plan/planStoreService')
const { createPlanDailySummaryService } = require('./services/plan/planDailySummaryService')
const { createSharedUsageStatistics } = require('./services/sharedUsageStatistics')
const { createUsageStatisticsScheduler } = require('./services/usageStatisticsScheduler')
const { configureSharedStatistics } = require('./services/dailySummaryService')
const { createPlanUsageQuery, getEffectivePricing } = require('./services/plan/planUsageService')
const { createPlanPriceOverrideService } = require('./services/plan/planPriceOverrideService')
const { readPlanMetadata } = require('./services/plan/planMetadataService')
const {
  initRemoteConfig,
  refreshRemoteConfigInBackground,
  refreshRemoteConfigNow,
} = require('./services/remoteConfigLoader')
const { modelRegistrySpec } = require('./services/registries/modelRegistry')
const { pricingRegistrySpec } = require('./services/registries/pricingRegistry')
const { registerClaudeUsageStatusHandlers } = require('./handlers/registerClaudeUsageStatusHandlers')
const { registerNetworkDiagnosticsHandlers } = require('./handlers/registerNetworkDiagnosticsHandlers')
const { registerSessionBrowserHandlers } = require('./handlers/registerSessionBrowserHandlers')
const { registerSessionResumeHandlers } = require('./handlers/registerSessionResumeHandlers')
const { registerDocBrowserHandlers } = require('./handlers/registerDocBrowserHandlers')
const { registerSessionStatusHandlers } = require('./handlers/registerSessionStatusHandlers')
const { registerModelsHandlers } = require('./modules/models/ipc')
const { initDocBrowserStore } = require('./services/docBrowserService')
const { initializeIpMonitor, setIpMonitorFastMode, stopIpMonitor } = require('./services/networkDiagnosticsService')
const { createEgressNotifier, withNetworkStyle } = require('./services/egressNotifier')
const { createNavigationBridge } = require('./services/appNavigation')
const { attachNavigationGuard, registerNavigationGuardHandlers } = require('./services/navigationGuardService')
const genericFileGuards = require('./services/genericFileGuards')
const { runLegacyProviderRegistryCleanup } = require('./services/legacyMcpCleanup')
const { createShutdownRegistry } = require('./services/appLifecycle')
const { configureFootprint } = require('./services/footprintRegistry')
const { drainConfigQueue } = require('./services/codexConfigOwner')

const store = new Store()
// 会话状态监听（启动后赋值，退出时停）
let sessionStatus = null
// usageStatistics 在下方创建；earliestFn 只在读取账本时才调用，届时已就绪
const planLedger = createPlanStoreService({ store, metadataFn: readPlanMetadata, earliestFn: id => usageStatistics.getSourceEarliestDate(id) })
const usageStatistics = createSharedUsageStatistics()
configureSharedStatistics(usageStatistics)
// 足迹清单落在 electron-store：记录 CodePal 装进别的工具里的钩子、脚本等
configureFootprint(store)
const planDaily = createPlanDailySummaryService({ statistics: usageStatistics })
const planPriceOverrides = createPlanPriceOverrideService({ store })
const planPricing = () => getEffectivePricing(undefined, undefined, planPriceOverrides.list())
const planService = {
  ...planLedger,
  query: createPlanUsageQuery({ ledger: planLedger, daily: planDaily, pricingFn: planPricing, earliestFn: id => usageStatistics.getSourceEarliestDate(id) }),
  // 一键刷新：拉云端价格并立即生效；found 按刷新后的有效价格（含自填）判断
  refreshPrice: async model => {
    const result = await refreshRemoteConfigNow(pricingRegistrySpec, { getUserDataPath: () => app.getPath('userData') })
    if (!result.success) throw Error(result.error || 'PRICE_REFRESH_FAILED')
    return { found: Boolean(planPricing().models?.[model]) }
  },
  setLocalPrice: async (model, prices) => { planPriceOverrides.set(model, prices); return {} },
  clearLocalPrice: async model => { planPriceOverrides.clear(model); return {} },
}
registerPlanHandlers({ ipcMain, service: planService })
const usageScheduler = createUsageStatisticsScheduler({statistics:usageStatistics,getCycles:async()=>{
  const cycles=[]
  for(const id of ['claude','codex']){const result=await planLedger.read(id);const cycle=result.plan.cycles.at(-1);if(cycle)cycles.push(cycle)}
  return cycles
},onError:()=>console.warn('[usage-statistics] background update failed')})
usageStatistics.subscribe(snapshot=>{
  for(const window of BrowserWindow.getAllWindows()){if(!window.isDestroyed()){try{window.webContents.send('usage-statistics:changed',snapshot)}catch{/* Window may close during a batch. */}}}
})

// 初始化文档查阅服务的 store 引用
initDocBrowserStore(store)

// 防止 EPIPE 错误导致崩溃（开发环境管道断开时）
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})

let mainWindow
// 主进程要求页面切模块（点系统通知后切到网络诊断）；窗口不在时新建并留待页面领取
const navigationBridge = createNavigationBridge({
  getWindow: () => mainWindow,
  createWindow: () => createWindow(),
  app,
})

/**
 * 创建主窗口
 * @returns {BrowserWindow} 创建的窗口实例
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 720,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    // 红绿灯放进侧栏顶部 52 高那一行的正中，和新样式页面的工具栏同一行
    trafficLightPosition: { x: 14, y: 20 },
    // 侧栏透出系统毛玻璃；渲染层 body / .app / 侧栏背景都是透明的
    vibrancy: 'under-window',
  })

  // 全局导航防护：窗口永不离开应用页面，安全外链转系统浏览器
  attachNavigationGuard(mainWindow.webContents, {
    shell,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    // 打包后只放行应用自己的入口页，其他本地 file: 地址一律拒绝
    appEntryPath: path.join(__dirname, '../dist/index.html'),
  })

  // macOS 关闭最后窗口后主进程仍存活；不能只依赖 renderer cleanup 降频。
  // 窗口销毁时强制切回后台 60 秒，但不改变用户的持续监控开关。
  mainWindow.on('closed', () => {
    setIpMonitorFastMode(false)
    mainWindow = null
  })

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(async () => {
  // 应用菜单（「关于 CodePal」走应用内关于窗口）与开发时的 Dock 图标
  installAppMenu({ app, getMainWindow: () => mainWindow })
  applyDevDockIcon(app)

  // 一次性清理旧版本写进 Claude / Codex 配置的 provider_registry MCP（只动确认属于 CodePal 的条目；
  // 保格式、先备份；冲突下次启动再试）。后台执行，不阻塞启动
  runLegacyProviderRegistryCleanup({ homeDir: os.homedir(), store })
    .then((result) => { if (!result.skipped) console.log('[legacy-mcp-cleanup]', JSON.stringify(result)) })
    .catch((error) => console.warn('[legacy-mcp-cleanup] failed:', error?.message || error))

  const appUpdateHandlers = registerAppUpdateHandlers({
    ipcMain,
    app,
    shell,
    getMainWindow: () => mainWindow,
  })

  // 加载所有远程配置（cache > packaged > hardcoded），IPC 就绪前必须完成
  // 每个 registry 独立失败隔离：一个坏不影响其他
  const remoteConfigSpecs = [modelRegistrySpec, pricingRegistrySpec]
  const getUserDataPath = () => app.getPath('userData')

  for (const spec of remoteConfigSpecs) {
    try {
      const initResult = await initRemoteConfig(spec, { getUserDataPath })
      console.log(`[${spec.name}] loaded from ${initResult.source}, version=${initResult.version}`)
    } catch (error) {
      console.warn(`[${spec.name}] init failed:`, error?.message || error)
    }
  }

  registerPricingRegistryHandlers({ ipcMain })

  createWindow()
  // The sampling clock belongs to the app process, including when macOS has no window.
  void usageScheduler.start()

  // 启动后异步后台刷新所有 registry（不阻塞启动；结果下次启动才生效，避免 UI 中途跳变）
  setTimeout(() => {
    for (const spec of remoteConfigSpecs) {
      refreshRemoteConfigInBackground(spec, { getUserDataPath })
        .then((result) => {
          if (result.success) {
            console.log(`[${spec.name}] refreshed from ${result.source}, version=${result.version}`)
          } else {
            console.warn(`[${spec.name}] refresh skipped: ${result.error}`)
          }
        })
        .catch((error) => {
          console.warn(`[${spec.name}] refresh unexpected failure:`, error?.message || error)
        })
    }
  }, 2000)

  // 启动即检查一次新版本，先做提醒式更新，不在应用内直接下载安装。
  appUpdateHandlers.checkForUpdates().catch((error) => {
    console.warn('[app-update] startup check failed:', error?.message || error)
  })

  // 恢复用户明确选择的持续监控；默认关闭时不会发起公网 IP 请求。
  // IP 变了 / 连续测不到时发系统通知，点通知恢复或新建窗口并切到网络诊断。
  const egressNotifier = createEgressNotifier({
    NotificationClass: Notification,
    onClick: () => navigationBridge.requestNavigate('network'),
  })
  // 通知补上右边小图和提示音，和会话状态通知一个样子
  const notifyIconDir = path.join(__dirname, 'assets', 'notify')
  initializeIpMonitor({ store, getWindow: () => mainWindow, notify: (n) => egressNotifier.notify(withNetworkStyle(n, notifyIconDir)) })

  // 会话状态（#41）：默认开着，启动时静默装好钩子并监听状态；完成 / 等你确认时发系统通知，点通知切到会话状态页
  const sessionNotifier = createEgressNotifier({
    NotificationClass: Notification,
    onClick: () => navigationBridge.requestNavigate('session-status'),
  })
  sessionStatus = registerSessionStatusHandlers({ ipcMain, store, getWindow: () => mainWindow, notify: sessionNotifier.notify })
  sessionStatus.start().catch((error) => console.warn('[session-status] start failed:', error?.message || error))

})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出前统一清理：各后台任务都在这里登记，整体最多等 3 秒，卡住的不阻塞退出
const shutdownRegistry = createShutdownRegistry({ timeoutMs: 3000 })
shutdownRegistry.register('usage-scheduler', () => usageScheduler.stop())
shutdownRegistry.register('session-status', () => sessionStatus?.stop())
shutdownRegistry.register('network-monitor', () => stopIpMonitor())
shutdownRegistry.register('dsh-worker', () => dshRunner.dispose())
shutdownRegistry.register('models-watcher', () => modelsHandlers.stop())
// 正在写的 Codex 配置要等写完，不能写到一半被中断
shutdownRegistry.register('codex-config-writes', () => drainConfigQueue())

let shutdownFinished = false
let shutdownPromise = null
app.on('before-quit', (event) => {
  if (shutdownFinished) return
  event.preventDefault()
  // 清理进行中又收到退出请求（连按 ⌘Q）：拦下即可，清理完会统一退出一次
  if (shutdownPromise) return
  shutdownPromise = shutdownRegistry.shutdown()
    .then((report) => {
      const notDone = report.filter((item) => item.status !== 'done')
      if (notDone.length) console.warn('[shutdown] not clean:', JSON.stringify(notDone))
    })
    .finally(() => {
      shutdownFinished = true
      app.quit()
    })
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

/**
 * 将路径中的 ~ 展开为用户主目录
 * @param {string} filepath - 原始路径
 * @returns {string} 展开后的绝对路径
 */
function expandHome(filepath) {
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2))
  }
  return filepath
}

/**
 * 检查路径是否存在
 * @param {string} filepath - 要检查的路径
 * @returns {Promise<boolean>} 是否存在
 */
async function pathExists(filepath) {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

// IPC handlers for data persistence (legacy - for backward compatibility)

/**
 * 获取存储值（兼容旧版本）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} key - 存储键名
 * @returns {any} 存储的值
 */
ipcMain.handle('get-store', (event, key) => {
  // 渲染层只能读写用量目标的两个键（唯一调用方）；其余 store 数据由主进程自己的模块管理
  if (!genericFileGuards.isRendererStoreKey(key)) return undefined
  return store.get(key)
})

/**
 * 设置存储值（兼容旧版本）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} key - 存储键名
 * @param {any} value - 要存储的值
 * @returns {boolean} 是否成功
 */
ipcMain.handle('set-store', (event, key, value) => {
  if (!genericFileGuards.isRendererStoreKey(key) || isReservedPlanKey(key)) return false
  store.set(key, value)
  return true
})

/**
 * 删除存储值（兼容旧版本）
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @param {string} key - 存储键名
 * @returns {boolean} 是否成功
 */
ipcMain.handle('delete-store', (event, key) => {
  if (!genericFileGuards.isRendererStoreKey(key) || isReservedPlanKey(key)) return false
  store.delete(key)
  return true
})

// 选文件夹（新建项目选位置用）

/**
 * 打开文件夹选择对话框
 * @param {Electron.IpcMainInvokeEvent} event - IPC 事件
 * @returns {Promise<{success: boolean, path: string, canceled: boolean, error: string|null}>} 选择结果
 */
ipcMain.handle('select-folder', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择文件夹',
      buttonLabel: '选择'
    })

    if (result.canceled) {
      return { success: true, path: null, canceled: true, error: null }
    }

    return { success: true, path: result.filePaths[0], canceled: false, error: null }
  } catch (error) {
    console.error('Error selecting folder:', error)
    return { success: false, path: null, canceled: false, error: error.message }
  }
})

/**
 * 注册新建项目相关 IPC handlers（模板目录由模块按 config/projectInitConfig 自己找）
 */
registerProjectInitHandlers({
  ipcMain,
  expandHome,
})

// DSH 用量扫描放到独立进程：原生 zstd 解压在本机会因内存状态触发 SIGTRAP，
// 隔离后子进程崩溃不影响主进程，只降级为本次窗口没有 DSH 数据。
const dshRunner = createDshWorkerRunner({ homeDir: os.homedir() })
setDshIsolatedRunner(dshRunner)

registerUsageAggregationHandlers({
  ipcMain,
  homeDir: os.homedir(),
  statistics: usageStatistics,
  nowFn: () => new Date()
})

registerSkillUsageHandlers({
  ipcMain,
  pathExists,
  homeDir: os.homedir(),
})

registerSkillControlHandlers({
  ipcMain,
  homeDir: os.homedir(),
})

/**
 * 注册外链导航防护 IPC handler（open-external-link）
 * 供应商配置 IPC 已断接线隔离（见 _disabled/api-config/），token 不再过渲染层
 */
registerNavigationGuardHandlers({ ipcMain, shell })

/**
 * 注册权限模式（启动模式）相关 IPC handlers
 */
registerPermissionModeHandlers({
  ipcMain,
  pathExists,
  expandHome,
})

/**
 * 注册 V0.16 模型配置与推理等级 IPC handlers
 */
registerModelConfigHandlers({
  ipcMain,
  pathExists,
})

/**
 * 注册 Claude Code 会员额度状态相关 IPC handlers
 */
registerClaudeUsageStatusHandlers({
  ipcMain,
  pathExists,
})

ipcMain.handle('app:consumePendingNavigation', () => navigationBridge.consumePending())

registerNetworkDiagnosticsHandlers({
  ipcMain,
})

registerSessionBrowserHandlers({
  ipcMain,
})

registerSessionResumeHandlers({
  ipcMain,
})

registerDocBrowserHandlers({
  ipcMain,
  getMainWindow: () => mainWindow,
})

// 模型接入（#26）：各家模型以 Claude Code 为外壳被调用；监听调用结果推给页面
const modelsHandlers = registerModelsHandlers({
  ipcMain,
  getMainWindow: () => mainWindow,
})
