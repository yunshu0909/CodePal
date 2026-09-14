/**
 * 权限模式页面收归回归测试
 *
 * 负责：
 * - 固定六种 Claude 权限模式的页面契约
 * - 保证读取未配置状态不会产生写入
 * - 验证 reset / restore 用户入口调用精确 IPC
 *
 * @module tests/permissionModePage.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PermissionModePage from '../src/pages/PermissionModePage'

describe('PermissionModePage 六模式与未配置语义', () => {
  beforeEach(() => {
    window.electronAPI = {
      getPermissionModeConfig: vi.fn(async () => ({
        success: true,
        mode: null,
        isConfigured: false,
        isKnownMode: true,
        restoreAvailable: false,
      })),
      setPermissionMode: vi.fn(async () => ({ success: true })),
      resetPermissionMode: vi.fn(async () => ({ success: true })),
      restorePermissionMode: vi.fn(async () => ({ success: true, mode: 'plan', isConfigured: true })),
      getModelConfig: vi.fn(async () => ({ success: true, model: 'opus', effortLevel: 'high', isModelConfigured: true, isEffortConfigured: true })),
      getModelRegistry: vi.fn(async () => ({ success: false })),
      setModelConfig: vi.fn(async () => ({ success: true })),
      resetModelConfig: vi.fn(async () => ({ success: true })),
    }
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete window.electronAPI
  })

  it('SC-001/009: 展示六种模式且读取未配置状态绝不自动写 default', async () => {
    render(<PermissionModePage />)

    await screen.findByText('未配置 · 由 Claude 决定')
    const expected = ['plan', 'default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto']
    expect(screen.getByTestId('permission-mode-list').children).toHaveLength(expected.length)
    for (const id of expected) expect(screen.getByTestId(`permission-mode-item-${id}`)).toBeVisible()
    expect(window.electronAPI.setPermissionMode).not.toHaveBeenCalled()
  })

  it('SC-010: 已配置时提供恢复客户端默认和恢复上次修改', async () => {
    window.electronAPI.getPermissionModeConfig.mockResolvedValue({
      success: true,
      mode: 'default',
      isConfigured: true,
      isKnownMode: true,
      restoreAvailable: true,
    })
    render(<PermissionModePage />)

    fireEvent.click(await screen.findByRole('button', { name: '恢复客户端默认' }))
    await waitFor(() => expect(window.electronAPI.resetPermissionMode).toHaveBeenCalledTimes(1))

    window.electronAPI.getPermissionModeConfig.mockResolvedValue({
      success: true,
      mode: null,
      isConfigured: false,
      isKnownMode: true,
      restoreAvailable: true,
    })
    fireEvent.click(screen.getByRole('button', { name: '恢复上次修改' }))
    await waitFor(() => expect(window.electronAPI.restorePermissionMode).toHaveBeenCalledTimes(1))
  })

  it('SC-011: 模型页明确提示会同时恢复模型和推理强度，并走单次 reset IPC', async () => {
    render(<PermissionModePage />)
    fireEvent.click(screen.getByRole('button', { name: '模型配置与推理等级' }))
    await screen.findByTestId('model-status-card')
    fireEvent.click(screen.getByRole('button', { name: '恢复模型和推理强度默认' }))
    await waitFor(() => expect(window.electronAPI.resetModelConfig).toHaveBeenCalledTimes(1))
    expect(window.electronAPI.setModelConfig).not.toHaveBeenCalledWith('model', '')
  })
})
