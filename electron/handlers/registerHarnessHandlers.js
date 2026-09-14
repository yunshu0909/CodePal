/**
 * Harness 管理 IPC 注册器
 *
 * 约定与其余 register*Handlers 一致：恒返回 `{success, data?, error}`，
 * 永不向渲染层抛异常，错误只回传白名单错误码。
 *
 * @module electron/handlers/registerHarnessHandlers
 */

const {
  getHarnessSnapshot,
  installHarness,
  uninstallHarness,
  startHarness,
  stopHarness,
  restartHarness,
  listAvailableVersions,
  setStopOnQuitPreference,
  updateHarness,
} = require('../services/harnessLifecycleService')
const { setKeepAlive } = require('../services/launchdService')

/**
 * 注册 Harness 管理相关 IPC handlers。
 * @param {{ipcMain: object, homeDir: string, sourceDir?: string|null}} context 主进程上下文
 * @param {object} deps 测试注入依赖
 */
function registerHarnessHandlers({ ipcMain, homeDir, sourceDir }, deps = {}) {
  const snapshot = deps.getHarnessSnapshotFn || getHarnessSnapshot
  const install = deps.installHarnessFn || installHarness
  const uninstall = deps.uninstallHarnessFn || uninstallHarness
  const start = deps.startHarnessFn || startHarness
  const stop = deps.stopHarnessFn || stopHarness
  const restart = deps.restartHarnessFn || restartHarness
  const versions = deps.listAvailableVersionsFn || listAvailableVersions
  const update = deps.updateHarnessFn || updateHarness
  const base = { homeDir, sourceDir: sourceDir || deps.sourceDir || null }

  ipcMain.handle('harness:get-snapshot', async () => {
    try {
      return { success: true, data: await snapshot(base, deps), error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_UNKNOWN_ERROR' }
    }
  })

  ipcMain.handle('harness:list-versions', async () => {
    try {
      return { success: true, data: await versions(base, deps), error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_NPM_FAILED' }
    }
  })

  ipcMain.handle('harness:install', async (_event, params) => {
    try {
      const data = await install({ ...base, channel: params?.channel, force: params?.force === true }, deps)
      return { success: true, data: { ...data, snapshot: await snapshot(base, deps) }, error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_NPM_FAILED' }
    }
  })

  ipcMain.handle('harness:uninstall', async (_event, params) => {
    try {
      const data = await uninstall({ ...base, purgeData: params?.purgeData === true }, deps)
      return { success: true, data: { ...data, snapshot: await snapshot(base, deps) }, error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_UNKNOWN_ERROR' }
    }
  })

  ipcMain.handle('harness:start', async () => {
    try {
      const data = await start(base, deps)
      return { success: true, data: { ...data, snapshot: await snapshot(base, deps) }, error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_SPAWN_FAILED' }
    }
  })

  ipcMain.handle('harness:stop', async () => {
    try {
      const data = await stop(base, deps)
      return { success: true, data: { ...data, snapshot: await snapshot(base, deps) }, error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_NOT_RUNNING' }
    }
  })

  ipcMain.handle('harness:restart', async () => {
    try {
      const data = await restart(base, deps)
      return { success: true, data: { ...data, snapshot: await snapshot(base, deps) }, error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_SPAWN_FAILED' }
    }
  })

  /**
   * 更新：托管安装走 npm 换版本，源码目录走 git pull + 构建。
   * 页面只有一个按钮，执行者由服务按安装形态决定。
   */
  ipcMain.handle('harness:update', async (_event, params) => {
    try {
      const data = await update({
        ...base,
        channel: params?.channel,
        takeover: params?.takeover === true,
      }, deps)
      return { success: true, data: { ...data, snapshot: await snapshot(base, deps) }, error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_UNKNOWN_ERROR' }
    }
  })

  ipcMain.handle('harness:set-stop-on-quit', async (_event, params) => {
    try {
      const enabled = setStopOnQuitPreference(params?.enabled, deps)
      return { success: true, data: { stopOnQuit: enabled }, error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_UNKNOWN_ERROR' }
    }
  })

  /**
   * 开/关「崩溃自动重启」。仅当本机由 launchd 托管 dsh 时可用——
   * 走 launchd 而不是 CodePal 自己记状态，这样开关语义与系统一致。
   */
  ipcMain.handle('harness:set-keepalive', async (_event, params) => {
    try {
      const data = await setKeepAlive({ ...base, enabled: params?.enabled === true }, deps)
      return { success: true, data: { ...data, snapshot: await snapshot(base, deps) }, error: null }
    } catch (error) {
      return { success: false, data: null, error: error?.code || 'HARNESS_UNKNOWN_ERROR' }
    }
  })
}

module.exports = { registerHarnessHandlers }
