/**
 * 统一 Markdown 渲染组件
 *
 * 负责：
 * - 将 Markdown 文本渲染为格式化 HTML
 * - 支持 GFM（表格、删除线、任务列表、自动链接）
 * - 代码块语法高亮（highlight.js）
 * - 全应用统一的 Markdown 展示样式
 * - 可选：把关键词包成 <mark class="np-hit">（对话回顾的搜索命中）
 *
 * 使用方式：
 * ```jsx
 * import MarkdownRenderer from '../components/MarkdownRenderer/MarkdownRenderer'
 * <MarkdownRenderer content={markdownText} />
 * ```
 *
 * @module components/MarkdownRenderer
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import './MarkdownRenderer.css'

const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeHighlight]

/** 允许转交系统浏览器的链接协议（与主进程 navigationGuardService 白名单一致） */
const EXTERNAL_LINK_PATTERN = /^(https?:|mailto:)/i

/**
 * Markdown 链接组件：一律阻止窗口内导航，安全外链走 open-external-link IPC 转系统浏览器
 * 锚点 / 相对链接静默不动作（渲染的是外部内容，窗口不跟随任何链接）
 * @param {Object} props
 * @param {string} [props.href] - 链接地址
 * @param {import('react').ReactNode} props.children - 链接文本
 * @returns {JSX.Element}
 */
function MarkdownLink({ href, children }) {
  const handleClick = (event) => {
    event.preventDefault()
    if (href && EXTERNAL_LINK_PATTERN.test(href)) {
      // 可选链兜底非 Electron 环境（如组件测试的 jsdom）
      window.electronAPI?.openExternalLink?.(href)
    }
  }
  return (
    <a href={href} onClick={handleClick}>
      {children}
    </a>
  )
}

const markdownComponents = { a: MarkdownLink }

/**
 * rehype 插件：把正文里的关键词（不分大小写）包成 <mark class="np-hit">；不进代码块
 * @param {string} keyword - 关键词
 * @returns {Function} 插件
 */
function rehypeHighlightKeyword(keyword) {
  const kw = keyword.toLowerCase()
  const split = (value) => {
    const out = []
    const lower = value.toLowerCase()
    let from = 0
    for (let i = lower.indexOf(kw); i >= 0; i = lower.indexOf(kw, i + kw.length)) {
      if (i > from) out.push({ type: 'text', value: value.slice(from, i) })
      out.push({ type: 'element', tagName: 'mark', properties: { className: ['np-hit'] }, children: [{ type: 'text', value: value.slice(i, i + kw.length) }] })
      from = i + kw.length
    }
    if (from < value.length) out.push({ type: 'text', value: value.slice(from) })
    return out
  }
  const walk = (node) => {
    if (!node.children || node.tagName === 'pre' || node.tagName === 'code') return
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && child.value.toLowerCase().includes(kw)) return split(child.value)
      walk(child)
      return [child]
    })
  }
  return () => (tree) => walk(tree)
}

/**
 * 统一 Markdown 渲染器
 * @param {Object} props
 * @param {string} props.content - Markdown 文本内容
 * @param {string} [props.className] - 额外的 CSS 类名
 * @param {string} [props.highlight] - 要标出的关键词（可选）
 * @returns {JSX.Element}
 */
export default function MarkdownRenderer({ content, className = '', highlight = '' }) {
  if (!content) return null
  const kw = highlight.trim()

  return (
    <div className={`md-renderer${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={kw ? [...rehypePlugins, rehypeHighlightKeyword(kw)] : rehypePlugins}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
