/**
 * SkillRunSamplesModal — 调用记录弹窗前端测试
 *
 * 覆盖：调用记录字段、可用/失效、空态、失败态、长 session ID，
 * 以及禁止 raw/logical/usable 和用户正文回流 UI。
 *
 * @module 自动化测试/skill-usage/tests/frontend/SkillRunSamplesModal.test
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import SkillRunSamplesModal from '@/components/skillUsage/SkillRunSamplesModal'

function mockListSkillRunSamples(response) {
  const listSkillRunSamples = vi.fn().mockResolvedValue(response)
  Object.defineProperty(window, 'electronAPI', {
    value: { listSkillRunSamples },
    writable: true,
    configurable: true,
  })
  return listSkillRunSamples
}

function record(overrides = {}) {
  return {
    schemaVersion: 2,
    invocationId: 'invocation-1',
    skillName: 'goal-setter',
    tool: 'codex',
    triggerType: 'goal_directive',
    triggeredAt: '2026-07-25T10:00:00.000Z',
    session: {
      id: '80000000-0000-4000-8000-000000000001',
      relativePath: '2026/07/25/rollout.jsonl',
    },
    sourceLine: 12,
    classifierVersion: 'skill-invocation-v2',
    sourceAvailable: 'available',
    ...overrides,
  }
}

describe('SkillRunSamplesModal', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete window.electronAPI
    document.body.style.overflow = ''
  })

  it('成功态只展示时间/工具/触发方式/session/可用性', async () => {
    const listSkillRunSamples = mockListSkillRunSamples({
      success: true,
      data: { records: [record()] },
    })

    render(
      <SkillRunSamplesModal
        open
        onClose={() => {}}
        skill={{ name: 'goal-setter', displayName: 'goal-setter' }}
      />
    )

    expect(screen.getByText('正在读取调用记录...')).toBeTruthy()
    expect(await screen.findByText('1 条调用记录')).toBeTruthy()
    expect(screen.getByText('codex')).toBeTruthy()
    expect(screen.getByText('/goal')).toBeTruthy()
    expect(screen.getByText('80000000…0001')).toBeTruthy()
    expect(screen.getByText('日志可用')).toBeTruthy()
    expect(screen.queryByText(/raw|logical|usable/)).toBeNull()
    expect(screen.queryByText(/sourceLine|lines|classification/)).toBeNull()
    expect(listSkillRunSamples).toHaveBeenCalledWith({ skillName: 'goal-setter', windowDays: 30 })
  })

  it('源文件失效时显示日志已失效，但记录仍保留', async () => {
    mockListSkillRunSamples({
      success: true,
      data: {
        records: [record({
          invocationId: 'missing',
          sourceAvailable: 'missing',
        })],
      },
    })
    render(<SkillRunSamplesModal open onClose={() => {}} skill={{ name: 'goal-setter' }} />)
    expect(await screen.findByText('日志已失效')).toBeTruthy()
    expect(screen.getByText('1 条调用记录')).toBeTruthy()
  })

  it('空态说明 0 次不等于一定没用过', async () => {
    mockListSkillRunSamples({ success: true, data: { records: [] } })
    render(<SkillRunSamplesModal open onClose={() => {}} skill={{ name: 'goal-setter' }} />)
    expect(await screen.findByText(/0 次不等于一定没用过/)).toBeTruthy()
  })

  it('账本迁移失败时显示专用状态，不误报为没有调用', async () => {
    mockListSkillRunSamples({
      success: true,
      data: { records: [], migrationRequired: true },
    })
    render(<SkillRunSamplesModal open onClose={() => {}} skill={{ name: 'goal-setter' }} />)

    expect(await screen.findByText(/调用账本升级失败/)).toBeTruthy()
    expect(screen.queryByText(/0 次不等于一定没用过/)).toBeNull()
  })

  it('读取失败时显示失败态', async () => {
    mockListSkillRunSamples({ success: false })
    render(<SkillRunSamplesModal open onClose={() => {}} skill={{ name: 'goal-setter' }} />)
    expect(await screen.findByText('调用记录读取失败')).toBeTruthy()
  })

  it('长 session ID 在专用容器中截断展示，完整值留在 title', async () => {
    const longId = `session-${'x'.repeat(120)}-tail`
    mockListSkillRunSamples({
      success: true,
      data: {
        records: [record({
          invocationId: 'long',
          session: { id: longId, relativePath: 'long.jsonl' },
        })],
      },
    })
    const { container } = render(
      <SkillRunSamplesModal open onClose={() => {}} skill={{ name: 'goal-setter' }} />
    )

    await waitFor(() => {
      expect(container.querySelector('.skill-run-session')?.getAttribute('title')).toBe(longId)
    })
    expect(container.querySelector('.skill-run-session')).toBeTruthy()
  })
})
