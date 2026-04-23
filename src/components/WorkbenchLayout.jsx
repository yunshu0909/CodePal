/**
 * WorkbenchLayout - 工作台布局组件
 *
 * 负责：
 * - macOS 风格的标题栏（红绿灯窗口控制按钮）
 * - 左侧导航侧边栏（技能管理、用量监测、Claude 专属页等）
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
 * @param {'skills'|'mcp'|'usage'|'claude-usage'|'codex-accounts'|'api'|'project-init'|'permission'|'network'|'sessions'|'doc-browser'} props.activeModule - 当前激活的模块
 * @param {function} props.onModuleChange - 模块切换回调函数
 * @param {boolean} props.hasUpdate - 是否有新版本可用
 * @param {function} props.onUpdateClick - 点击更新按钮的回调
 * @returns {React.ReactElement}
 */
function WorkbenchLayout({ children, activeModule, onModuleChange, hasUpdate, onUpdateClick }) {
  /**
   * 分组导航配置
   * 按功能性质分为三组：工具设置 → 用量看板 → 技能中心
   * @type {Array<{label: string, items: Array<{id: string, label: string, icon: string}>}>}
   */
  const navGroups = [
    {
      label: '工具设置',
      items: [
        // 'api' 模块 v1.5.0 起从侧栏隐藏：短期内不使用，代码和路由保留，未来需要时恢复此条即可
        { id: 'permission', label: '启动模式', icon: '🛡️' },
        { id: 'project-init', label: '新建项目', icon: '🚀' },
        { id: 'network', label: '网络诊断', icon: '🌐' }
      ]
    },
    {
      label: '账户与用量',
      items: [
        { id: 'usage', label: '用量监测', icon: '📊' },
        { id: 'claude-usage', label: 'Claude 会员额度', icon: '🪄' },
        { id: 'codex-accounts', label: 'Codex 账户', icon: '⚡' }
      ]
    },
    {
      label: '文档',
      items: [
        { id: 'sessions', label: '对话回顾', icon: '💬' },
        { id: 'doc-browser', label: '文档查阅', icon: '📖' }
      ]
    },
    {
      label: '技能中心',
      items: [
        { id: 'skills', label: 'Skills 管理', icon: '🛠️', beta: true },
        { id: 'mcp', label: 'MCP 管理', icon: '📡', beta: true }
      ]
    }
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

        {/* 品牌区：Logo + 名称 + 副标题 */}
        <div className="sidebar-brand">
          <div className="brand-row">
            <img className="brand-logo" src={brandLogo} alt="CodePal logo" />
            <div className="brand-text">
              <div className="brand-name">CodePal</div>
              <div className="brand-subtitle">AI 编程助手</div>
            </div>
          </div>
        </div>

        {/* 分组导航 */}
        <nav className="sidebar-nav">
          {navGroups.map((group) => (
            <div key={group.label} className="nav-group">
              <div className="nav-group-label">{group.label}</div>
              <div className="nav-group-items">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={`nav-item ${activeModule === item.id ? 'active' : ''}`}
                    onClick={() => handleNavClick(item.id)}
                  >
                    <span className="nav-icon">{item.icon}</span>
                    <span className="nav-label">{item.label}</span>
                    {item.beta && <span className="nav-badge-beta">Beta</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* 底部：更新提醒 + 署名 + 版本号 */}
        <div className="sidebar-footer">
          <div className="footer-content">
            {hasUpdate && (
              <button className="sidebar-update-pill" onClick={onUpdateClick}>
                ⬆ 新版可用
              </button>
            )}
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
