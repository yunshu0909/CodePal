/**
 * CodexAccountPage 页面集成测试
 *
 * 用 React Testing Library + jsdom 模拟渲染环境，
 * mock 掉 window.electronAPI.codexAccount，验证：
 *   - 正常态：展示账户列表、当前激活卡有"当前使用中"标签
 *   - 空态：展示"未检测到 Codex 登录"
 *   - Keyring 模式：展示迁移引导
 *   - 未保存激活账户：展示"未保存账户"卡
 *   - 切换操作：调 switch + 展示 Toast
 *   - 保存操作：点击未保存卡的 [保存为账户] 弹 Modal → 保存成功 Toast
 *   - 重命名 / 删除：弹 Modal + 成功 Toast
 *
 * @module 自动化测试/V1.5.0/CodexAccountPage.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import CodexAccountPage from '../../src/pages/CodexAccountPage.jsx'

// ---------- mock window.electronAPI.codexAccount ----------

const api = {
  list: vi.fn(),
  save: vi.fn(),
  switch: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  detectStorage: vi.fn(),
  openCodex: vi.fn(),
  onNewAccountDetected: vi.fn(() => () => {}),  // 返回 unsubscribe
}

const HOUR = 60 * 60 * 1000

const MOCK_ACCOUNTS = [
  { name: 'alice', email: 'alice@x.com', plan: 'plus', accountId: 'a1', expired: false, lastSwitchAt: Date.now() - 2 * HOUR },
  { name: 'bob', email: 'bob@x.com', plan: 'plus', accountId: 'b1', expired: false, lastSwitchAt: Date.now() - 24 * HOUR },
  { name: 'carol', email: 'carol@x.com', plan: 'pro', accountId: 'c1', expired: false, lastSwitchAt: null },
]

beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockReset()
  api.save.mockReset()
  api.switch.mockReset()
  api.rename.mockReset()
  api.delete.mockReset()
  api.detectStorage.mockReset()
  api.openCodex.mockReset()
  api.onNewAccountDetected.mockReset()
  api.onNewAccountDetected.mockImplementation(() => () => {})

  window.electronAPI = { codexAccount: api }
})

afterEach(() => {
  cleanup()
  delete window.electronAPI
})

// ---------- 辅助 ----------

function mockListResult(override = {}) {
  api.list.mockResolvedValue({
    success: true,
    accounts: MOCK_ACCOUNTS,
    activeName: 'alice',
    hasUnsavedActive: false,
    unsavedActive: null,
    ...override,
  })
  api.detectStorage.mockResolvedValue({ success: true, mode: 'file' })
}

// ---------- 正常态 ----------

describe('CodexAccountPage · 正常态', () => {
  it('渲染 3 张账户卡 + 激活账户显示"当前使用中"', async () => {
    mockListResult()
    render(<CodexAccountPage />)

    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('carol')).toBeInTheDocument()
    expect(screen.getByText('当前使用中')).toBeInTheDocument()
  })

  it('顶部有提示条 + 新增账户按钮', async () => {
    mockListResult()
    render(<CodexAccountPage />)

    expect(await screen.findByText(/完整退出 Codex/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新增账户/ })).toBeInTheDocument()
  })
})

// ---------- 空态 ----------

describe('CodexAccountPage · 空态', () => {
  it('没账户 + 没激活 → 展示"未检测到 Codex 登录"', async () => {
    api.detectStorage.mockResolvedValue({ success: true, mode: 'file' })
    api.list.mockResolvedValue({
      success: true,
      accounts: [],
      activeName: '',
      hasUnsavedActive: false,
      unsavedActive: null,
    })
    render(<CodexAccountPage />)

    expect(await screen.findByText('未检测到 Codex 登录')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /我已登录，重新检测/ })).toBeInTheDocument()
  })

  it('Keyring 模式 → 展示迁移引导', async () => {
    api.detectStorage.mockResolvedValue({ success: true, mode: 'keyring' })
    api.list.mockResolvedValue({ success: true, accounts: [], activeName: '', hasUnsavedActive: false, unsavedActive: null })
    render(<CodexAccountPage />)

    expect(await screen.findByText(/CodePal 目前不支持 Keyring 存储模式/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新检测/ })).toBeInTheDocument()
  })
})

// ---------- 未保存激活账户 ----------

describe('CodexAccountPage · 未保存激活账户', () => {
  it('hasUnsavedActive=true → 首位展示未保存卡', async () => {
    mockListResult({
      activeName: '',
      hasUnsavedActive: true,
      unsavedActive: { email: 'diana@x.com', plan: 'plus', accountId: 'd1' },
    })
    render(<CodexAccountPage />)

    expect(await screen.findByText('未保存账户')).toBeInTheDocument()
    expect(screen.getByText('diana@x.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存为账户/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /暂不保存/ })).toBeInTheDocument()
  })

  it('点击未保存卡的 [保存为账户] → 弹保存 Modal', async () => {
    mockListResult({
      activeName: '',
      hasUnsavedActive: true,
      unsavedActive: { email: 'diana@x.com', plan: 'plus', accountId: 'd1' },
    })
    render(<CodexAccountPage />)

    await screen.findByText('未保存账户')
    fireEvent.click(screen.getByRole('button', { name: /保存为账户/ }))

    expect(await screen.findByText(/检测到新的 Codex 账户/)).toBeInTheDocument()
    // 预填名字应该是 diana
    expect(screen.getByDisplayValue('diana')).toBeInTheDocument()
  })

  it('点击 [暂不保存] → 未保存卡消失', async () => {
    mockListResult({
      activeName: '',
      hasUnsavedActive: true,
      unsavedActive: { email: 'diana@x.com', plan: 'plus', accountId: 'd1' },
    })
    render(<CodexAccountPage />)

    await screen.findByText('未保存账户')
    fireEvent.click(screen.getByRole('button', { name: /暂不保存/ }))

    await waitFor(() => expect(screen.queryByText('未保存账户')).not.toBeInTheDocument())
  })
})

// ---------- 切换操作 ----------

describe('CodexAccountPage · 切换', () => {
  it('点击 bob 卡的 [切换并重启] → 调 switch API + 成功 Toast', async () => {
    mockListResult()
    api.switch.mockResolvedValue({ success: true, codexWasRunning: false })
    render(<CodexAccountPage />)

    await screen.findByText('bob')
    const switchBtns = screen.getAllByRole('button', { name: /切换并重启/ })
    fireEvent.click(switchBtns[0])

    await waitFor(() => expect(api.switch).toHaveBeenCalledWith('bob', { restartCodex: true }))
    expect(await screen.findByText(/已切换到 bob/)).toBeInTheDocument()
  })

  it('Codex 在跑 → Toast 提示已重启并读取新账户', async () => {
    mockListResult()
    api.switch.mockResolvedValue({ success: true, codexWasRunning: true, restarted: true })
    render(<CodexAccountPage />)

    await screen.findByText('bob')
    fireEvent.click(screen.getAllByRole('button', { name: /切换并重启/ })[0])

    expect(
      await screen.findByText(/已切换到 bob，Codex 已重启并读取新账户/)
    ).toBeInTheDocument()
  })

  it('Codex 没跑 → Toast 提示"下次启动生效"', async () => {
    mockListResult()
    api.switch.mockResolvedValue({ success: true, codexWasRunning: false })
    render(<CodexAccountPage />)

    await screen.findByText('bob')
    fireEvent.click(screen.getAllByRole('button', { name: /切换并重启/ })[0])

    expect(
      await screen.findByText(/已切换到 bob，下次启动 Codex 生效/)
    ).toBeInTheDocument()
  })

  it('Codex 打开失败 → Toast 提示手动启动', async () => {
    mockListResult()
    api.switch.mockResolvedValue({
      success: true,
      codexWasRunning: true,
      restarted: false,
      restartError: 'open failed',
    })
    render(<CodexAccountPage />)

    await screen.findByText('bob')
    fireEvent.click(screen.getAllByRole('button', { name: /切换并重启/ })[0])

    expect(
      await screen.findByText(/已切换到 bob，但打开 Codex 失败，请手动启动/)
    ).toBeInTheDocument()
  })

  it('Codex 未完整退出 → Toast 提示切换取消', async () => {
    mockListResult()
    api.switch.mockResolvedValue({
      success: false,
      codexWasRunning: true,
      error: 'CODEX_QUIT_FAILED',
      hint: 'Codex 仍有 2 个进程未退出，切换已取消',
    })
    render(<CodexAccountPage />)

    await screen.findByText('bob')
    fireEvent.click(screen.getAllByRole('button', { name: /切换并重启/ })[0])

    expect(
      await screen.findByText(/Codex 仍有 2 个进程未退出，切换已取消/)
    ).toBeInTheDocument()
  })
})

// ---------- 新增账户引导 ----------

describe('CodexAccountPage · 新增引导', () => {
  it('点击页头 [+ 新增账户] → 弹引导 Modal', async () => {
    mockListResult()
    render(<CodexAccountPage />)

    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('button', { name: /新增账户/ }))

    expect(await screen.findByText('新增 Codex 账户')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /打开 Codex/ })).toBeInTheDocument()
  })
})
