/**
 * v2.1.21 TC-003：证据不全的 Skill 在列表和详情照常显示近 30 天次数，按 v2.1.3 定稿原文案。
 * 列表「N 次」、0 次不写；详情页头「近 30 天 N 次」或「近 30 天没用」，调用记录标题右端「N 次」。
 * 「统计待核」「次数待核」两条文案不再出现。
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SkillDetail from '../../../src/pages/skills/SkillDetail'
import SkillList from '../../../src/pages/skills/SkillList'

vi.mock('../../../src/store/skillRepoPath', () => ({ skillRepoPath: { getRepoPath: vi.fn(async () => '/library'), getCachedRepoPath: vi.fn(() => '/library') } }))

const asset = (name) => ({ name, displayName: name, managed: true, description: '用途说明', origins: [], locations: [{ toolId: 'central', path: '/library/' + name }],
  tools: { codex: { enabled: true, state: 'synced', mutable: true }, 'claude-code': { enabled: false, state: 'disabled', mutable: true } } })
const alpha = asset('alpha')
const beta = asset('beta')
const snapshot = { skills: [alpha, beta], errors: [], tools: {
  codex: { available: true, load: { total: 2, personal: 2, tokens: 20 } },
  'claude-code': { available: true, load: { total: 0, personal: 0, tokens: 0 } },
} }
// 证据不全（completeness=pending）但 total 是确认次数
const usage = (name, total, scope = 'all') => ({ name, assetId: 'asset-' + name, total, confirmedTotal: total, claude: total, codex: 0,
  completeness: 'pending', uncertaintyScope: scope, availability: 'available', batchId: 'batch-a' })
const record = { invocationId: 'load-alpha', skillName: 'alpha', tool: 'claude', triggeredAt: '2026-10-07T07:00:00Z', session: { relativePath: '-demo/root.jsonl' } }
const detailProps = (overrides) => ({ skill: alpha, snapshot, usageFailed: false, usageStatus: 'ready', records: { status: 'ready', records: [] },
  pluginNames: [], pendingKeys: new Set(), onToggle: vi.fn(), onDelete: vi.fn(), onRetryUsage: vi.fn(), ...overrides })
const listProps = (usageMap) => ({ status: 'ready', snapshot, groups: [{ id: 'used', title: '在用 · 近 30 天', skills: [alpha, beta] }], tabs: [], tab: 'used',
  selectedId: 'alpha', onSelect: vi.fn(), query: '', onQueryChange: vi.fn(), onTabChange: vi.fn(), usageMap, usageStatus: 'ready', usageFailed: false,
  onRetry: vi.fn(), searchRef: { current: null } })

afterEach(() => { cleanup() })

describe('v2.1.21 TC-003 列表和详情直接显示次数', () => {
  it('TC-003 列表：有次数写「N 次」，0 次不写，不出现破折号', () => {
    const view = render(<SkillList {...listProps(new Map([['alpha', usage('alpha', 3)], ['beta', usage('beta', 0, 'asset')]]))} />)
    expect(view.container.querySelector('[data-id="alpha"] .end')?.textContent, 'PENDING_COPY_SHOWN list count').toBe('3 次')
    expect(view.container.querySelector('[data-id="beta"] .end')?.textContent ?? '', 'PENDING_COPY_SHOWN list zero').not.toContain('—')
  })

  it('TC-003 详情：页头「近 30 天 N 次」、记录标题「N 次」、记录照常列出，没有待核文案', () => {
    const view = render(<SkillDetail {...detailProps({ usage: usage('alpha', 1), records: { status: 'ready', records: [record] } })} />)
    expect(view.container.querySelector('.np-pane-hd .num')?.textContent, 'PENDING_COPY_SHOWN header').toBe('1')
    expect(view.container.querySelector('.np-glabel .cnt')?.textContent, 'PENDING_COPY_SHOWN title').toBe('1 次')
    expect(view.container.querySelectorAll('.np-lrow')).toHaveLength(1)
    expect(screen.queryByText('统计待核'), 'PENDING_COPY_SHOWN note').toBeNull()
    expect(screen.queryByText('次数待核'), 'PENDING_COPY_SHOWN note').toBeNull()
  })

  it('TC-003 详情：0 次写「近 30 天没用」和「近 30 天没有记录到调用」', () => {
    render(<SkillDetail {...detailProps({ usage: usage('alpha', 0, 'asset') })} />)
    expect(screen.queryByText('近 30 天没用'), 'PENDING_COPY_SHOWN zero header').not.toBeNull()
    expect(screen.queryByText('近 30 天没有记录到调用'), 'PENDING_COPY_SHOWN zero records').not.toBeNull()
    expect(screen.queryByText('次数待核'), 'PENDING_COPY_SHOWN note').toBeNull()
  })
})
