/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：两处换色（定稿 G1、G2）
 *
 * 负责：
 * - TC-018：全局拖拽条悬停与按下用 var(--blue)，不再出现旧蓝；接管 statusLine 弹窗正文 var(--fg-2)、
 *   提示框 var(--fg-3)、底色 var(--card)、圆角 8px、没有边框，不再用旧变量；弹窗文案不变
 *
 * @module tests/skills/inbox/colorSwap.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = (relative) => fs.readFile(path.join(ROOT, relative), 'utf8')
const block = (css, selector) => {
  const start = css.indexOf(`${selector} {`)
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start) + 1)
}

describe('两处换色', () => {
  it('TC-018 COLOR_SWAP 拖拽条悬停色换新变量', async () => {
    const css = await read('src/styles/index.css')
    const hover = css.slice(css.indexOf('.resize-handle:hover'), css.indexOf('}', css.indexOf('.resize-handle:hover')) + 1)
    expect(hover, 'COLOR_SWAP 拖拽条悬停应用 var(--blue)').toMatch(/background:\s*var\(--blue\)/)
    expect(hover).not.toMatch(/--color-primary|#2563eb/i)
  })

  it('TC-018 COLOR_SWAP 接管 statusLine 弹窗颜色换新变量，文案不变', async () => {
    const css = await read('src/pages/usage/components/ClaudeStatusLineTakeoverModal.css')
    const copy = block(css, '.claude-takeover-copy')
    const note = block(css, '.claude-takeover-copy__note')
    expect(copy, 'COLOR_SWAP 正文应用 var(--fg-2)').toMatch(/color:\s*var\(--fg-2\)/)
    expect(note, 'COLOR_SWAP 提示框字应用 var(--fg-3)').toMatch(/color:\s*var\(--fg-3\)/)
    expect(note, 'COLOR_SWAP 提示框底色应用 var(--card)').toMatch(/background:\s*var\(--card\)/)
    expect(note, 'COLOR_SWAP 提示框圆角 8px').toMatch(/border-radius:\s*8px/)
    expect(note, 'COLOR_SWAP 提示框没有边框').not.toMatch(/border:/)
    expect(css).not.toMatch(/--text-secondary|--text-tertiary|--border-default|--bg-subtle/)
    const jsx = await read('src/pages/usage/components/ClaudeStatusLineTakeoverModal.jsx')
    expect(jsx).toContain('此操作不会自动执行；只有点击“确认接管”才会修改配置。')
    expect(jsx).toContain('当前检测到自定义 statusLine。继续后 CodePal 将：')
  })
})
