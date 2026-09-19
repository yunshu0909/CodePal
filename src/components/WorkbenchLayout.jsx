/**
 * WorkbenchLayout - 工作台布局组件（Native+ 窗口外壳）
 *
 * 负责：
 * - 左侧导航侧边栏：顶部 52 高留给 macOS 红绿灯，下面品牌头（点开「关于」）和分组导航；有新版时底部出一张新版卡
 * - 关于对话框、新版本对话框（品牌规则见设计总纲 3.19）
 * - macOS 上侧栏透出系统毛玻璃（主进程 vibrancy），其他平台退成纯灰底
 * - 模块切换与内容区渲染；新样式页面的 52 高工具栏由 PageShell native 提供，和红绿灯同一行
 * - 规则见 docs/design-operating-system.md 3.10「窗口外壳」
 *
 * @module components/WorkbenchLayout
 */

import React, { useEffect, useState } from 'react'
import '../styles/workbench.css'
import pkg from '../../package.json'
import brandLogo from '../assets/codepal-logo.png'
import { SIDEBAR_ICONS } from './sidebarIcons'
import Button from './Button/Button'
import AboutDialog from './brand/AboutDialog'
import UpdateDialog from './brand/UpdateDialog'
import './brand/brand.css'

// 只有 macOS 有系统毛玻璃；其他平台侧栏用纯灰底
const IS_MAC = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent)

/**
 * 工作台布局组件
 * @param {Object} props
 * @param {React.ReactNode} props.children - 内容区域要渲染的子元素
 * @param {'skills'|'mcp'|'usage'|'claude-usage'|'api'|'project-init'|'permission'|'network'|'k28-status-light'|'sessions'|'doc-browser'} props.activeModule - 当前激活的模块
 * @param {function} props.onModuleChange - 模块切换回调函数
 * @param {object} [props.appUpdate] - 应用更新状态（hasUpdate / latestVersion / releaseNotes / checked / error）
 * @param {function} [props.onDownloadUpdate] - 「下载新版」：打开发布页
 * @returns {React.ReactElement}
 */
function WorkbenchLayout({ children, activeModule, onModuleChange, appUpdate, onDownloadUpdate }) {
  // 关于 / 新版本两个对话框；同一时间只开一个
  const [dialog, setDialog] = useState(null)
  const update = appUpdate || {}
  const version = pkg.version

  // 菜单栏「关于 CodePal」也打开同一个关于对话框
  useEffect(() => window.electronAPI?.onShowAbout?.(() => setDialog('about')), [])

  /**
   * 分组导航配置
   * 按用途分四组（2026-09-19 用户定顺序），新功能按每组的定义归组：
   * - 用量账单：花了多少、值不值（token 用量、订阅费和回本）
   * - 项目开发：写代码这件事本身（开项目、回看过程、查资料）
   * - 技能中心：给 AI 工具装的能力（Skills、Plugins，以后的 MCP）
   * - 环境配置：让工具跑得起来、跑得顺的环境（Claude Code 设置、网络、以后的消息同步）
   * 图标见 sidebarIcons.js（按模块 ID 取）
   * @type {Array<{label: string, items: Array<{id: string, label: string, beta?: boolean}>}>}
   */
  const navGroups = [
    {
      label: '用量账单',
      items: [
        { id: 'usage', label: '用量监测' },
        { id: 'claude-usage', label: '订阅管理' }
      ]
    },
    {
      label: '项目开发',
      items: [
        { id: 'project-init', label: '新建项目' },
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
    },
    {
      label: '环境配置',
      items: [
        // 'api' 供应商切换模块已断接线隔离（v1.9.8），代码在 _disabled/api-config/，恢复步骤见其 README
        { id: 'permission', label: 'Claude Code 设置' },
        { id: 'network', label: '网络诊断' },
        { id: 'k28-status-light', label: '状态灯' }
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

        {/* 品牌头：点开「关于 CodePal」 */}
        <button type="button" className="brand-head" aria-label="关于 CodePal" onClick={() => setDialog('about')}>
          <img className="brand-head__icon" src={brandLogo} alt="" />
          <span className="brand-wordmark">CodePal</span>
        </button>

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

        {/* 底部：平时空着；有新版时出一张新版卡 */}
        {update.hasUpdate && (
          <div className="brand-update-card np-scope">
            <div className="brand-update-card__text">新版本 <b>{update.latestVersion}</b> 已发布</div>
            <Button size="sm" variant="primary" onClick={() => setDialog('update')}>查看更新</Button>
          </div>
        )}
      </aside>

      {/* 右侧内容区：顶部不再留标题栏占位，新样式页面的工具栏直接顶到窗口上沿 */}
      <div className="content-column">
        <div className="content-drag" aria-hidden="true" />
        <main className="content-area">
          {children}
        </main>
      </div>

      <AboutDialog
        open={dialog === 'about'}
        onClose={() => setDialog(null)}
        version={version}
        update={update}
        onShowUpdate={() => setDialog('update')}
      />
      <UpdateDialog
        open={dialog === 'update'}
        onClose={() => setDialog(null)}
        currentVersion={version}
        latestVersion={update.latestVersion}
        releaseNotes={update.releaseNotes}
        onDownload={() => onDownloadUpdate?.()}
      />
    </div>
  )
}

export default WorkbenchLayout
