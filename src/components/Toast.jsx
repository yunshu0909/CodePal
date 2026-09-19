/**
 * Toast 全局提示（全局元素，设计总纲 3.18）
 *
 * 负责：
 * - 全局唯一入口 toast.success / error / warning / info：页面只说弹什么，不存状态、不摆组件
 * - 同时只显示一条，新的顶掉旧的；同一句话连弹两次也会重新出现
 * - 第一次弹时自动在 body 下挂宿主，不依赖页面结构（单独渲染页面的测试里也能看到）
 *
 * 样子：浅色胶囊，颜色只在左边小圆点上（成功绿、失败红、提醒橙、普通灰）
 *
 * @module components/Toast
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import './Toast.css'

// 成功短、提醒 / 失败长，给人读完原因的时间
const DURATION_BY_TYPE = { success: 2000, info: 3000, warning: 4000, error: 4000 }
// 淡出动画时长，结束后才真正移除
const LEAVE_MS = 200

const ICONS = {
  success: <path d="M2.2 5.2 4.2 7.2 7.8 3" />,
  error: <path d="M5 2.5v3M5 7.6v.01" />,
  warning: <path d="M5 2.5v3M5 7.6v.01" />,
  info: <path d="M5 4.6v3M5 2.4v.01" />,
}

let current = null // 正在显示的一条 { id, message, type }
let seq = 0 // 每次弹都换新 id，同文案也会重新出现
const listeners = new Set()
let host = null

function emit() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return current
}

// 宿主只挂一次；放在 body 下，所以页面切换、keep-alive 隐藏都不影响
function ensureHost() {
  if (host || typeof document === 'undefined') return
  const el = document.createElement('div')
  el.className = 'toast-host'
  document.body.appendChild(el)
  const root = createRoot(el)
  root.render(<ToastHost />)
  host = { el, root }
}

/**
 * 弹一条提示，顶掉正在显示的那条
 * @param {string} message - 提示文案
 * @param {'success'|'error'|'warning'|'info'} [type='info']
 */
function show(message, type = 'info') {
  if (!message) return
  current = { id: ++seq, message: String(message), type: DURATION_BY_TYPE[type] ? type : 'info' }
  ensureHost()
  emit()
}

/**
 * 收起提示；传 id 时只收起那一条（避免旧计时器收掉新提示）
 * @param {number} [id]
 */
function dismiss(id) {
  if (!current || (id !== undefined && current.id !== id)) return
  current = null
  emit()
}

export const toast = {
  show,
  success: (message) => show(message, 'success'),
  error: (message) => show(message, 'error'),
  warning: (message) => show(message, 'warning'),
  info: (message) => show(message, 'info'),
  dismiss,
}

/**
 * 给「回调传对象」的旧接口用：notifyToast({ message, type })，传 null 不做事
 * @param {{message: string, type?: string}|null} item
 */
export function notifyToast(item) {
  if (item) show(item.message, item.type)
}

/**
 * 测试用：清掉提示并卸载宿主，避免上一个用例的提示留到下一个
 */
export function resetToastForTests() {
  current = null
  if (host) {
    host.root.unmount()
    host.el.remove()
    host = null
  }
}

function ToastHost() {
  const item = useSyncExternalStore(subscribe, getSnapshot)
  if (!item) return null
  return <ToastItem key={item.id} {...item} />
}

function ToastItem({ id, message, type }) {
  // 挂载后下一帧再加 show，才有淡入
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const duration = DURATION_BY_TYPE[type]
    const frame = requestAnimationFrame(() => setVisible(true))
    const leave = setTimeout(() => setVisible(false), duration)
    const remove = setTimeout(() => dismiss(id), duration + LEAVE_MS)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(leave)
      clearTimeout(remove)
    }
  }, [id, type])

  return (
    <div className={`toast toast--${type}${visible ? ' show' : ''}`} role={type === 'error' ? 'alert' : 'status'}>
      <span className="toast__icon" aria-hidden="true">
        <svg viewBox="0 0 10 10">{ICONS[type]}</svg>
      </span>
      <span className="toast__message">{message}</span>
    </div>
  )
}
