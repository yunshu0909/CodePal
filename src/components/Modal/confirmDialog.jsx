/**
 * 确认对话框（全局元素，设计总纲 3.18）
 *
 * 负责：
 * - confirmDialog()：删除、卸载这类不可撤销动作前的唯一确认入口，代替浏览器自带的 confirm
 * - 返回 Promise<boolean>：点动作 = true；点取消、Esc、点压暗处 = false
 * - 每次调用在 body 下临时挂一个宿主，关掉就卸载
 *
 * @module components/Modal/confirmDialog
 */

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Modal from './Modal'
import Button from '../Button/Button'

function ConfirmDialog({ title, description, confirmText, cancelText, danger, onDone }) {
  // 点完先关，再交回结果，避免重复点
  const [open, setOpen] = useState(true)
  const finish = (result) => {
    if (!open) return
    setOpen(false)
    onDone(result)
  }

  return (
    <Modal
      open={open}
      onClose={() => finish(false)}
      title={title}
      description={description}
      size="sm"
      showCloseButton={false}
      footer={(
        <>
          {/* 危险动作默认聚焦取消，回车不会误删 */}
          <Button onClick={() => finish(false)} autoFocus={danger}>{cancelText}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => finish(true)} autoFocus={!danger}>{confirmText}</Button>
        </>
      )}
    />
  )
}

/**
 * 弹确认对话框
 * @param {object} options
 * @param {string} options.title - 一句问话，如「卸载 docs？」
 * @param {string} [options.description] - 一两句后果说明
 * @param {string} [options.confirmText='确定'] - 动作按钮文案（用动词：删除、卸载）
 * @param {string} [options.cancelText='取消']
 * @param {boolean} [options.danger=false] - 危险动作：按钮红字，默认聚焦取消
 * @returns {Promise<boolean>} 是否确认
 */
export function confirmDialog({ title, description, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement('div')
    el.className = 'confirm-dialog-host'
    document.body.appendChild(el)
    const root = createRoot(el)
    const onDone = (result) => {
      resolve(result)
      // 等本次点击的事件处理完再卸载
      setTimeout(() => {
        root.unmount()
        el.remove()
      }, 0)
    }
    root.render(
      <ConfirmDialog
        title={title}
        description={description}
        confirmText={confirmText}
        cancelText={cancelText}
        danger={danger}
        onDone={onDone}
      />
    )
  })
}

export default confirmDialog
