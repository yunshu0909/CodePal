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
          <div className="state-view__icon">⚠️</div>
          <p className="state-view__message">应用遇到了意外错误</p>
          <p className="state-view__hint" style={{ marginBottom: 16 }}>
            {this.state.error?.message || '未知错误'}
          </p>
          <button className="state-view__retry" onClick={this.handleRetry}>
            重试
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
