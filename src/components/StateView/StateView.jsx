/**
 * 页面状态视图组件
 *
 * 负责：
 * - 统一处理 loading / error / empty 三态 UI
 * - loading：蓝色 spinner + 可选提示文案
 * - error：警告图标 + 错误信息 + 可选重试按钮
 * - empty：占位图标 + 主说明 + 可选次提示
 * - 三态均不满足时渲染 children（正常内容）
 *
 * 使用示例：
 *   <StateView loading={loading} error={error} empty={!data?.length} onRetry={reload}>
 *     <MyList data={data} />
 *   </StateView>
 *
 * @module components/StateView
 */

import React from 'react'
import './StateView.css'

/**
 * Loading 子视图
 * @param {string} message - 加载提示文案
 */
function LoadingView({ message = '加载中...' }) {
  return (
    <div className="state-view state-view--loading">
      <div className="state-view__spinner" aria-label="加载中" />
      <p className="state-view__message">{message}</p>
    </div>
  )
}

/**
 * Error 子视图
 * @param {string} message - 错误信息
 * @param {() => void} onRetry - 重试回调
 */
function ErrorView({ message, onRetry }) {
  return (
    <div className="state-view state-view--error">
      <div className="state-view__icon">⚠️</div>
      <p className="state-view__message">{message}</p>
      {onRetry && (
        <button className="state-view__retry" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

/**
 * Empty 子视图
 * @param {string} message - 主说明
 * @param {string} hint - 次提示（可选）
 * @param {string} icon - 占位图标（可选）
 */
function EmptyView({ message, hint, icon = '📭' }) {
  return (
    <div className="state-view state-view--empty">
      <div className="state-view__icon">{icon}</div>
      <p className="state-view__message">{message}</p>
      {hint && <p className="state-view__hint">{hint}</p>}
    </div>
  )
}

/**
 * 状态视图根组件
 * @param {boolean} loading - 是否加载中
 * @param {string|null} error - 错误信息，非空时展示 Error 态
 * @param {boolean} empty - 是否空态
 * @param {() => void} onRetry - 重试回调（error 态下显示重试按钮）
 * @param {string} loadingMessage - loading 提示文案
 * @param {string} emptyMessage - 空态主说明
 * @param {string} emptyHint - 空态次提示
 * @param {string} emptyIcon - 空态占位图标
 * @param {React.ReactNode} children - 正常内容
 */
export default function StateView({
  loading,
  error,
  empty,
  onRetry,
  loadingMessage,
  emptyMessage = '暂无数据',
  emptyHint,
  emptyIcon,
  children,
}) {
  if (loading) return <LoadingView message={loadingMessage} />
  if (error)   return <ErrorView message={error} onRetry={onRetry} />
  if (empty)   return <EmptyView message={emptyMessage} hint={emptyHint} icon={emptyIcon} />
  return children
}
