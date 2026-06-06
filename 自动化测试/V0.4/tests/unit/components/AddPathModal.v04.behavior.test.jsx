/**
 * V0.4 添加路径弹窗测试
 *
 * 负责：
 * - 验证路径去重、扫描结果展示与确认按钮状态
 * - 覆盖扫描失败与用户取消等异常路径
 * - 锁定自定义路径添加前的前端校验行为
 *
 * @module 自动化测试/V0.4/tests/unit/components/AddPathModal.v04.behavior.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import AddPathModal from '@/components/AddPathModal.jsx'
import { dataStore } from '@/store/data.js'
import { selectFolder } from '@/store/fs.js'

vi.mock('@/store/data.js', () => ({
  dataStore: {
    scanCustomPath: vi.fn(),
  },
}))

vi.mock('@/store/fs.js', () => ({
  selectFolder: vi.fn(),
  scanCustomPath: vi.fn(),
}))

/**
 * 刷新微任务队列
 * @returns {Promise<void>}
 */
async function flushMicrotasks() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
    }
  })
}

describe('AddPathModal V0.4 Behavior (Unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('UT-FE-ADDPATH-01: 重复路径应提示“该路径已存在”', async () => {
    selectFolder.mockResolvedValue({
      success: true,
      canceled: false,
      path: '/workspace/team-skills',
      error: null,
    })

    render(
      <AddPathModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        existingPaths={[{ id: 'cp-1', path: '/workspace/team-skills' }]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '浏览...' }))
    await flushMicrotasks()

    expect(screen.getByText(/该路径已存在/)).toBeTruthy()
  })

  it('UT-FE-ADDPATH-02: 扫描无结果时应显示未找到 skills 且确认按钮禁用', async () => {
    selectFolder.mockResolvedValue({
      success: true,
      canceled: false,
      path: '/workspace/empty',
      error: null,
    })
    dataStore.scanCustomPath.mockResolvedValue({
      success: true,
      skills: {},
      error: null,
    })

    render(
      <AddPathModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        existingPaths={[]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '浏览...' }))
    await flushMicrotasks()

    expect(screen.getByText(/未找到 skills 目录/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认添加' }).disabled).toBe(true)
  })

  it('UT-FE-ADDPATH-03: 扫描成功后确认应回传 path 与 skills', async () => {
    const onConfirm = vi.fn()
    selectFolder.mockResolvedValue({
      success: true,
      canceled: false,
      path: '/workspace/project',
      error: null,
    })
    dataStore.scanCustomPath.mockResolvedValue({
      success: true,
      skills: { 'claude-code': 3, codex: 2 },
      error: null,
    })

    render(
      <AddPathModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        existingPaths={[]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '浏览...' }))
    await flushMicrotasks()

    expect(screen.getByText(/发现 5 个 skill/)).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认添加' }))
      await Promise.resolve()
    })
    expect(onConfirm).toHaveBeenCalledWith({
      path: '/workspace/project',
      skills: { 'claude-code': 3, codex: 2 },
    })
  })

  it('UT-FE-ADDPATH-04: 选择目录取消时不应报错也不应更新结果区', async () => {
    selectFolder.mockResolvedValue({
      success: false,
      canceled: true,
      path: null,
      error: null,
    })

    render(
      <AddPathModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        existingPaths={[]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '浏览...' }))
    await flushMicrotasks()

    expect(screen.queryByText(/发现 .* 个 skill/)).toBeNull()
    expect(screen.queryByText(/扫描失败/)).toBeNull()
  })

  it('UT-FE-ADDPATH-05: 扫描失败应显示错误提示', async () => {
    selectFolder.mockResolvedValue({
      success: true,
      canceled: false,
      path: '/workspace/broken',
      error: null,
    })
    dataStore.scanCustomPath.mockResolvedValue({
      success: false,
      skills: {},
      error: 'PERMISSION_DENIED',
    })

    render(
      <AddPathModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        existingPaths={[]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '浏览...' }))
    await flushMicrotasks()

    expect(screen.getByText(/扫描失败：PERMISSION_DENIED/)).toBeTruthy()
  })

  it('UT-FE-ADDPATH-06: 确认添加双击时只应触发一次 onConfirm', async () => {
    let resolveSubmit
    const onConfirm = vi.fn(() => new Promise((resolve) => {
      resolveSubmit = resolve
    }))

    selectFolder.mockResolvedValue({
      success: true,
      canceled: false,
      path: '/workspace/project',
      error: null,
    })
    dataStore.scanCustomPath.mockResolvedValue({
      success: true,
      skills: { codex: 2 },
      error: null,
    })

    render(
      <AddPathModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        existingPaths={[]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '浏览...' }))
    await flushMicrotasks()

    const confirmButton = screen.getByRole('button', { name: '确认添加' })
    await act(async () => {
      fireEvent.click(confirmButton)
      fireEvent.click(confirmButton)
      await Promise.resolve()
    })

    expect(onConfirm).toHaveBeenCalledTimes(1)
    // 确认按钮在提交中保持文案为“确认添加”，仅通过 loading 态自动 disabled
    expect(screen.getByRole('button', { name: '确认添加' }).disabled).toBe(true)

    resolveSubmit()
    await flushMicrotasks()
  })
})
