/**
 * V0.16 模型配置与推理等级页面集成测试
 *
 * 负责：
 * - 基于真实 React 页面验证模型配置 Tab 的读取/写入链路
 * - 验证空输入、并发防重、写入失败、重试恢复等关键分支
 * - 验证 model 与 effortLevel 的独立状态显示与高亮规则
 *
 * @module 自动化测试/V0.16/tests/integration/PermissionModePage.v16.model-config-flow.test
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
      mode: 'default',
      isConfigured: true,
      isKnownMode: true,
    }),
    setPermissionMode: vi.fn().mockResolvedValue({
      success: true,
      error: null,
      errorCode: null,
    }),
    getModelConfig: vi.fn().mockResolvedValue({
      success: true,
      model: 'opus[1m]',
      effortLevel: 'high',
      isModelConfigured: true,
      isEffortConfigured: true,
    }),
    setModelConfig: vi.fn().mockResolvedValue({
      success: true,
      error: null,
      errorCode: null,
    }),
    getModelRegistry: vi.fn().mockResolvedValue({
      success: true,
      source: 'packaged',
      registry: {
        version: 'test',
        models: [
          { id: 'opus[1m]', display: 'Opus (1M)', sublabel: '最强 · 1M' },
          { id: 'opus', display: 'Opus', sublabel: '最强 · 200K' },
          { id: 'sonnet', display: 'Sonnet', sublabel: '日常' },
          { id: 'sonnet[1m]', display: 'Sonnet (1M)', sublabel: '日常 · 1M' },
          { id: 'haiku', display: 'Haiku', sublabel: '快速' },
        ],
        effortLevels: [
          { id: 'low', display: '低', desc: '快速响应，适合简单问答' },
          { id: 'medium', display: '中', desc: '平衡速度与质量，Claude 默认值', isDefault: true },
          { id: 'high', display: '高', desc: '深度思考，适合复杂编码任务' },
          { id: 'xhigh', display: '超高', desc: 'Claude 4.7 新增，推理最充分，适合复杂架构与调试' },
        ],
      },
    }),
    ...overrides,
  }
}

/**
 * 打开模型配置 Tab
 * @returns {Promise<void>}
 */
async function openModelTab() {
  fireEvent.click(screen.getByRole('button', { name: '模型配置与推理等级' }))
  await screen.findByTestId('model-status-card')
}

describe('V0.16 Model Config Tab Formal Flow (Integration)', () => {
  beforeEach(() => {
    window.electronAPI = createElectronApiMock()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('TC-FE-01: 已配置态应显示状态卡并高亮对应 radio', async () => {
    render(<PermissionModePage />)
    await openModelTab()

    expect(screen.getByText('Opus (1M)')).toBeTruthy()
    expect(screen.getByTestId('model-radio-opus[1m]').className).toContain('is-selected')
    expect(screen.getByTestId('effort-radio-high').className).toContain('is-selected')
  })

  it('TC-FE-02: 部分配置时应独立展示未显式配置状态', async () => {
    window.electronAPI = createElectronApiMock({
      getModelConfig: vi.fn().mockResolvedValue({
        success: true,
        model: 'sonnet',
        effortLevel: null,
        isModelConfigured: true,
        isEffortConfigured: false,
      }),
    })

    render(<PermissionModePage />)
    await openModelTab()

    expect(screen.getByText('Sonnet')).toBeTruthy()
    expect(screen.getByText('未显式配置，使用 Claude 默认值')).toBeTruthy()
    expect(screen.getByTestId('model-radio-sonnet').className).toContain('is-selected')
    expect(screen.getByTestId('effort-radio-low').className).not.toContain('is-selected')
    expect(screen.getByTestId('effort-radio-high').className).not.toContain('is-selected')
  })

  it('TC-FE-03: 自定义模型值不匹配预设时预设 radio 不应高亮', async () => {
    window.electronAPI = createElectronApiMock({
      getModelConfig: vi.fn().mockResolvedValue({
        success: true,
        model: 'claude-opus-4-6',
        effortLevel: 'medium',
        isModelConfigured: true,
        isEffortConfigured: true,
      }),
    })

    render(<PermissionModePage />)
    await openModelTab()

    expect(screen.getByTestId('model-status-card').textContent).toContain('claude-opus-4-6')
    expect(screen.getByTestId('effort-radio-medium').className).toContain('is-selected')
    expect(screen.getByTestId('model-radio-default').className).not.toContain('is-selected')
    expect(screen.getByTestId('model-radio-opus[1m]').className).not.toContain('is-selected')
    expect(screen.getByTestId('model-radio-opus').className).not.toContain('is-selected')
    expect(screen.getByTestId('model-radio-sonnet').className).not.toContain('is-selected')
    expect(screen.getByTestId('model-radio-sonnet[1m]').className).not.toContain('is-selected')
    expect(screen.getByTestId('model-radio-haiku').className).not.toContain('is-selected')
  })

  it('TC-FE-04: 选择预设模型应触发写入并更新状态', async () => {
    const setModelConfig = vi.fn().mockResolvedValue({
      success: true,
      error: null,
      errorCode: null,
    })
    window.electronAPI = createElectronApiMock({ setModelConfig })

    render(<PermissionModePage />)
    await openModelTab()

    fireEvent.click(screen.getByTestId('model-radio-sonnet'))

    await waitFor(() => {
      expect(setModelConfig).toHaveBeenCalledWith('model', 'sonnet')
    })
    expect(screen.getByText('已切换默认模型为「Sonnet」')).toBeTruthy()
    expect(screen.getByTestId('model-radio-sonnet').className).toContain('is-selected')
  })

  it('TC-FE-05: 自定义模型为空时应提示错误且不写入', async () => {
    const setModelConfig = vi.fn()
    window.electronAPI = createElectronApiMock({ setModelConfig })

    render(<PermissionModePage />)
    await openModelTab()

    fireEvent.click(screen.getByTestId('model-custom-apply'))

    expect(screen.getByText('请输入模型标识')).toBeTruthy()
    expect(setModelConfig).toHaveBeenCalledTimes(0)
  })

  it('TC-FE-06: 自定义模型回车应等同点击应用', async () => {
    const setModelConfig = vi.fn().mockResolvedValue({
      success: true,
      error: null,
      errorCode: null,
    })
    window.electronAPI = createElectronApiMock({ setModelConfig })

    render(<PermissionModePage />)
    await openModelTab()

    fireEvent.change(screen.getByTestId('model-custom-input'), { target: { value: 'claude-opus-4-6' } })
    fireEvent.keyDown(screen.getByTestId('model-custom-input'), { key: 'Enter' })

    await waitFor(() => {
      expect(setModelConfig).toHaveBeenCalledWith('model', 'claude-opus-4-6')
    })
    expect(screen.getByText('已切换默认模型为「claude-opus-4-6」')).toBeTruthy()
    expect(screen.getByTestId('model-status-card').textContent).toContain('claude-opus-4-6')
  })

  it('TC-FE-07: 推理等级切换成功后应更新高亮与反馈', async () => {
    const setModelConfig = vi.fn().mockResolvedValue({
      success: true,
      error: null,
      errorCode: null,
    })
    window.electronAPI = createElectronApiMock({
      getModelConfig: vi.fn().mockResolvedValue({
        success: true,
        model: 'sonnet',
        effortLevel: 'medium',
        isModelConfigured: true,
        isEffortConfigured: true,
      }),
      setModelConfig,
    })

    render(<PermissionModePage />)
    await openModelTab()

    fireEvent.click(screen.getByTestId('effort-radio-low'))

    await waitFor(() => {
      expect(setModelConfig).toHaveBeenCalledWith('effortLevel', 'low')
    })
    expect(screen.getByText('已切换推理等级为「低」')).toBeTruthy()
    expect(screen.getByTestId('effort-radio-low').className).toContain('is-selected')
  })

  it('TC-FE-08: 写入中应全局禁用交互，完成后恢复', async () => {
    const deferred = createDeferred()
    const setModelConfig = vi.fn().mockReturnValueOnce(deferred.promise)
    window.electronAPI = createElectronApiMock({ setModelConfig })

    render(<PermissionModePage />)
    await openModelTab()

    fireEvent.click(screen.getByTestId('model-radio-haiku'))

    expect(screen.getByTestId('model-radio-sonnet').className).toContain('is-disabled')
    expect(screen.getByTestId('effort-radio-medium').className).toContain('is-disabled')
    expect(screen.getByTestId('model-custom-input').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('model-custom-apply').hasAttribute('disabled')).toBe(true)

    deferred.resolve({ success: true, error: null, errorCode: null })

    await waitFor(() => {
      expect(screen.getByText('已切换默认模型为「Haiku」')).toBeTruthy()
    })
    expect(screen.getByTestId('model-custom-input').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('model-custom-apply').hasAttribute('disabled')).toBe(false)
  })

  it('TC-FE-09: 写入失败应提示错误并保持原值', async () => {
    const setModelConfig = vi.fn().mockResolvedValue({
      success: false,
      error: '写入失败',
      errorCode: 'WRITE_ERROR',
    })
    window.electronAPI = createElectronApiMock({
      getModelConfig: vi.fn().mockResolvedValue({
        success: true,
        model: 'sonnet',
        effortLevel: 'high',
        isModelConfigured: true,
        isEffortConfigured: true,
      }),
      setModelConfig,
    })

    render(<PermissionModePage />)
    await openModelTab()

    fireEvent.click(screen.getByTestId('model-radio-haiku'))

    await waitFor(() => {
      expect(screen.getByText('写入失败')).toBeTruthy()
    })
    expect(screen.getByTestId('model-radio-sonnet').className).toContain('is-selected')
    expect(screen.getByTestId('model-radio-haiku').className).not.toContain('is-selected')
  })

  it('TC-FE-10: 读取失败态应支持重试恢复', async () => {
    const getModelConfig = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        error: 'settings.json JSON 解析错误: Unexpected token',
        errorCode: 'JSON_PARSE_ERROR',
      })
      .mockResolvedValueOnce({
        success: true,
        model: 'haiku',
        effortLevel: 'low',
        isModelConfigured: true,
        isEffortConfigured: true,
      })
    window.electronAPI = createElectronApiMock({ getModelConfig })

    render(<PermissionModePage />)
    fireEvent.click(screen.getByRole('button', { name: '模型配置与推理等级' }))
    await screen.findByText(/JSON 解析错误/)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await screen.findByTestId('model-status-card')
    expect(screen.getByText('Haiku')).toBeTruthy()
    expect(getModelConfig).toHaveBeenCalledTimes(2)
  })

  it('TC-FE-11: 幂等点击当前选项不应触发写入', async () => {
    const setModelConfig = vi.fn()
    window.electronAPI = createElectronApiMock({
      getModelConfig: vi.fn().mockResolvedValue({
        success: true,
        model: 'sonnet',
        effortLevel: 'medium',
        isModelConfigured: true,
        isEffortConfigured: true,
      }),
      setModelConfig,
    })

    render(<PermissionModePage />)
    await openModelTab()

    fireEvent.click(screen.getByTestId('model-radio-sonnet'))
    fireEvent.click(screen.getByTestId('effort-radio-medium'))

    expect(setModelConfig).toHaveBeenCalledTimes(0)
  })
})
