/**
 * 新样式通用类回流测试
 *
 * 负责：
 * - AC-50：native.css 含对话回顾首次用到的 list 段通用类
 * - 组件预览页渲染这些类
 *
 * @module tests/sessions/nativeStyles.test
 */

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ComponentPreviewPage from '../../src/pages/ComponentPreviewPage'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLASSES = [
  'np-sf', 'np-filterbar', 'np-popbtn', 'np-menu', 'np-mitem', 'np-msep', 'np-ic', 'np-ic--s16', 'np-ic--s20',
  'np-read', 'np-ask', 'np-sender', 'np-msg-when', 'np-btn-text', 'np-row--rec', 'np-rec-end',
  'np-detail-hd', 'np-detail-body', 'np-hit',
]

describe('旧样式退役', () => {
  it('TC-45 session-browser.css 已删除且无引用', () => {
    expect(fs.existsSync(path.join(root, 'src/styles/session-browser.css'))).toBe(false)
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    const hits = walk(path.join(root, 'src')).filter((f) => /\.(jsx?|css)$/.test(f) && fs.readFileSync(f, 'utf8').includes('session-browser.css'))
    expect(hits).toEqual([])
  })
})

describe('页面专属样式', () => {
  it('列表骨架间距 4、对话页骨架间距 8（code 门 F-04）', () => {
    const css = fs.readFileSync(path.join(root, 'src/pages/sessions/sessions.css'), 'utf8')
    expect(css).toMatch(/\.sr-sk-lines--list\s*\{[^}]*gap:\s*4px/)
    expect(css).toMatch(/\.sr-sk-lines\s*\{[^}]*gap:\s*8px/)
  })
})

describe('native.css 回流', () => {
  it('TC-50 新类都有样式定义', () => {
    const css = fs.readFileSync(path.join(root, 'src/styles/native.css'), 'utf8')
    for (const c of CLASSES) expect(css, c).toMatch(new RegExp(`\\.${c}(?![\\w-])`))
  })

  it('TC-50 代码块不做语法高亮：np-read 把高亮颜色压回正文色', () => {
    const css = fs.readFileSync(path.join(root, 'src/styles/native.css'), 'utf8')
    expect(css).toMatch(/\.np-read[^{]*\.hljs[^{]*\{[^}]*color:\s*inherit/)
  })

  it('TC-50 组件预览页展示这些类', () => {
    const { container } = render(<ComponentPreviewPage />)
    for (const c of ['np-sf', 'np-popbtn', 'np-row--rec', 'np-detail-hd', 'np-ask', 'np-hit']) {
      expect(container.querySelector(`.${c}`), c).not.toBeNull()
    }
  })
})
