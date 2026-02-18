/**
 * V0.9 新建项目页面正式版集成测试
 *
 * 负责：
 * - 基于真实 React 页面验证项目初始化参数收集链路
 * - 验证 validate/execute 成功与失败的前端行为
 * - 验证模板、Git、覆盖开关与路径浏览交互
 *
 * @module 自动化测试/V0.9/tests/integration/ProjectInitPage.v09.formal-flow.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ProjectInitPage from '@/pages/ProjectInitPage.jsx'

describe('V0.9 Project Init Formal Flow (Integration)', () => {
  beforeEach(() => {
    // 默认 mock：成功校验 + 成功执行，具体用例可覆盖
    window.electronAPI = {
      selectFolder: vi.fn().mockResolvedValue({
        success: true,
        canceled: false,
        path: '/tmp/mock-selected-path',
        error: null,
      }),
      validateProjectInit: vi.fn().mockResolvedValue({
        success: true,
        valid: true,
        error: null,
        data: {
          errors: [],
          conflicts: [],
          warnings: [],
        },
      }),
      executeProjectInit: vi.fn().mockResolvedValue({
        success: true,
        error: null,
        data: {
          validation: {
            data: {
              resolvedPaths: {
                projectRoot: '/tmp/mock-selected-path/demo-success',
              },
            },
          },
          summary: {
            createdDirectories: ['/tmp/mock-selected-path/demo-success/prd', '/tmp/mock-selected-path/demo-success/design', '/tmp/mock-selected-path/demo-success/code'],
          },
          steps: [
            { step: 'CREATE_DIRECTORY', status: 'success', path: '/tmp/demo/prd', code: null, message: 'ok' },
          ],
          rollback: {
            attempted: false,
            success: true,
          },
        },
      }),
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('TC-S1-FE-01: 默认态应展示双栏结构且创建按钮禁用', () => {
    render(<ProjectInitPage />)

    expect(screen.getByTestId('project-init-two-column')).toBeTruthy()
    expect(screen.getByTestId('project-name-input').value).toBe('')
    expect(screen.getByTestId('target-path-input').value).toBe('~/Documents/projects/')
    expect(screen.getByTestId('project-tree-root').textContent).toContain('my-awesome-project/')
    expect(screen.getByTestId('create-project-button').disabled).toBe(true)
  })

  it('TC-S1-FE-02: Git 与模板切换应实时刷新预览树', () => {
    render(<ProjectInitPage />)

    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'demo-v09' } })
    expect(screen.getByTestId('project-tree-root').textContent).toContain('demo-v09/')

    expect(screen.queryByTestId('project-tree-git-root')).toBeTruthy()
    fireEvent.click(screen.getByTestId('git-mode-code'))
    expect(screen.queryByTestId('project-tree-git-root')).toBeNull()
    expect(screen.getByTestId('project-tree-git-code')).toBeTruthy()

    expect(screen.queryByTestId('project-tree-design-system')).toBeTruthy()
    fireEvent.click(screen.getByTestId('template-pill-design'))
    expect(screen.queryByTestId('project-tree-design-system')).toBeNull()
  })

  it('TC-S2-FE-01: 浏览目录成功后应更新目标路径输入框', async () => {
    render(<ProjectInitPage />)

    fireEvent.click(screen.getByTestId('target-path-browse-button'))

    await waitFor(() => {
      expect(window.electronAPI.selectFolder).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('target-path-input').value).toBe('/tmp/mock-selected-path')
    })
  })

  it('TC-S2-IT-01: validate 失败时应展示错误且不触发 execute', async () => {
    window.electronAPI.validateProjectInit.mockResolvedValueOnce({
      success: true,
      valid: false,
      error: 'VALIDATION_FAILED',
      data: {
        errors: [{ code: 'TARGET_CONFLICT', message: '目标冲突', path: '/tmp/mock/demo/AGENTS.md' }],
        conflicts: [{ type: 'FILE_EXISTS' }],
      },
    })

    render(<ProjectInitPage />)
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'demo-fail' } })
    fireEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() => {
      expect(window.electronAPI.validateProjectInit).toHaveBeenCalledTimes(1)
    })

    expect(window.electronAPI.executeProjectInit).toHaveBeenCalledTimes(0)
    expect(screen.getByTestId('project-init-validation-result')).toBeTruthy()
    expect(screen.getByText(/TARGET_CONFLICT/)).toBeTruthy()
  })

  it('TC-S2-IT-02: validate+execute 成功时应提交正确参数并展示成功弹窗', async () => {
    render(<ProjectInitPage />)

    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'demo-success' } })
    fireEvent.change(screen.getByTestId('target-path-input'), { target: { value: '/tmp/project-root' } })
    fireEvent.click(screen.getByTestId('template-pill-claude'))
    fireEvent.click(screen.getByTestId('git-mode-none'))
    fireEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() => {
      expect(window.electronAPI.validateProjectInit).toHaveBeenCalledTimes(1)
      expect(window.electronAPI.executeProjectInit).toHaveBeenCalledTimes(1)
    })

    const requestPayload = window.electronAPI.validateProjectInit.mock.calls[0][0]
    expect(requestPayload.projectName).toBe('demo-success')
    expect(requestPayload.targetPath).toBe('/tmp/project-root')
    expect(requestPayload.gitMode).toBe('none')
    expect(requestPayload.overwrite).toBe(false)
    // 关闭 CLAUDE 模板后仅保留 AGENTS + design
    expect(requestPayload.templates).toEqual(['agents', 'design'])

    expect(screen.getByTestId('project-init-success-modal')).toBeTruthy()
    expect(screen.getByTestId('project-init-success-path').textContent).toBe('/tmp/mock-selected-path/demo-success')
    expect(screen.getByTestId('project-init-success-dir-count').textContent).toBe('3 个')
    expect(screen.getByTestId('project-init-success-config-status').textContent).toBe('已生成')
  })

  it('TC-S2-IT-04: 成功弹窗确认后应重置页面', async () => {
    render(<ProjectInitPage />)

    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'demo-reset' } })
    fireEvent.change(screen.getByTestId('target-path-input'), { target: { value: '/tmp/mock-selected-path' } })
    fireEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() => {
      expect(screen.getByTestId('project-init-success-modal')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('project-init-success-confirm-button'))

    await waitFor(() => {
      expect(screen.queryByTestId('project-init-success-modal')).toBeNull()
    })

    expect(screen.getByTestId('project-name-input').value).toBe('')
    expect(screen.getByTestId('target-path-input').value).toBe('~/Documents/projects/')
  })

  it('TC-S2-IT-03: execute 失败时应展示失败步骤与回滚状态', async () => {
    window.electronAPI.executeProjectInit.mockResolvedValueOnce({
      success: false,
      error: 'GIT_NOT_INSTALLED',
      data: {
        steps: [
          {
            step: 'EXECUTION_FAILED',
            status: 'failed',
            path: '/tmp/demo',
            code: 'GIT_NOT_INSTALLED',
            message: '未检测到 Git',
          },
        ],
        rollback: {
          attempted: true,
          success: true,
          steps: [],
        },
      },
    })

    render(<ProjectInitPage />)
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'demo-git-fail' } })
    fireEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() => {
      expect(window.electronAPI.executeProjectInit).toHaveBeenCalledTimes(1)
    })

    expect(screen.getByTestId('project-init-execution-failed')).toBeTruthy()
    expect(screen.getByText(/GIT_NOT_INSTALLED/)).toBeTruthy()
    expect(screen.getByText('回滚状态：成功')).toBeTruthy()
  })
})
