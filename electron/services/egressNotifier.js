/**
 * 出口 IP 系统通知
 *
 * 负责：
 * - 用 Electron 自带 Notification 发出口 IP 相关的系统通知
 * - 通知对象保留到点击或关闭为止：被垃圾回收后 macOS 上的点击事件会丢失（09-19 实测）
 * - 点击时回调（由 main 负责恢复 / 新建窗口并切到网络诊断）
 *
 * @module electron/services/egressNotifier
 */

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

module.exports = { createEgressNotifier }
