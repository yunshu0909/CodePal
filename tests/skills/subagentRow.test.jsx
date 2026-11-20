/**
 * #81 详情「近 30 天调用」：子代理那一串合成一行「<工具> 派了 N 个子代理」，和普通记录按时间混排；
 * 栏头「近 30 天 N 次」和标题右端「N 次」只数主会话。
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SkillDetail from '../../src/pages/skills/SkillDetail'

vi.mock('../../src/store/skillRepoPath', () => ({ skillRepoPath: { getRepoPath: vi.fn(async () => '/library'), getCachedRepoPath: vi.fn(() => '/library') } }))

const alpha = { name: 'alpha', displayName: 'alpha', managed: true, description: '用途说明', origins: [], locations: [{ toolId: 'central', path: '/library/alpha' }],
  tools: { codex: { enabled: true, state: 'synced', mutable: true }, 'claude-code': { enabled: true, state: 'synced', mutable: true } } }
const snapshot = { skills: [alpha], errors: [], tools: {
  codex: { available: true, load: { total: 1, personal: 1, tokens: 20 } },
  'claude-code': { available: true, load: { total: 1, personal: 1, tokens: 20 } },
} }
const usage = (total) => ({ name: 'alpha', assetId: 'asset-alpha', total, confirmedTotal: total, claude: total, codex: 0,
  completeness: 'complete', uncertaintyScope: 'asset', availability: 'available', batchId: 'batch-a' })
const record = { invocationId: 'load-main', skillName: 'alpha', tool: 'claude', triggeredAt: '2026-10-07T07:58:00Z', session: { relativePath: '-Users-demo-skills/main.jsonl' } }
const run = (overrides = {}) => ({ runId: 'run-1', skillName: 'alpha', assetId: 'asset-alpha', tool: 'claude', agentCount: 11,
  triggeredAt: '2026-10-07T08:00:12Z', lastReadAt: '2026-10-07T08:02:05Z', session: { relativePath: '-Users-demo-skills/main/subagents/agent-x.jsonl' }, ...overrides })
const props = (overrides) => ({ skill: alpha, snapshot, usageFailed: false, usageStatus: 'ready', pluginNames: [], pendingKeys: new Set(),
  onToggle: vi.fn(), onDelete: vi.fn(), onRetryUsage: vi.fn(), ...overrides })

afterEach(() => { cleanup() })

describe('#81 子代理在调用明细里合成一行', () => {
  it('主记录 1 条 + 子代理 1 行：次数只数主会话，子代理那行写「Claude Code 派了 11 个子代理」，按时间新的在上', () => {
    const view = render(<SkillDetail {...props({ usage: usage(1), records: { status: 'ready', records: [record], runs: [run()] } })} />)
    expect(view.container.querySelector('.np-pane-hd .num')?.textContent).toBe('1')
    expect(view.container.querySelector('.np-glabel .cnt')?.textContent).toBe('1 次')
    const rows = [...view.container.querySelectorAll('.np-lrow')]
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Claude Code 派了 11 个子代理')
    expect(rows[0].querySelector('.e')?.textContent).toBe('skills')
    expect(rows[1].textContent).not.toContain('子代理')
  })

  it('Codex 子代理写「Codex 派了 3 个子代理」', () => {
    render(<SkillDetail {...props({ usage: usage(1), records: { status: 'ready', records: [record], runs: [run({ tool: 'codex', agentCount: 3, session: { relativePath: '2026/10/x.jsonl' } })] } })} />)
    expect(screen.queryByText('Codex 派了 3 个子代理')).not.toBeNull()
  })

  it('只有子代理行：栏头「近 30 天没用」，列表照样显示那一行，不写「没有记录到调用」', () => {
    const view = render(<SkillDetail {...props({ usage: usage(0), records: { status: 'ready', records: [], runs: [run()] } })} />)
    expect(screen.queryByText('近 30 天没用')).not.toBeNull()
    expect(view.container.querySelectorAll('.np-lrow')).toHaveLength(1)
    expect(screen.queryByText('Claude Code 派了 11 个子代理')).not.toBeNull()
    expect(screen.queryByText('近 30 天没有记录到调用')).toBeNull()
  })
})
