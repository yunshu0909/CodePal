/**
 * V0.9 新建项目页面正式版集成测试
 *
 * 负责：
 * - 基于真实 React 页面验证项目初始化参数收集链路
 * - 验证成功/失败统一弹窗结果展示
 * - 验证失败弹窗的关闭与重试交互
 *
 * @module 自动化测试/V0.9/tests/integration/ProjectInitPage.v09.formal-flow.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ProjectInitPage from '@/pages/ProjectInitPage.jsx'

/**
 * 构造默认成功执行返回
 * @param {string} projectRoot - 项目根路径
 * @returns {object}
 */
function buildExecuteSuccessResult(projectRoot) {
  return {
    success: true,
    error: null,
    data: {
      validation: {
        data: {
          resolvedPaths: {
            projectRoot,
          },
          plannedDirectories: [
            `${projectRoot}/prd`,
            `${projectRoot}/design`,
            `${projectRoot}/code`,
          ],
        },
      },
      summary: {
        createdDirectories: [
          `${projectRoot}/prd`,
          `${projectRoot}/design`,
          `${projectRoot}/code`,
        ],
      },
      steps: [
        { step: 'CREATE_DIRECTORY', status: 'success', path: `${projectRoot}/prd`, code: null, message: 'ok' },
      ],
      rollback: {
        attempted: false,
        success: true,
      },
    },
  }
}

describe('V0.9 Project Init Formal Flow (Integration)', () => {
  beforeEach(() => {
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
      executeProjectInit: vi.fn().mockResolvedValue(
        buildExecuteSuccessResult('/tmp/mock-selected-path/demo-success')
      ),
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

  it('TC-S2-IT-01: 校验失败时应展示失败弹窗且不触发 execute', async () => {
    window.electronAPI.validateProjectInit.mockResolvedValueOnce({
      success: true,
      valid: false,
      error: 'VALIDATION_FAILED',
      data: {
        errors: [{ code: 'TARGET_CONFLICT', message: '目标路径存在冲突', path: '/tmp/mock/demo/AGENTS.md' }],
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
    expect(screen.getByTestId('project-init-error-modal')).toBeTruthy()
    expect(screen.getByText('创建前校验未通过')).toBeTruthy()
    expect(screen.getByText('目标路径存在冲突')).toBeTruthy()
    expect(screen.getByText('提示：请更换项目名称或删除现有目录后重试')).toBeTruthy()
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
    expect(requestPayload.templates).toEqual(['agents', 'design'])

    expect(screen.getByTestId('project-init-success-modal')).toBeTruthy()
    expect(screen.getByTestId('project-init-success-path').textContent).toBe('/tmp/mock-selected-path/demo-success')
    expect(screen.getByTestId('project-init-success-dir-count').textContent).toBe('3 个')
    expect(screen.getByTestId('project-init-success-config-status').textContent).toBe('已生成')
  })

  it('TC-S2-IT-03: 成功弹窗确认后应重置页面', async () => {
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
    expect(screen.getByTestId('git-mode-root').className).toContain('selected')
  })

  it('TC-S2-IT-04: execute 失败时应展示失败弹窗并可关闭', async () => {
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

    expect(screen.getByTestId('project-init-error-modal')).toBeTruthy()
    expect(screen.getByText('项目创建失败')).toBeTruthy()
    expect(screen.getByText('GIT_NOT_INSTALLED')).toBeTruthy()
    expect(screen.getByText('提示：未检测到 Git')).toBeTruthy()

    fireEvent.click(screen.getByTestId('project-init-error-close-button'))
    await waitFor(() => {
      expect(screen.queryByTestId('project-init-error-modal')).toBeNull()
    })
  })

  it('TC-S2-IT-05: execute 失败后点击重试应再次执行并在成功后展示成功弹窗', async () => {
    window.electronAPI.executeProjectInit
      .mockResolvedValueOnce({
        success: false,
        error: 'GIT_NOT_INSTALLED',
        data: {
          steps: [{ step: 'EXECUTION_FAILED', status: 'failed', message: '未检测到 Git' }],
          rollback: { attempted: true, success: true, steps: [] },
        },
      })
      .mockResolvedValueOnce(buildExecuteSuccessResult('/tmp/mock-selected-path/demo-retry-ok'))

    render(<ProjectInitPage />)
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'demo-retry' } })
    fireEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() => {
      expect(screen.getByTestId('project-init-error-modal')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('project-init-error-retry-button'))

    await waitFor(() => {
      expect(window.electronAPI.executeProjectInit).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByTestId('project-init-success-modal')).toBeTruthy()
    expect(screen.queryByTestId('project-init-error-modal')).toBeNull()
  })
})
