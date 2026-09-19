/**
 * WorkbenchLayout - 工作台布局组件（Native+ 窗口外壳）
 *
 * 负责：
 * - 左侧导航侧边栏：顶部 52 高留给 macOS 红绿灯，下面分组导航，底部品牌 + 版本 + 新版提示
 * - macOS 上侧栏透出系统毛玻璃（主进程 vibrancy），其他平台退成纯灰底
 * - 模块切换与内容区渲染；新样式页面的 52 高工具栏由 PageShell native 提供，和红绿灯同一行
 * - 规则见 docs/design-operating-system.md 3.10「窗口外壳」
 *
 * @module components/WorkbenchLayout
 */

import React from 'react'
import '../styles/workbench.css'
import pkg from '../../package.json'
import brandLogo from '../assets/codepal-logo.png'
import { SIDEBAR_ICONS } from './sidebarIcons'

// 只有 macOS 有系统毛玻璃；其他平台侧栏用纯灰底
const IS_MAC = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent)

/**
 * 工作台布局组件
 * @param {Object} props
 * @param {React.ReactNode} props.children - 内容区域要渲染的子元素
 * @param {'skills'|'mcp'|'usage'|'claude-usage'|'api'|'project-init'|'permission'|'network'|'k28-status-light'|'sessions'|'doc-browser'} props.activeModule - 当前激活的模块
 * @param {function} props.onModuleChange - 模块切换回调函数
 * @param {boolean} props.hasUpdate - 是否有新版本可用
 * @param {function} props.onUpdateClick - 点击更新按钮的回调
 * @returns {React.ReactElement}
 */
function WorkbenchLayout({ children, activeModule, onModuleChange, hasUpdate, onUpdateClick }) {
  /**
   * 分组导航配置
   * 按功能性质分为三组：工具设置 → 用量看板 → 技能中心
   * 图标见 sidebarIcons.js（按模块 ID 取）
   * @type {Array<{label: string, items: Array<{id: string, label: string, beta?: boolean}>}>}
   */
  const navGroups = [
    {
      label: '工具设置',
      items: [
        // 'api' 供应商切换模块已断接线隔离（v1.9.8），代码在 _disabled/api-config/，恢复步骤见其 README
        { id: 'permission', label: 'Claude Code 设置' },
        { id: 'project-init', label: '新建项目' },
        { id: 'network', label: '网络诊断' },
        { id: 'k28-status-light', label: '状态灯' }
      ]
    },
    {
      label: '账户与用量',
      items: [
        { id: 'usage', label: '用量监测' },
        { id: 'claude-usage', label: '订阅管理' }
      ]
    },
    {
      label: '文档',
      items: [
        { id: 'sessions', label: '对话回顾' },
        { id: 'doc-browser', label: '文档查阅' }
      ]
    },
    {
      label: '技能中心',
      items: [
        { id: 'skills', label: 'Skills 管理', beta: true },
        { id: 'plugins', label: 'Plugins 管理', beta: true }
        // 'mcp' 模块从侧栏隐藏：短期内不使用，代码和路由保留，未来需要时恢复此条即可
        // { id: 'mcp', label: 'MCP 管理', beta: true }
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
    <div className={`workbench-layout${IS_MAC ? ' is-mac' : ''}`}>
      {/* 左侧边栏：全高；macOS 上透出系统毛玻璃 */}
      <aside className="sidebar">
        {/* 红绿灯那一行：52 高，和新样式页面的工具栏同一行，可拖拽窗口 */}
        <div className="sidebar-titlebar" />

        {/* 分组导航 */}
        <nav className="sidebar-nav">
          {navGroups.map((group) => (
            <div key={group.label} className="nav-group">
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => {
                const icon = SIDEBAR_ICONS[item.id]
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${activeModule === item.id ? 'active' : ''}`}
                    onClick={() => handleNavClick(item.id)}
                  >
                    <span className="nav-icon" style={{ '--c': icon?.color }} aria-hidden="true">
                      {icon && <svg viewBox="0 0 16 16"><path d={icon.path} /></svg>}
                    </span>
                    <span className="nav-label">{item.label}</span>
                    {item.beta && <span className="nav-badge-beta">Beta</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        {/* 底部：品牌 + 版本号，有新版本时右侧出提示 */}
        <div className="sidebar-footer">
          <span className="footer-brand">
            <img className="footer-logo" src={brandLogo} alt="" />
            CodePal
            <span className="footer-version">v{pkg.version}</span>
          </span>
          {hasUpdate && (
            <button className="sidebar-update-pill" onClick={onUpdateClick}>
              新版可用
            </button>
          )}
        </div>
      </aside>

      {/* 右侧内容区：顶部不再留标题栏占位，新样式页面的工具栏直接顶到窗口上沿 */}
      <div className="content-column">
        <div className="content-drag" aria-hidden="true" />
        <main className="content-area">
          {children}
        </main>
      </div>
    </div>
  )
}

export default WorkbenchLayout
