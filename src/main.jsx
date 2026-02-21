/**
 * React 应用入口
 *
 * 负责：
 * - 创建 React 根节点
 * - 渲染 App 组件
 * - 启用 StrictMode
 *
 * @module main
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/design-tokens.css'
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
