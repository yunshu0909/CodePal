/**
 * Markdown 外链拦截 — 前端组件测试
 *
 * 负责：
 * - MarkdownRenderer 渲染的外链点击走 openExternalLink IPC，窗口不导航
 * - 锚点 / 相对链接点击静默不动作
 *
 * @module tests/safety/markdownLink.frontend.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import MarkdownRenderer from '../../src/components/MarkdownRenderer/MarkdownRenderer'

describe('V1.9.8 Markdown 外链拦截', () => {
  let openExternalLink

  beforeEach(() => {
    openExternalLink = vi.fn().mockResolvedValue({ success: true })
    window.electronAPI = { openExternalLink }
  })

  it('ML-1: 点击 https 外链 → openExternalLink 恰被调一次，页面未导航', () => {
    render(<MarkdownRenderer content={'看这个 [仓库](https://github.com/yunshu0909/CodePal)'} />)
    const link = screen.getByText('仓库')
    const beforeHref = window.location.href
    fireEvent.click(link)
    expect(openExternalLink).toHaveBeenCalledTimes(1)
    expect(openExternalLink).toHaveBeenCalledWith('https://github.com/yunshu0909/CodePal')
    expect(window.location.href).toBe(beforeHref)
  })

  it('ML-2: 点击锚点链接 → 不调 IPC、不导航', () => {
    render(<MarkdownRenderer content={'[跳到章节](#section-1)'} />)
    fireEvent.click(screen.getByText('跳到章节'))
    expect(openExternalLink).not.toHaveBeenCalled()
  })

  it('ML-3: 点击相对路径链接 → 不调 IPC（窗口不跟随任何链接）', () => {
    render(<MarkdownRenderer content={'[本地文档](./other.md)'} />)
    fireEvent.click(screen.getByText('本地文档'))
    expect(openExternalLink).not.toHaveBeenCalled()
  })

  it('ML-4: mailto 链接 → 走 IPC', () => {
    render(<MarkdownRenderer content={'[联系](mailto:a@b.com)'} />)
    fireEvent.click(screen.getByText('联系'))
    expect(openExternalLink).toHaveBeenCalledWith('mailto:a@b.com')
  })

  it('ML-5: 非 Electron 环境（无 electronAPI）点击外链不抛错', () => {
    delete window.electronAPI
    render(<MarkdownRenderer content={'[仓库](https://example.com)'} />)
    expect(() => fireEvent.click(screen.getByText('仓库'))).not.toThrow()
  })
})
