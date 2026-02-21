/**
 * V0.7 API 配置页正式版集成测试
 *
 * 负责：
 * - 基于真实 React 页面验证供应商切换主链路
 * - 验证 custom 检测、确认弹窗与失败提示
 * - 验证 API Key 编辑面板的展开/保存/取消
 *
 * @module 自动化测试/V0.7/tests/integration/ApiConfigPage.v07.formal-flow.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import ApiConfigPage from '@/pages/ApiConfigPage.jsx'

/**
 * 通过供应商名称定位卡片容器
 * @param {string} providerName - 供应商名称
 * @returns {HTMLElement} 对应卡片节点
 */
function getProviderCard(providerName) {
  const nameNode = screen.getByText(providerName, { selector: '.provider-name' })
  const card = nameNode.closest('.provider-item')
  if (!card) {
    throw new Error(`Provider card not found: ${providerName}`)
  }
  return card
}

/**
 * 读取“当前使用”文本
 * @returns {string} 当前供应商显示名称
 */
function getCurrentProviderText() {
  const valueNode = document.querySelector('.status-value')
  return valueNode?.textContent?.trim() || ''
}

describe('V0.7 API Config Formal Flow (Integration)', () => {
  beforeEach(() => {
    // 提供默认的 Electron API mock，单测可按场景覆盖返回值
    window.electronAPI = {
      getClaudeProvider: vi.fn().mockResolvedValue({
        success: true,
        current: 'kimi',
        profile: null,
        isNew: false,
        error: null,
        errorCode: null,
      }),
      getProviderEnvConfig: vi.fn().mockResolvedValue({
        success: true,
        providers: {
          kimi: { token: '' },
          aicodemirror: { token: '' },
        },
        envPath: '/tmp/mock/.env',
        error: null,
        errorCode: null,
      }),
      listProviderDefinitions: vi.fn().mockResolvedValue({
        success: true,
        providers: [
          { id: 'official', name: 'Claude Official', url: 'https://www.anthropic.com/claude-code', icon: 'A', color: '#6b5ce7', supportsToken: false, source: 'builtin' },
          { id: 'qwen', name: 'Qwen3 Coder Plus', url: 'https://dashscope.aliyuncs.com/apps/anthropic', icon: 'Q', color: '#0891b2', supportsToken: true, source: 'builtin' },
          { id: 'kimi', name: 'Kimi For Coding', url: 'https://api.kimi.com/coding/', icon: 'K', color: '#4f46e5', supportsToken: true, source: 'builtin' },
          { id: 'aicodemirror', name: 'AICodeMirror', url: 'https://api.aicodemirror.com/api/claudecode', icon: 'X', color: '#d97706', supportsToken: true, source: 'builtin' },
        ],
        registryPath: '/tmp/mock/.provider-manifests.json',
        error: null,
        errorCode: null,
      }),
      saveProviderToken: vi.fn().mockResolvedValue({
        success: true,
        envPath: '/tmp/mock/.env',
        error: null,
        errorCode: null,
      }),
      switchClaudeProvider: vi.fn().mockResolvedValue({
        success: true,
        backupPath: '/tmp/mock-backup.json',
        error: null,
        errorCode: null,
      }),
    }

    window.confirm = vi.fn(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('TC-S2-IT-01: 启用成功后应刷新当前供应商与提示文案', async () => {
    window.electronAPI.getClaudeProvider
      .mockResolvedValueOnce({
        success: true,
        current: 'official',
        profile: null,
        isNew: false,
        error: null,
        errorCode: null,
      })
      .mockResolvedValue({
        success: true,
        current: 'kimi',
        profile: null,
        isNew: false,
        error: null,
        errorCode: null,
      })
    window.electronAPI.getProviderEnvConfig.mockResolvedValue({
      success: true,
      providers: {
        kimi: { token: 'sk-kimi-ready' },
      },
      envPath: '/tmp/mock/.env',
      error: null,
      errorCode: null,
    })

    render(<ApiConfigPage />)

    await waitFor(() => {
      expect(getCurrentProviderText()).toBe('Claude Official')
    })

    const kimiCard = getProviderCard('Kimi For Coding')
    fireEvent.click(within(kimiCard).getByRole('button', { name: '启用' }))

    await waitFor(() => {
      expect(window.electronAPI.switchClaudeProvider).toHaveBeenCalledWith('kimi')
    })
    await waitFor(() => {
      expect(getCurrentProviderText()).toBe('Kimi For Coding')
    })

    expect(screen.getByText('已切换至 Kimi For Coding')).toBeTruthy()
  })

  it('TC-S2-IT-02: 启用失败时应保留原状态并提示错误', async () => {
    window.electronAPI.getClaudeProvider.mockResolvedValue({
      success: true,
      current: 'official',
      profile: null,
      isNew: false,
      error: null,
      errorCode: null,
    })
    window.electronAPI.getProviderEnvConfig.mockResolvedValue({
      success: true,
      providers: {
        kimi: { token: 'sk-kimi-ready' },
      },
      envPath: '/tmp/mock/.env',
      error: null,
      errorCode: null,
    })
    window.electronAPI.switchClaudeProvider.mockResolvedValueOnce({
      success: false,
      backupPath: null,
      error: 'permission denied',
      errorCode: 'PERMISSION_DENIED',
    })

    render(<ApiConfigPage />)

    await waitFor(() => {
      expect(getCurrentProviderText()).toBe('Claude Official')
    })

    const kimiCard = getProviderCard('Kimi For Coding')
    fireEvent.click(within(kimiCard).getByRole('button', { name: '启用' }))

    await waitFor(() => {
      expect(window.electronAPI.switchClaudeProvider).toHaveBeenCalledWith('kimi')
    })

    expect(getCurrentProviderText()).toBe('Claude Official')
    expect(screen.getByText('权限被拒绝：无法写入 .env 文件')).toBeTruthy()
  })

  it('TC-S2-MVP-01: 动态渠道应可渲染并触发切换', async () => {
    window.electronAPI.getClaudeProvider
      .mockResolvedValueOnce({
        success: true,
        current: 'official',
        profile: null,
        isNew: false,
        error: null,
        errorCode: null,
      })
      .mockResolvedValue({
        success: true,
        current: 'neo-proxy',
        profile: null,
        isNew: false,
        error: null,
        errorCode: null,
      })
    window.electronAPI.listProviderDefinitions.mockResolvedValue({
      success: true,
      providers: [
        { id: 'official', name: 'Claude Official', url: 'https://www.anthropic.com/claude-code', icon: 'A', color: '#6b5ce7', supportsToken: false, source: 'builtin' },
        { id: 'neo-proxy', name: 'NeoProxy Gateway', url: 'https://api.neoproxy.dev/anthropic', icon: 'N', color: '#2563eb', supportsToken: true, source: 'custom' },
      ],
      registryPath: '/tmp/mock/.provider-manifests.json',
      error: null,
      errorCode: null,
    })
    window.electronAPI.getProviderEnvConfig.mockResolvedValue({
      success: true,
      providers: {
        'neo-proxy': { token: 'sk-neo-ready' },
      },
      envPath: '/tmp/mock/.env',
      error: null,
      errorCode: null,
    })

    render(<ApiConfigPage />)

    await waitFor(() => {
      expect(screen.getByText('NeoProxy Gateway', { selector: '.provider-name' })).toBeTruthy()
    })

    const dynamicCard = getProviderCard('NeoProxy Gateway')
    fireEvent.click(within(dynamicCard).getByRole('button', { name: '启用' }))

    await waitFor(() => {
      expect(window.electronAPI.switchClaudeProvider).toHaveBeenCalledWith('neo-proxy')
    })
    await waitFor(() => {
      expect(getCurrentProviderText()).toBe('NeoProxy Gateway')
    })
  })

  it('TC-S2-IT-04: custom 档位点击切换时应允许直接切换到已配置供应商', async () => {
    window.electronAPI.getClaudeProvider
      .mockResolvedValueOnce({
        success: true,
        current: 'custom',
        profile: null,
        isNew: false,
        error: null,
        errorCode: null,
      })
      .mockResolvedValue({
        success: true,
        current: 'kimi',
        profile: null,
        isNew: false,
        error: null,
        errorCode: null,
      })
    window.electronAPI.getProviderEnvConfig.mockResolvedValue({
      success: true,
      providers: {
        kimi: { token: 'sk-kimi-ready' },
      },
      envPath: '/tmp/mock/.env',
      error: null,
      errorCode: null,
    })
    render(<ApiConfigPage />)

    await waitFor(() => {
      expect(getCurrentProviderText()).toBe('自定义配置 (Custom)')
    })

    const kimiCard = getProviderCard('Kimi For Coding')
    fireEvent.click(within(kimiCard).getByRole('button', { name: '启用' }))

    await waitFor(() => {
      expect(window.electronAPI.switchClaudeProvider).toHaveBeenCalledWith('kimi')
    })
    await waitFor(() => {
      expect(getCurrentProviderText()).toBe('Kimi For Coding')
    })
  })

  it('TC-S2-FE-01/03: 编辑 API Key 保存后可回显并支持取消', async () => {
    window.electronAPI.getProviderEnvConfig
      .mockResolvedValueOnce({
        success: true,
        providers: {
          kimi: { token: '' },
          aicodemirror: { token: '' },
        },
        envPath: '/tmp/mock/.env',
        error: null,
        errorCode: null,
      })
      .mockResolvedValue({
        success: true,
        providers: {
          kimi: { token: 'sk-kimi-updated-token' },
          aicodemirror: { token: '' },
        },
        envPath: '/tmp/mock/.env',
        error: null,
        errorCode: null,
      })

    render(<ApiConfigPage />)

    await waitFor(() => {
      expect(getCurrentProviderText()).toBe('Kimi For Coding')
    })

    const kimiCard = getProviderCard('Kimi For Coding')
    fireEvent.click(within(kimiCard).getByRole('button', { name: '编辑 API Key' }))
    const tokenInput = await screen.findByPlaceholderText('输入 API Key...')
    fireEvent.change(tokenInput, { target: { value: 'sk-kimi-updated-token' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(window.electronAPI.saveProviderToken).toHaveBeenCalledWith('kimi', 'sk-kimi-updated-token')
    })

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('输入 API Key...')).toBeNull()
    })

    const reopenedKimiCard = getProviderCard('Kimi For Coding')
    fireEvent.click(within(reopenedKimiCard).getByRole('button', { name: '编辑 API Key' }))
    const reopenedInput = await screen.findByPlaceholderText('输入 API Key...')
    expect(reopenedInput.value).toBe('sk-kimi-updated-token')

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('输入 API Key...')).toBeNull()
    })
  })
})
