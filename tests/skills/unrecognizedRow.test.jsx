/**
 * #97 题 1 选 A（2026-11-21 Fable 5.2 与 Astra 替用户定）：认不出的调用只在「近 30 天调用」里加一行灰字，
 * 不改数字、排序、分组，不出破折号、不出「待核」。
 * - 有确认记录时：灰字「另有 N 次调用没认出来，次数可能偏少」放在记录上面；
 * - 确认数是 0、只有认不出的：栏头写「近 30 天 0 次」，灰字顶替「近 30 天没有记录到调用」，两句不同时出现；
 * - 没有认不出的：和改前一模一样。
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SkillDetail from '../../src/pages/skills/SkillDetail'
import SkillsPage from '../../src/pages/skills/SkillsPage'
import { resetSkillUsageCache } from '../../src/hooks/useSkillUsage'

vi.mock('../../src/store/skillRepoPath', () => ({ skillRepoPath: { getRepoPath: vi.fn(async () => '/library'), getCachedRepoPath: vi.fn(() => '/library') } }))

const alpha = { name: 'alpha', displayName: 'alpha', managed: true, description: '用途说明', origins: [], locations: [{ toolId: 'central', path: '/library/alpha' }],
  tools: { codex: { enabled: true, state: 'synced', mutable: true }, 'claude-code': { enabled: true, state: 'synced', mutable: true } } }
const snapshot = { skills: [alpha], errors: [], tools: {
  codex: { available: true, load: { total: 1, personal: 1, tokens: 20 } },
  'claude-code': { available: true, load: { total: 1, personal: 1, tokens: 20 } },
} }
const usage = (total, unrecognized = 0) => ({ name: 'alpha', assetId: 'asset-alpha', total, confirmedTotal: total, claude: total, codex: 0, unrecognized,
  completeness: 'complete', uncertaintyScope: 'asset', availability: 'available', batchId: 'batch-a' })
const record = { invocationId: 'load-main', skillName: 'alpha', tool: 'claude', triggeredAt: '2026-10-07T07:58:00Z', session: { relativePath: '-Users-demo-skills/main.jsonl' } }
const props = (overrides) => ({ skill: alpha, snapshot, usageFailed: false, usageStatus: 'ready', pluginNames: [], pendingKeys: new Set(),
  onToggle: vi.fn(), onDelete: vi.fn(), onRetryUsage: vi.fn(), ...overrides })

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('#97 认不出的调用：明细里一行灰字', () => {
  it('有 1 条确认记录、另有 2 次认不出：数字照旧 1，记录上面一行「另有 2 次调用没认出来，次数可能偏少」', () => {
    const view = render(<SkillDetail {...props({ usage: usage(1, 2), records: { status: 'ready', records: [record], runs: [], unrecognized: 2 } })} />)
    expect(view.container.querySelector('.np-pane-hd .num')?.textContent).toBe('1')
    expect(view.container.querySelector('.np-glabel .cnt')?.textContent).toBe('1 次')
    const hint = screen.queryByText('另有 2 次调用没认出来，次数可能偏少')
    expect(hint, 'UNRECOGNIZED_HINT_MISSING').not.toBeNull()
    expect(hint.className).toContain('np-empty')
    expect(view.container.querySelectorAll('.np-lrow')).toHaveLength(1)
    expect(view.container.textContent).not.toContain('待核')
    expect(view.container.textContent).not.toContain('—')
  })

  it('确认数 0、只有 3 次认不出：栏头「近 30 天 0 次」，灰字顶替「没有记录到调用」', () => {
    const view = render(<SkillDetail {...props({ usage: usage(0, 3), records: { status: 'ready', records: [], runs: [], unrecognized: 3 } })} />)
    expect(view.container.querySelector('.np-pane-hd .meta')?.textContent, 'UNRECOGNIZED_HEADER').toContain('近 30 天 0 次')
    expect(screen.queryByText('近 30 天没用')).toBeNull()
    expect(screen.queryByText('有 3 次调用没认出来，次数可能偏少'), 'UNRECOGNIZED_HINT_MISSING').not.toBeNull()
    expect(screen.queryByText('近 30 天没有记录到调用')).toBeNull()
  })

  it('没有认不出的：和改前一样（「近 30 天没用」「近 30 天没有记录到调用」），没有灰字', () => {
    const view = render(<SkillDetail {...props({ usage: usage(0), records: { status: 'ready', records: [], runs: [], unrecognized: 0 } })} />)
    expect(screen.queryByText('近 30 天没用')).not.toBeNull()
    expect(screen.queryByText('近 30 天没有记录到调用')).not.toBeNull()
    expect(view.container.textContent).not.toContain('没认出来')
  })

  it('真实 Skills 页把明细接口给的认不出次数带到详情里', async () => {
    resetSkillUsageCache()
    const beta = { ...alpha, name: 'beta', displayName: 'beta', locations: [{ toolId: 'central', path: '/library/beta' }] }
    const pageSnapshot = { ...snapshot, skills: [alpha, beta] }
    window.electronAPI = {
      getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: pageSnapshot })),
      executeSkillCommand: vi.fn(async () => ({ success: true, snapshot: pageSnapshot })),
      skillUsageAggregate: vi.fn(async () => ({ success: true, data: { batchId: 'batch-a', skills: [{ ...usage(0, 2) }, { ...usage(2), name: 'beta', assetId: 'asset-beta' }] } })),
      skillUsageRecords: vi.fn(async (options) => ({ success: true, data: { batchId: options.batchId, records: [], subagentRuns: [], unrecognized: options.assetId === 'asset-alpha' ? 2 : 0 } })),
    }
    render(<SkillsPage />)
    await screen.findByText('beta', { selector: '.np-li b' })
    await waitFor(() => expect(screen.getByRole('tab', { name: /在用/ }).getAttribute('aria-selected')).toBe('true'))
    await act(async () => {})
    // 数字和分组不动：确认数 0 的 alpha 仍在「没用」
    fireEvent.click(screen.getByRole('tab', { name: /没用/ }))
    fireEvent.click(await screen.findByText('alpha', { selector: '.np-li b' }))
    await waitFor(() => expect(screen.queryByText('有 2 次调用没认出来，次数可能偏少')).not.toBeNull())
    expect(screen.queryByText('近 30 天没有记录到调用')).toBeNull()
  })
})
