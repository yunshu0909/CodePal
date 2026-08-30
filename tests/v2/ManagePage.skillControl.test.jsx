/**
 * v2.0 Skill 控制中心页面状态测试
 *
 * @module tests/v2/ManagePageSkillControl
 */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import ManagePage from '../../src/pages/ManagePage'
import { dataStore } from '../../src/store/data'

// Trace targets: SC-002 loading state; SC-003 empty state;
// SC-004 fatal error and retry; SC-007 stale refresh suppression.

vi.mock('../../src/hooks/useSkillUsage', () => ({
  default: () => ({ status: 'ready', usageMap: new Map(), sources: {} }),
}))
vi.mock('../../src/hooks/useTagManagement', () => ({
  default: () => ({
    tags: [], skillTags: {}, activeTagFilter: null, setActiveTagFilter: vi.fn(),
    isTagModalOpen: false, setIsTagModalOpen: vi.fn(), loadTagData: vi.fn(async () => {}),
    handleAssignTag: vi.fn(), handleRemoveTag: vi.fn(), handleCreateTag: vi.fn(),
    handleRenameTag: vi.fn(), handleDeleteTag: vi.fn(),
  }),
}))
vi.mock('../../src/store/data', () => ({
  dataStore: {
    getCentralSkills: vi.fn(async () => []),
    getRepoPath: vi.fn(async () => '/tmp/catalog'),
    getPushTargets: vi.fn(async () => []),
    isPushed: vi.fn(async () => false),
  },
  toolDefinitions: [],
}))

function readySnapshot(overrides = {}) {
  return {
    partial: false,
    errors: [],
    central: { available: true, exists: true, skillCount: 0 },
    tools: {
      'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, skillCount: 0 },
      codex: { id: 'codex', name: 'Codex', available: true, skillCount: 0 },
    },
    skills: [],
    summary: { managed: 0, claudeEnabled: 0, codexEnabled: 0, protected: 0 },
    ...overrides,
  }
}

describe('ManagePage v2 Skill control states', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dataStore.getCentralSkills.mockResolvedValue([])
    window.electronAPI = {
      getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: readySnapshot() })),
      executeSkillCommand: vi.fn(),
    }
  })

  afterEach(() => cleanup())

  it('SC-002 shows a non-interactive loading state', async () => {
    window.electronAPI.getSkillControlSnapshot.mockImplementation(() => new Promise(() => {}))
    render(<ManagePage onNavigateToConfig={vi.fn()} />)
    expect(await screen.findByText('正在读取真实 Skill 状态')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '从工具移除' })).toBeNull()
  })

  it('SC-003 shows the central empty state and external next step', async () => {
    render(<ManagePage onNavigateToConfig={vi.fn()} />)
    expect(await screen.findByText('中央仓库还没有 Skill')).toBeTruthy()
    expect(screen.getByText('查看外部 Skill')).toBeTruthy()
  })

  it('SC-004 explains that a fatal read failure did not mutate directories and retries', async () => {
    window.electronAPI.getSkillControlSnapshot.mockResolvedValue({ success: false, error: 'PERMISSION_DENIED' })
    render(<ManagePage onNavigateToConfig={vi.fn()} />)
    expect(await screen.findByText('Skill 状态读取失败')).toBeTruthy()
    expect(screen.getByText('没有修改任何目录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(window.electronAPI.getSkillControlSnapshot).toHaveBeenCalledTimes(2))
  })

  it('SC-005 preserves the matrix while showing a partial-source warning', async () => {
    const snapshot = readySnapshot({
      partial: true,
      errors: [{ toolId: 'codex', origin: 'legacy', code: 'PERMISSION_DENIED' }],
      central: { available: true, exists: true, skillCount: 1 },
      skills: [{
        name: 'safe-skill',
        managed: true,
        origins: [{ toolId: 'claude-code', origin: 'user', mutable: true }],
        tools: {
          'claude-code': { enabled: true, state: 'synced', mutable: true },
          codex: { enabled: null, state: 'unavailable', mutable: false },
        },
      }],
      summary: { managed: 1, claudeEnabled: 1, codexEnabled: 0, protected: 0 },
    })
    window.electronAPI.getSkillControlSnapshot.mockResolvedValue({ success: true, data: snapshot })
    dataStore.getCentralSkills.mockResolvedValue([{ id: 'safe-skill', name: 'safe-skill', displayName: 'safe-skill', desc: '' }])
    render(<ManagePage onNavigateToConfig={vi.fn()} />)
    expect(await screen.findByText('safe-skill')).toBeTruthy()
    expect(screen.getByText(/Codex 兼容路径暂时不可读/)).toBeTruthy()
  })

  it('SC-007 stale refresh suppression keeps the latest snapshot', async () => {
    const deferred = []
    window.electronAPI = {
      getSkillControlSnapshot: vi.fn(() => new Promise((resolve) => deferred.push(resolve))),
    }
    const hookPath = '../../src/hooks/useSkillControl'
    let actual
    try {
      actual = await import(/* @vite-ignore */ hookPath)
    } catch (error) {
      throw new Error(`not implemented: ${error.message}`)
    }
    const { result, rerender } = renderHook(
      ({ signal }) => actual.default(signal),
      { initialProps: { signal: 0 } }
    )
    await waitFor(() => expect(deferred).toHaveLength(1))
    rerender({ signal: 1 })
    await waitFor(() => expect(deferred).toHaveLength(2))

    await act(async () => deferred[1]({ success: true, data: readySnapshot({ generation: 'new' }) }))
    await waitFor(() => expect(result.current.snapshot?.generation).toBe('new'))
    await act(async () => deferred[0]({ success: true, data: readySnapshot({ generation: 'old' }) }))
    expect(result.current.snapshot?.generation).toBe('new')
  })
})
