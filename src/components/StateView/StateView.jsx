/**
 * 整块状态视图组件（全局元素「整块状态」，设计总纲 3.18）
 *
 * 负责：
 * - 一整块区域（整个列表、整栏）的 loading / error / empty 三态
 * - loading：16px 转圈 + 「加载中...」（结构已知的加载用骨架，不用这里）
 * - error：红色图标方块 + 「读取失败」+ 原因 + 可选重试
 * - empty：灰色图标方块 + 标题 + 可选一句说明 + 可选按钮
 * - 三态均不满足时渲染 children（正常内容）
 * - 卡内、行内的空和失败不用它，照总纲 3.12 写一句话
 *
 * 使用示例：
 *   <StateView loading={loading} error={error} empty={!data?.length} onRetry={reload}
 *     emptyMessage="还没有 Skill" emptyHint="中央仓库为空，请先导入 skills">
 *     <MyList data={data} />
 *   </StateView>
 *
 * @module components/StateView
 */

import React from 'react'
import Button from '../Button/Button'
import './StateView.css'

// 线形图标（viewBox 0 0 16 16），画在 32px 彩色方块里
const TRAY_ICON = <path d="M2.5 9.5 4.5 3h7l2 6.5v3.5h-11zM2.5 9.5h3.5l.8 1.5h2.4l.8-1.5h3.5" />
const ALERT_ICON = <><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.6M8 11.2v.01" /></>

/**
 * 图标方块
 * @param {string} color - 底色 token
 * @param {React.ReactNode} children - SVG 内容
 */
function StateIcon({ color, children }) {
  return (
    <span className="state-view__icon" style={{ '--c': color }} aria-hidden="true">
      <svg viewBox="0 0 16 16">{children}</svg>
    </span>
  )
}

/**
 * Loading 子视图
 * @param {string} message - 加载提示文案
 */
function LoadingView({ message = '加载中...' }) {
  return (
    <div className="state-view state-view--loading" role="status">
      <span className="state-view__spinner" aria-hidden="true" />
      <p className="state-view__hint">{message}</p>
    </div>
  )
}

/**
 * Error 子视图
 * @param {string} title - 标题，默认「读取失败」
 * @param {string} message - 错误原因
 * @param {() => void} onRetry - 重试回调
 */
function ErrorView({ title = '读取失败', message, onRetry }) {
  return (
    <div className="state-view state-view--error" role="alert">
      <StateIcon color="var(--ic-red)">{ALERT_ICON}</StateIcon>
      <p className="state-view__title">{title}</p>
      {message && <p className="state-view__hint">{message}</p>}
      {onRetry && <Button size="sm" className="state-view__action" onClick={onRetry}>重试</Button>}
    </div>
  )
}

/**
 * Empty 子视图
 * @param {string} message - 标题
 * @param {string} hint - 一句说明（可选）
 * @param {React.ReactNode} icon - 图标 SVG 内容（viewBox 0 0 16 16，可选）
 * @param {React.ReactNode} action - 按钮（可选）
 */
function EmptyView({ message, hint, icon, action }) {
  return (
    <div className="state-view state-view--empty">
      <StateIcon color="var(--ic-gray)">{icon || TRAY_ICON}</StateIcon>
      <p className="state-view__title">{message}</p>
      {hint && <p className="state-view__hint">{hint}</p>}
      {action && <div className="state-view__action">{action}</div>}
    </div>
  )
}

/**
 * 状态视图根组件
 * @param {boolean} loading - 是否加载中
 * @param {string|null} error - 错误原因，非空时展示 Error 态
 * @param {string} errorTitle - 出错标题，默认「读取失败」；页面有更具体的说法时传
 * @param {boolean} empty - 是否空态
 * @param {() => void} onRetry - 重试回调（error 态下显示重试按钮）
 * @param {string} loadingMessage - loading 提示文案
 * @param {string} emptyMessage - 空态标题
 * @param {string} emptyHint - 空态一句说明
 * @param {React.ReactNode} emptyIcon - 空态图标 SVG 内容（viewBox 0 0 16 16）
 * @param {React.ReactNode} emptyAction - 空态按钮
 * @param {React.ReactNode} children - 正常内容
 */
export default function StateView({
  loading,
  error,
  errorTitle,
  empty,
  onRetry,
  loadingMessage,
  emptyMessage = '暂无数据',
  emptyHint,
  emptyIcon,
  emptyAction,
  children,
}) {
  if (loading) return <LoadingView message={loadingMessage} />
  if (error)   return <ErrorView title={errorTitle} message={error} onRetry={onRetry} />
  if (empty)   return <EmptyView message={emptyMessage} hint={emptyHint} icon={emptyIcon} action={emptyAction} />
  return children
}

/** 搜索无结果时可用的放大镜图标 */
export const SEARCH_ICON = <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>
