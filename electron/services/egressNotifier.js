/**
 * 出口 IP 系统通知
 *
 * 负责：
 * - 用 Electron 自带 Notification 发出口 IP 相关的系统通知
 * - 通知对象保留到点击或关闭为止：被垃圾回收后 macOS 上的点击事件会丢失（09-19 实测）
 * - 点击时回调（由 main 负责恢复 / 新建窗口并切到网络诊断）
 * - 网络诊断通知的右边小图与提示音（和会话状态通知同一个样子，见 withNetworkStyle）
 *
 * @module electron/services/egressNotifier
 */

const path = require('path')

/**
 * 创建通知发送器
 * @param {object} deps
 * @param {typeof import('electron').Notification} deps.NotificationClass - Electron Notification（测试注入假类）
 * @param {() => void} deps.onClick - 点击通知后的动作
 * @returns {{notify: (payload: {title: string, body: string}) => void, pendingCount: () => number}}
 */
function createEgressNotifier({ NotificationClass, onClick }) {
  const pending = new Set()

  function notify({ title, body, icon, sound }) {
    if (!NotificationClass || (typeof NotificationClass.isSupported === 'function' && !NotificationClass.isSupported())) return
    // icon / sound 可选：会话状态用右边彩色小图 + 两种提示音区分完成与等你确认
    const notification = new NotificationClass({ title, body, ...(icon ? { icon } : {}), ...(sound ? { sound } : {}) })
    pending.add(notification)
    notification.on('click', () => {
      pending.delete(notification)
      onClick?.()
    })
    notification.on('close', () => pending.delete(notification))
    notification.show()
  }

  return { notify, pendingCount: () => pending.size }
}

// 网络诊断通知与会话状态通知同一个样子：右边一张实心圆小图 + 各自的提示音
// IP 变了 = 橙（发现变化，要留意但没坏）；测不到 = 红（出问题了）
const NETWORK_NOTIFY_STYLE = {
  changed: { icon: 'net-changed.png', sound: 'Pop' },
  unreachable: { icon: 'net-fail.png', sound: 'Basso' },
}

/**
 * 给网络诊断的通知补上小图和提示音
 * @param {{kind: string, title: string, body: string}} notification
 * @param {string} iconDir - electron/assets/notify
 * @returns {{kind: string, title: string, body: string, icon?: string, sound?: string}}
 */
function withNetworkStyle(notification, iconDir) {
  const style = NETWORK_NOTIFY_STYLE[notification?.kind]
  if (!style) return notification
  return { ...notification, icon: path.join(iconDir, style.icon), sound: style.sound }
}

module.exports = { createEgressNotifier, withNetworkStyle, NETWORK_NOTIFY_STYLE }
