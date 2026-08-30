/**
 * v2.1 Plugin 控制中心页面测试
 *
 * @module tests/v21/PluginControlPage
 */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PluginControlPage from '../../src/pages/PluginControlPage'

function snapshot(overrides = {}) {
  return {
    partial: false,
    errors: [],
    tools: {
      codex: { id: 'codex', name: 'Codex', available: true },
      'claude-code': { id: 'claude-code', name: 'Claude Code', available: true },
    },
    plugins: [{ id: 'docs@official', name: 'docs', toolId: 'codex', installed: true, enabled: true, version: '1.2.3', marketplace: 'official', scope: 'user', updateAvailable: false, auth: { policy: 'ON_USE', status: 'on-use' }, capabilities: { skills: 2, commands: 0, mcp: 1, hooks: 0, connectors: 0, agents: 0 } }],
    summary: { installed: 1, enabled: 1, available: 0, updates: 0, authRequired: 0 },
    ...overrides,
  }
}

describe('PluginControlPage', () => {
  beforeEach(() => {
    window.confirm = vi.fn(() => true)
    window.electronAPI = {
      getPluginControlSnapshot: vi.fn(async () => ({ success: true, data: snapshot() })),
      executePluginCommand: vi.fn(async () => ({ success: true, snapshot: snapshot({ plugins: [] }) })),
    }
  })
  afterEach(() => cleanup())

  it('SC-108 shows provider, version, source, capabilities and details', async () => {
    render(<PluginControlPage />)
    expect(await screen.findByText('docs')).toBeTruthy()
    expect(screen.getByText('1.2.3')).toBeTruthy()
    expect(screen.getByText('official')).toBeTruthy()
    expect(screen.getByText(/2 Skills/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /查看 docs 详情/ }))
    expect(screen.getByText('Plugin 详情')).toBeTruthy()
    expect(screen.getByText('ON_USE')).toBeTruthy()
  })

  it('SC-102 renders loading, fatal error and partial warning without write actions', async () => {
    window.electronAPI.getPluginControlSnapshot.mockImplementation(() => new Promise(() => {}))
    const view = render(<PluginControlPage />)
    expect(await screen.findByText('正在读取真实 Plugin 状态')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /卸载/ })).toBeNull()
    view.unmount()

    window.electronAPI.getPluginControlSnapshot.mockResolvedValue({ success: false, error: 'CLI_NOT_AVAILABLE' })
    render(<PluginControlPage />)
    expect(await screen.findByText('Plugin 状态读取失败')).toBeTruthy()
    expect(screen.getByText('没有修改任何 Plugin')).toBeTruthy()
  })

  it('SC-110 requires uninstall confirmation and locks only the target operation', async () => {
    render(<PluginControlPage />)
    await screen.findByText('docs')
    window.confirm.mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: '卸载 docs' }))
    expect(window.electronAPI.executePluginCommand).not.toHaveBeenCalled()

    window.confirm.mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: '卸载 docs' }))
    await waitFor(() => expect(window.electronAPI.executePluginCommand).toHaveBeenCalledWith(expect.objectContaining({ pluginId: 'docs@official', action: 'uninstall' })))
  })

  it('SC-108 explains when a managed plugin cannot be changed', async () => {
    window.electronAPI.executePluginCommand.mockResolvedValue({ success: false, error: 'PLUGIN_MANAGED_OR_PROTECTED' })
    render(<PluginControlPage />)
    await screen.findByText('docs')
    fireEvent.click(screen.getByRole('button', { name: '停用' }))
    expect(await screen.findByText('该 Plugin 由工具或管理员管理，不能在 CodePal 中修改')).toBeTruthy()
  })
})
