/**
 * 统一 Markdown 渲染组件
 *
 * 负责：
 * - 将 Markdown 文本渲染为格式化 HTML
 * - 支持 GFM（表格、删除线、任务列表、自动链接）
 * - 代码块语法高亮（highlight.js）
 * - 全应用统一的 Markdown 展示样式
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

/**
 * 统一 Markdown 渲染器
 * @param {Object} props
 * @param {string} props.content - Markdown 文本内容
 * @param {string} [props.className] - 额外的 CSS 类名
 * @returns {JSX.Element}
 */
export default function MarkdownRenderer({ content, className = '' }) {
  if (!content) return null

  return (
    <div className={`md-renderer${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
