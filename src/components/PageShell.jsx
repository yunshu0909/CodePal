/**
 * 通用页面外壳组件
 *
 * 负责：
 * - 统一白卡容器（圆角、阴影、内边距）
 * - 统一页面标题区（h1 + 副标题）
 * - 支持头部右侧操作区（actions）
 * - 支持头部分隔线（divider）
 * - 所有标准页面通过此组件保持视觉一致
 *
 * className 变体：
 * - 默认：白卡 + 32px padding，适合普通页面
 * - page-shell--no-padding：无内边距，适合内部自带 padding 的复杂布局（双栏、表格页）
 *
 * @module components/PageShell
 */

import './PageShell.css'

/**
 * 页面外壳 — 白卡容器 + 标准页面头
 * @param {string} title - 页面标题（必填）
 * @param {string} [subtitle] - 副标题（可选）
 * @param {React.ReactNode} [actions] - 头部右侧操作区（如按钮）
 * @param {boolean} [divider=false] - 是否在头部下方显示分隔线（--no-padding 布局常用）
 * @param {React.ReactNode} children - 页面内容
 * @param {string} [className] - 附加 class，用于特殊布局场景的样式覆盖
 * @returns {JSX.Element}
 */
export default function PageShell({ title, subtitle, actions, divider = false, children, className = '' }) {
  return (
    <div className={`page-shell${className ? ` ${className}` : ''}`}>
      <header className={`page-shell__header${divider ? ' page-shell__header--divider' : ''}`}>
        <div className="page-shell__header-main">
          <h1 className="page-shell__title">{title}</h1>
          {subtitle && <p className="page-shell__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-shell__actions">{actions}</div>}
      </header>
      {children}
    </div>
  )
}
