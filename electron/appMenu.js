/**
 * 应用菜单与 Dock 图标
 *
 * 负责：
 * - macOS 应用菜单：「关于 CodePal」打开应用内的关于窗口（和点侧栏品牌头同一个），其余沿用系统默认角色
 * - 开发时（未打包）把 Dock 图标换成 CodePal 图标，打包后由 icns 提供
 *
 * @module electron/appMenu
 */

const path = require('path')
const { Menu } = require('electron')

// 开发时 app.name 是包名 skill-manager，菜单里写死产品名
const PRODUCT_NAME = 'CodePal'

/**
 * 安装应用菜单
 * @param {object} deps
 * @param {Electron.App} deps.app
 * @param {() => Electron.BrowserWindow|null} deps.getMainWindow
 */
function installAppMenu({ app, getMainWindow }) {
  // 关于窗口在渲染层画（设计总纲 3.19），菜单只发一个信号过去
  const showAbout = () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    win.show()
    win.webContents.send('app:show-about')
  }

  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: PRODUCT_NAME,
          submenu: [
            { label: `关于 ${PRODUCT_NAME}`, click: showAbout },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    // 编辑菜单保留，否则输入框里的复制粘贴快捷键会失效
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 开发时的 Dock 图标
 * @param {Electron.App} app
 */
function applyDevDockIcon(app) {
  if (app.isPackaged || process.platform !== 'darwin' || !app.dock) return
  try {
    app.dock.setIcon(path.join(__dirname, '../assets/app-icons/icon.png'))
  } catch (error) {
    console.warn('[app-menu] dock icon skipped:', error?.message || error)
  }
}

module.exports = { installAppMenu, applyDevDockIcon }
