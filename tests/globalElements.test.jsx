/**
 * 全局元素测试（设计总纲 3.18，ISSUES #39）
 *
 * 负责：
 * - Toast 全局入口：只显示一条、新的顶掉旧的、同文案连弹也会重新出现
 * - confirmDialog：动作 = true，取消 / Esc = false，关后卸载
 * - StateView 三态、SegmentedControl 切换
 * - 源码守门：页面不自己摆 <Toast>、不用浏览器 confirm、共用组件不放 emoji
 *
 * @module tests/globalElements
 */

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useState } from 'react'
import { toast } from '../src/components/Toast'
import { confirmDialog } from '../src/components/Modal/confirmDialog'
import StateView from '../src/components/StateView/StateView'
import SegmentedControl from '../src/components/SegmentedControl/SegmentedControl'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 递归列出目录下的源码文件 */
function sourceFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(rel))
    else if (/\.(jsx?|css)$/.test(entry.name)) out.push(rel)
  }
  return out
}

afterEach(() => cleanup())

describe('Toast 全局入口', () => {
  it('新的顶掉旧的，同时只有一条', async () => {
    act(() => toast.success('第一条'))
    expect(await screen.findByText('第一条')).toBeInTheDocument()
    act(() => toast.error('第二条'))
    expect(await screen.findByText('第二条')).toBeInTheDocument()
    expect(screen.queryByText('第一条')).toBeNull()
    expect(document.querySelectorAll('.toast')).toHaveLength(1)
    expect(document.querySelector('.toast--error')).not.toBeNull()
  })

  it('同一句话连弹两次，第二次是新的一条', async () => {
    act(() => toast.success('已保存'))
    const first = await screen.findByText('已保存')
    act(() => toast.success('已保存'))
    await waitFor(() => expect(screen.getByText('已保存')).not.toBe(first))
  })
})

describe('confirmDialog', () => {
  it('点动作返回 true，点取消返回 false，关后不留在页面上', async () => {
    let pending
    act(() => { pending = confirmDialog({ title: '卸载 docs？', description: '说明', confirmText: '卸载', danger: true }) })
    expect(await screen.findByText('卸载 docs？')).toBeInTheDocument()
    expect(screen.getByText('说明')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '卸载' }))
    await expect(pending).resolves.toBe(true)
    await waitFor(() => expect(screen.queryByText('卸载 docs？')).toBeNull())

    act(() => { pending = confirmDialog({ title: '删除？' }) })
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    await expect(pending).resolves.toBe(false)
  })

  it('Esc 等于取消；危险动作默认聚焦取消', async () => {
    let pending
    act(() => { pending = confirmDialog({ title: '删除？', confirmText: '删除', danger: true }) })
    const cancel = await screen.findByRole('button', { name: '取消' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(document, { key: 'Escape' })
    await expect(pending).resolves.toBe(false)
  })
})

describe('StateView 整块状态', () => {
  it('空：标题 + 说明 + 按钮；出错：读取失败 + 原因 + 重试；加载：加载中...', () => {
    const { rerender } = render(<StateView empty emptyMessage="还没有 Skill" emptyHint="请先导入" emptyAction={<button>导入</button>} />)
    expect(screen.getByText('还没有 Skill')).toBeInTheDocument()
    expect(screen.getByText('请先导入')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导入' })).toBeInTheDocument()
    rerender(<StateView error="目录不可访问" onRetry={() => {}} />)
    expect(screen.getByText('读取失败')).toBeInTheDocument()
    expect(screen.getByText('目录不可访问')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    rerender(<StateView loading />)
    expect(screen.getByText('加载中...')).toBeInTheDocument()
  })
})

describe('SegmentedControl', () => {
  function Demo() {
    const [value, setValue] = useState('all')
    return <SegmentedControl ariaLabel="工具" value={value} onChange={setValue} options={[{ value: 'all', label: '全部' }, { value: 'codex', label: 'Codex' }]} />
  }

  it('点击和左右键切换选中项', () => {
    render(<Demo />)
    expect(screen.getByRole('radio', { name: '全部' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))
    expect(screen.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Codex' }), { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: '全部' })).toHaveAttribute('aria-checked', 'true')
  })
})

describe('源码守门（全局元素只有一个入口）', () => {
  const pages = ['src/App.jsx', ...sourceFiles('src/pages').filter((f) => /\.jsx?$/.test(f))]

  it('页面不自己摆 <Toast>、不存提示状态', () => {
    const offenders = pages.filter((f) => {
      const s = fs.readFileSync(path.join(root, f), 'utf8')
      return /<Toast[\s/>]/.test(s) || /\[toast, setToast\]/.test(s) || /import Toast from/.test(s)
    })
    expect(offenders).toEqual([])
  })

  it('不用浏览器自带的 confirm / alert', () => {
    const offenders = [...pages, ...sourceFiles('src/components'), ...sourceFiles('src/hooks')]
      .filter((f) => /window\.(confirm|alert)\(/.test(fs.readFileSync(path.join(root, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('共用组件不放 emoji', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2705}\u{274C}\u{2B50}]/u
    const offenders = sourceFiles('src/components').filter((f) => emoji.test(fs.readFileSync(path.join(root, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
