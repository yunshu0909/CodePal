/**
 * 全局错误边界组件
 *
 * 负责：
 * - 捕获子组件树中的渲染异常，防止整个应用白屏
 * - 展示友好的错误提示 UI，支持重试恢复
 * - 记录错误日志到 console
 *
 * @module components/ErrorBoundary
 */

import React from 'react'
import Button from './Button/Button'
import './StateView/StateView.css'

/**
 * React Error Boundary（必须用 class 组件实现）
 *
 * 用法：
 *   <ErrorBoundary>
 *     <App />
 *   </ErrorBoundary>
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Uncaught render error:', error, errorInfo)
  }

  /**
   * 重置错误状态，重新渲染子组件树
   */
  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="state-view state-view--error">
          <span className="state-view__icon" style={{ '--c': 'var(--ic-red)' }} aria-hidden="true">
            <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.6M8 11.2v.01" /></svg>
          </span>
          <p className="state-view__title">应用遇到了意外错误</p>
          <p className="state-view__hint">{this.state.error?.message || '未知错误'}</p>
          <Button size="sm" className="state-view__action" onClick={this.handleRetry}>重试</Button>
        </div>
      )
    }

    return this.props.children
  }
}
