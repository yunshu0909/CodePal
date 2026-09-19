/**
 * 侧栏导航图标（Native+）
 *
 * 负责：
 * - 每个导航项的线形图案（SVG path，viewBox 0 0 16 16）与图标方块底色
 * - 底色只用 design-tokens.css 里的 --ic-* 与工具品牌色（设计总纲 3.4 / 3.7）
 *
 * @module components/sidebarIcons
 */

/** @type {Record<string, {color: string, path: string}>} 模块 ID → 图标 */
export const SIDEBAR_ICONS = {
  permission: { color: 'var(--tool-claude)', path: 'M3 4.5 6.5 8 3 11.5M8 12h5' },
  'project-init': { color: 'var(--ic-blue)', path: 'M8 3v10M3 8h10' },
  network: { color: 'var(--ic-green)', path: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12' },
  'k28-status-light': { color: 'var(--ic-orange)', path: 'M6 1.5h4a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM8 4.5v.01M8 8v.01M8 11.5v.01' },
  harness: { color: 'var(--ic-teal)', path: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z' },
  usage: { color: 'var(--ic-blue)', path: 'M2 13.5h12M4 11V6M8 11V3M12 11V8' },
  'claude-usage': { color: 'var(--ic-purple)', path: 'M3.5 4h9a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 10.5v-5A1.5 1.5 0 0 1 3.5 4zM2 7h12' },
  sessions: { color: 'var(--ic-green)', path: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z' },
  'doc-browser': { color: 'var(--ic-brown)', path: 'M2.5 2.5h4a2 2 0 0 1 1.5.7 2 2 0 0 1 1.5-.7h4v10h-4a2 2 0 0 0-1.5.7 2 2 0 0 0-1.5-.7h-4zM8 3.2v10' },
  skills: { color: 'var(--ic-gray)', path: 'M10.5 2.5a3 3 0 0 0-3.6 3.6L2.5 10.5l3 3 4.4-4.4a3 3 0 0 0 3.6-3.6l-1.8 1.8-1.5-.4-.4-1.5z' },
  plugins: { color: 'var(--ic-gray)', path: 'M6 2.5h4v2a1.5 1.5 0 0 0 3 0v3.5h-2a1.5 1.5 0 0 0 0 3h2v2.5H6v-2a1.5 1.5 0 0 0-3 0v-3.5h2a1.5 1.5 0 0 0 0-3H3v-2.5z' },
  mcp: { color: 'var(--ic-gray)', path: 'M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14' },
}
