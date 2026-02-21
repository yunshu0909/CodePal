/**
 * V0.12 启动模式页面集成测试
 *
 * 负责：
 * - 基于真实 React 页面验证 6 态渲染分支
 * - 验证切换流程的防重、成功与失败反馈
 * - 验证读取失败后的重试恢复链路
 *
 * @module 自动化测试/V0.12/tests/integration/PermissionModePage.v12.formal-flow.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PermissionModePage from '@/pages/PermissionModePage.jsx'

/**
 * 创建延迟完成 Promise
 * @returns {{promise: Promise<any>, resolve: Function, reject: Function}}
 */
function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * 构造默认 electronAPI mock
 * @param {object} [overrides={}] - 覆盖项
 * @returns {object}
 */
function createElectronApiMock(overrides = {}) {
  return {
    getPermissionModeConfig: vi.fn().mockResolvedValue({
      success: true,
      mode: 'acceptEdits',
      isConfigured: true,
      isKnownMode: true,
    }),
    setPermissionMode: vi.fn().mockResolvedValue({
      success: true,
      error: null,
      errorCode: null,
    }),
    ...overrides,
  }
}

describe('V0.12 Permission Mode Page Formal Flow (Integration)', () => {
  beforeEach(() => {
    window.electronAPI = createElectronApiMock()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('TC-FE-01: 已知模式加载后应高亮当前模式', async () => {
    render(<PermissionModePage />)

    await screen.findByTestId('permission-mode-section')

    expect(screen.getByTestId('permission-current-mode').textContent).toContain('自动编辑')
    expect(screen.getByTestId('permission-tag-current-acceptEdits')).toBeTruthy()
  })

  it('TC-FE-02: 未配置态应高亮 default 并展示当前使用标签', async () => {
    window.electronAPI = createElectronApiMock({
      getPermissionModeConfig: vi.fn().mockResolvedValue({
        success: true,
        mode: null,
        isConfigured: false,
        isKnownMode: true,
      }),
    })

    render(<PermissionModePage />)

    await screen.findByTestId('permission-mode-section')

    expect(screen.getByTestId('permission-current-mode').textContent).toContain('每次询问')
    expect(screen.getByTestId('permission-tag-current-default')).toBeTruthy()
  })

  it('TC-FE-03: 未知模式态应展示警告 Banner 且无当前标签', async () => {
    window.electronAPI = createElectronApiMock({
      getPermissionModeConfig: vi.fn().mockResolvedValue({
        success: true,
        mode: 'dontAsk',
        isConfigured: true,
        isKnownMode: false,
      }),
    })

    render(<PermissionModePage />)

    await screen.findByTestId('permission-warn-banner')
    expect(screen.getByTestId('permission-warn-banner').textContent).toContain('未知的启动模式')
    expect(screen.queryByText('当前使用')).toBeNull()
  })

  it('TC-FE-04: 读取失败态点击重试后应恢复正常', async () => {
    const getPermissionModeConfig = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        error: 'settings.json JSON 解析错误: Unexpected token',
        errorCode: 'JSON_PARSE_ERROR',
      })
      .mockResolvedValueOnce({
        success: true,
        mode: 'plan',
        isConfigured: true,
        isKnownMode: true,
      })

    window.electronAPI = createElectronApiMock({ getPermissionModeConfig })

    render(<PermissionModePage />)

    await screen.findByTestId('permission-error-state')
    expect(screen.getByTestId('permission-error-message').textContent).toContain('JSON 解析错误')

    fireEvent.click(screen.getByTestId('permission-retry-button'))

    await screen.findByTestId('permission-mode-section')
    expect(screen.getByTestId('permission-current-mode').textContent).toContain('只读规划')
    expect(getPermissionModeConfig).toHaveBeenCalledTimes(2)
  })

  it('TC-FE-05: 切换成功时应展示切换中状态并更新成功反馈', async () => {
    const deferred = createDeferred()
    const setPermissionMode = vi.fn().mockReturnValueOnce(deferred.promise)

    window.electronAPI = createElectronApiMock({
      getPermissionModeConfig: vi.fn().mockResolvedValue({
        success: true,
        mode: 'default',
        isConfigured: true,
        isKnownMode: true,
      }),
      setPermissionMode,
    })

    render(<PermissionModePage />)

    await screen.findByTestId('permission-mode-section')
    fireEvent.click(screen.getByTestId('permission-switch-button-acceptEdits'))

    expect(screen.getByText('切换中...')).toBeTruthy()
    expect(screen.getByTestId('permission-switch-button-plan').disabled).toBe(true)
    expect(screen.queryByTestId('permission-switch-button-default')).toBeNull()
    expect(screen.getByTestId('permission-switch-button-acceptEdits').disabled).toBe(true)
    expect(screen.getByTestId('permission-switch-button-bypassPermissions').disabled).toBe(true)

    deferred.resolve({ success: true, error: null, errorCode: null })

    await waitFor(() => {
      expect(screen.getByText('已切换至「自动编辑」')).toBeTruthy()
    })
    expect(setPermissionMode).toHaveBeenCalledWith('acceptEdits')
    expect(screen.getByTestId('permission-current-mode').textContent).toContain('自动编辑')
  })

  it('TC-FE-06: 切换失败应显示错误 Toast 且保持旧模式', async () => {
    const setPermissionMode = vi.fn().mockResolvedValue({
      success: false,
      error: '写入失败',
      errorCode: 'WRITE_ERROR',
    })

    window.electronAPI = createElectronApiMock({
      getPermissionModeConfig: vi.fn().mockResolvedValue({
        success: true,
        mode: 'plan',
        isConfigured: true,
        isKnownMode: true,
      }),
      setPermissionMode,
    })

    render(<PermissionModePage />)

    await screen.findByTestId('permission-mode-section')
    fireEvent.click(screen.getByTestId('permission-switch-button-bypassPermissions'))

    await waitFor(() => {
      expect(screen.getByText('切换失败，无法写入配置文件')).toBeTruthy()
    })

    expect(screen.getByTestId('permission-current-mode').textContent).toContain('只读规划')
    expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
  })

  it('TC-FE-07: 当前模式项不显示启用按钮以避免重复触发', async () => {
    const setPermissionMode = vi.fn()

    window.electronAPI = createElectronApiMock({
      getPermissionModeConfig: vi.fn().mockResolvedValue({
        success: true,
        mode: 'default',
        isConfigured: true,
        isKnownMode: true,
      }),
      setPermissionMode,
    })

    render(<PermissionModePage />)

    await screen.findByTestId('permission-mode-section')

    expect(screen.queryByTestId('permission-switch-button-default')).toBeNull()
    expect(setPermissionMode).toHaveBeenCalledTimes(0)
  })
})
