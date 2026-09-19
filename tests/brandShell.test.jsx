/**
 * 品牌位测试（设计总纲 3.19，ISSUES #40）
 *
 * 负责：
 * - 侧栏品牌头打开「关于 CodePal」；菜单信号也能打开
 * - 平时没有新版卡；有新版时出卡，「查看更新」打开新版本对话框，「下载新版」走发布页
 * - 发布说明整理、更新检查带回发布说明、窗口标题
 *
 * @module tests/brandShell
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import WorkbenchLayout from '../src/components/WorkbenchLayout'
import { summarizeReleaseNotes } from '../src/components/brand/releaseNotes'
import pkg from '../package.json'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

let showAbout
beforeEach(() => {
  showAbout = null
  window.electronAPI = {
    onShowAbout: vi.fn((cb) => { showAbout = cb; return () => {} }),
    openExternalLink: vi.fn(),
  }
})
afterEach(() => cleanup())

const NOTES = '## 新功能\n- **侧栏**按用途重新分组\n- 提示条换新样子，见 [说明](https://x)\n\n---\n**Full Changelog**: v2.0.0...v2.1.0'

describe('侧栏品牌头与关于', () => {
  it('点品牌头打开关于：版本、已是最新、外链', () => {
    render(<WorkbenchLayout activeModule="usage" appUpdate={{ checked: true, hasUpdate: false }}><div /></WorkbenchLayout>)
    fireEvent.click(screen.getByRole('button', { name: '关于 CodePal' }))
    expect(screen.getByText(`版本 ${pkg.version}`, { exact: false })).toBeInTheDocument()
    expect(screen.getByText('已是最新')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'GitHub ↗' }))
    expect(window.electronAPI.openExternalLink).toHaveBeenCalledWith('https://github.com/yunshu0909/CodePal')
  })

  it('菜单「关于 CodePal」的信号也打开同一个对话框', () => {
    render(<WorkbenchLayout activeModule="usage"><div /></WorkbenchLayout>)
    expect(screen.queryByText('AI 编程的伴侣仪表盘', { exact: false })).toBeNull()
    act(() => showAbout())
    expect(screen.getByText('AI 编程的伴侣仪表盘', { exact: false })).toBeInTheDocument()
  })
})

describe('新版卡与新版本对话框', () => {
  it('平时没有新版卡', () => {
    render(<WorkbenchLayout activeModule="usage" appUpdate={{ checked: true, hasUpdate: false }}><div /></WorkbenchLayout>)
    expect(screen.queryByRole('button', { name: '查看更新' })).toBeNull()
  })

  it('有新版：卡片写版本号，查看更新 → 对话框列更新内容，下载新版走发布页', () => {
    const onDownload = vi.fn()
    render(<WorkbenchLayout activeModule="usage" appUpdate={{ checked: true, hasUpdate: true, latestVersion: '2.1.0', releaseNotes: NOTES }} onDownloadUpdate={onDownload}><div /></WorkbenchLayout>)
    expect(screen.getByText('2.1.0')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看更新' }))
    expect(screen.getByText('CodePal 2.1.0 可以更新了')).toBeInTheDocument()
    expect(screen.getByText(`你现在用的是 ${pkg.version}。`)).toBeInTheDocument()
    expect(screen.getByText('侧栏按用途重新分组')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下载新版' }))
    expect(onDownload).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('CodePal 2.1.0 可以更新了')).toBeNull()
  })

  it('关于里有新版时版本行可点，打开新版本对话框', () => {
    render(<WorkbenchLayout activeModule="usage" appUpdate={{ checked: true, hasUpdate: true, latestVersion: '2.1.0', releaseNotes: '' }}><div /></WorkbenchLayout>)
    fireEvent.click(screen.getByRole('button', { name: '关于 CodePal' }))
    fireEvent.click(screen.getByRole('button', { name: '有新版本 2.1.0' }))
    expect(screen.getByText('CodePal 2.1.0 可以更新了')).toBeInTheDocument()
  })
})

describe('发布说明与更新检查', () => {
  it('整理 Markdown：去标题、列表、粗体、链接地址、分隔线和 Full Changelog', () => {
    expect(summarizeReleaseNotes(NOTES)).toEqual({ lines: ['新功能', '侧栏按用途重新分组', '提示条换新样子，见 说明'], more: false })
    expect(summarizeReleaseNotes('')).toEqual({ lines: [], more: false })
    expect(summarizeReleaseNotes('- a\n- b\n- c', 2)).toEqual({ lines: ['a', 'b'], more: true })
  })

  it('检查更新时带回发布说明', async () => {
    const svc = require('../electron/services/appUpdateService.js')
    const original = global.fetch
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: 'v99.0.0', html_url: 'https://x/r', body: NOTES }) }))
    try {
      const state = await svc.checkForAppUpdate('2.0.0')
      expect(state.hasUpdate).toBe(true)
      expect(state.latestVersion).toBe('99.0.0')
      expect(state.releaseNotes).toBe(NOTES)
    } finally {
      global.fetch = original
    }
  })

  it('窗口标题是 CodePal', () => {
    expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toContain('<title>CodePal</title>')
  })
})
