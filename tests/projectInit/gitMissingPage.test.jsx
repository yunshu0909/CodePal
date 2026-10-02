/**
 * 新建项目页 · 打开时已没装 Git（specs/v2.1.7-新建项目小修 TC-006，保持现状的守卫）
 *
 * 负责：页面检测到没装 Git 时 Git 分段停在跳过、整组不能改，说明位给出原因。
 * 主进程接口用替身（window.electronAPI），不真的建项目。
 *
 * @module tests/projectInit/gitMissingPage
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import ProjectInitPage from '../../src/pages/ProjectInitPage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete window.electronAPI
})

describe('打开页面时已没装 Git', () => {
  it('TC-006 Git 分段停在跳过、整组不能改', async () => {
    window.electronAPI = {
      checkGitAvailable: vi.fn(async () => ({ success: true, data: { available: false } })),
      validateProjectInit: vi.fn(async () => ({ success: true, valid: true, data: { errors: [] } })),
      executeProjectInit: vi.fn(),
      selectFolder: vi.fn(),
    }
    render(<ProjectInitPage />)
    await waitFor(() => expect(screen.getByText('本机没装 Git，只能先跳过')).toBeTruthy())
    expect(screen.getByRole('radio', { name: '跳过' })).toHaveAttribute('aria-checked', 'true')
    for (const name of ['双层', '只给代码建仓', '跳过']) {
      expect(screen.getByRole('radio', { name })).toBeDisabled()
    }
  })
})
