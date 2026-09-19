/**
 * 发布说明整理
 *
 * 负责：
 * - 把 GitHub 发布说明（Markdown）整理成对话框里的几行纯文字：去掉标题符号、列表符号、粗体、链接地址
 * - 只取前几条，多出来的由「完整说明」链接去 GitHub 看
 *
 * @module components/brand/releaseNotes
 */

/**
 * @param {string} markdown - 发布说明原文
 * @param {number} [limit=6] - 最多几行
 * @returns {{lines: string[], more: boolean}}
 */
export function summarizeReleaseNotes(markdown, limit = 6) {
  if (typeof markdown !== 'string' || !markdown.trim()) return { lines: [], more: false }
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, '')
      .trim())
    // 分隔线、「Full Changelog」这类行对用户没意义
    .filter((line) => line && !/^[-=*_]{3,}$/.test(line) && !/^full changelog/i.test(line))
  return { lines: lines.slice(0, limit), more: lines.length > limit }
}
