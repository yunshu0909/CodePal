/**
 * 窗口导航防护服务
 *
 * 负责：
 * - 判定外链 URL 是否允许交给系统浏览器打开（协议白名单）
 * - 给 BrowserWindow.webContents 挂全局导航拦截（will-navigate / setWindowOpenHandler）
 * - 注册 open-external-link IPC：渲染层唯一合法的外链出口
 *
 * 背景：渲染层会展示外部内容（Markdown 文档、会话记录），未拦截时
 * 恶意链接可把当前窗口导航到远程页面。策略：应用窗口永不离开自身页面，
 * 安全外链一律转交系统浏览器（shell.openExternal）。
 *
 * @module electron/services/navigationGuardService
 */

const path = require('path')
const { fileURLToPath } = require('url')

/** 允许转交系统浏览器的协议白名单 */
const SAFE_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

/**
 * 判定 URL 是否为可安全外开的链接
 * 解析失败、file: / javascript: 等一律拒绝
 * @param {unknown} url - 待判定的 URL
 * @returns {boolean}
 */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)
}

/**
 * 判定导航目标是否属于应用自身页面（dev server 同源 / 打包后的应用入口页）
 * @param {string} url - 导航目标
 * @param {string|undefined} devServerUrl - VITE_DEV_SERVER_URL（dev 模式）
 * @param {string|undefined} appEntryPath - 打包后应用入口页的绝对路径；不传则 file: 一律不放行
 * @returns {boolean}
 */
function isAppInternalUrl(url, devServerUrl, appEntryPath) {
  try {
    const target = new URL(url)
    if (devServerUrl) {
      const dev = new URL(devServerUrl)
      if (target.origin === dev.origin) return true
    }
    // 打包模式：只有应用自己的入口页算自身页面；其他本地文件（如下载的 html）不能把窗口带走
    if (!devServerUrl && appEntryPath && target.protocol === 'file:') {
      return path.resolve(fileURLToPath(target)) === path.resolve(appEntryPath)
    }
    return false
  } catch {
    return false
  }
}

/**
 * 给窗口 webContents 挂导航防护
 * - will-navigate：目标非应用自身页面一律 preventDefault，安全外链转系统浏览器
 * - setWindowOpenHandler：一律 deny（不开新 Electron 窗口），安全外链转系统浏览器
 * @param {Electron.WebContents} webContents - 主窗口 webContents
 * @param {Object} deps - 依赖注入
 * @param {{openExternal: (url: string) => Promise<void>}} deps.shell - Electron shell
 * @param {string} [deps.devServerUrl] - dev 模式的 Vite server 地址（同源放行）
 * @param {string} [deps.appEntryPath] - 打包后应用入口页的绝对路径（唯一放行的 file: 地址）
 * @returns {void}
 */
function attachNavigationGuard(webContents, { shell, devServerUrl, appEntryPath } = {}) {
  webContents.on('will-navigate', (event, url) => {
    if (isAppInternalUrl(url, devServerUrl, appEntryPath)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(() => {})
    }
  })

  webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })
}

/**
 * 注册外链打开 IPC handler（渲染层唯一合法外链出口）
 * @param {Object} deps - 依赖注入
 * @param {import('electron').IpcMain} deps.ipcMain - Electron ipcMain
 * @param {{openExternal: (url: string) => Promise<void>}} deps.shell - Electron shell
 * @returns {void}
 */
function registerNavigationGuardHandlers({ ipcMain, shell }) {
  ipcMain.handle('open-external-link', async (event, url) => {
    if (!isSafeExternalUrl(url)) {
      return { success: false, errorCode: 'BLOCKED_URL', error: '链接协议不在白名单内' }
    }
    try {
      await shell.openExternal(url)
      return { success: true, errorCode: null, error: null }
    } catch (error) {
      return { success: false, errorCode: 'OPEN_FAILED', error: error.message || '打开外链失败' }
    }
  })
}

module.exports = {
  isSafeExternalUrl,
  isAppInternalUrl,
  attachNavigationGuard,
  registerNavigationGuardHandlers,
}
