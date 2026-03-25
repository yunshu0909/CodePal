/**
 * WorkbenchLayout - 工作台布局组件
 *
 * 负责：
 * - macOS 风格的标题栏（红绿灯窗口控制按钮）
 * - 左侧导航侧边栏（技能管理、用量监测）
 * - 模块切换状态管理
 * - 内容区域渲染
 * - 底部版本更新提醒（Pill 胶囊按钮）
 *
 * @module components/WorkbenchLayout
 */

import React from 'react'
import '../styles/workbench.css'
import pkg from '../../package.json'
import brandLogo from '../assets/codepal-logo.png'

/**
 * 工作台布局组件
 * @param {Object} props
 * @param {React.ReactNode} props.children - 内容区域要渲染的子元素
 * @param {'skills'|'mcp'|'usage'|'api'|'project-init'|'permission'} props.activeModule - 当前激活的模块
 * @param {function} props.onModuleChange - 模块切换回调函数
 * @param {boolean} props.hasUpdate - 是否有新版本可用
 * @param {function} props.onUpdateClick - 点击更新按钮的回调
 * @returns {React.ReactElement}
 */
function WorkbenchLayout({ children, activeModule, onModuleChange, hasUpdate, onUpdateClick }) {
  /**
   * 导航项配置
   * @type {Array<{id: string, label: string, icon: string}>}
   */
  const navItems = [
    { id: 'skills', label: 'Skills 管理', icon: '🛠️' },
    { id: 'mcp', label: 'MCP 管理', icon: '📡' },
    { id: 'project-init', label: '新建项目', icon: '🚀' },
    { id: 'claude-code', label: '环境检查', icon: '💻' },
    { id: 'usage', label: '用量监测', icon: '📊' },
    { id: 'api', label: 'API 配置', icon: '🔌' },
    { id: 'permission', label: '启动模式', icon: '🛡️' }
  ]

  /**
   * 处理导航项点击
   * @param {string} moduleId - 模块 ID
   */
  const handleNavClick = (moduleId) => {
    if (moduleId !== activeModule && onModuleChange) {
      onModuleChange(moduleId)
    }
  }

  return (
    <div className="workbench-layout">
      {/* 左侧边栏：全高，从标题栏到底部 */}
      <aside className="sidebar">
        {/* 标题栏区域：与 macOS 红绿灯同层，可拖拽 */}
        <div className="sidebar-titlebar" />

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${activeModule === item.id ? 'active' : ''}`}
              onClick={() => handleNavClick(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>

        {/* 底部署名区 */}
        <div className="sidebar-footer">
          <div className="footer-content">
            {/* 有新版本时显示 Pill 胶囊按钮 */}
            {hasUpdate && (
              <button className="sidebar-update-pill" onClick={onUpdateClick}>
                ⬆ 新版可用
              </button>
            )}
            <img className="footer-logo" src={brandLogo} alt="CodePal logo" />
            <div className="footer-line1">
              <span className="footer-brand">CodePal</span>
              <span className="footer-by">by</span>
              <span className="footer-author">云舒</span>
            </div>
            <div className="footer-line2">
              <span className="footer-version">v{pkg.version}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* 右侧内容区 */}
      <div className="content-column">
        {/* 顶部占位条：为 macOS 原生标题栏预留拖拽区域 */}
        <div className="title-spacer" />
        <main className="content-area">
          {children}
        </main>
      </div>
    </div>
  )
}

export default WorkbenchLayout
