/** #74 已签收七种窗口状态、读取批次与缓存身份。 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import SkillDetail from '../../src/pages/skills/SkillDetail'
import SkillList from '../../src/pages/skills/SkillList'
import SkillsPage from '../../src/pages/skills/SkillsPage'
import { buildGroups, visibleTabsOf } from '../../src/pages/skills/skillsModel'
import useSkillUsage, { resetSkillUsageCache } from '../../src/hooks/useSkillUsage'

vi.mock('../../src/store/skillRepoPath', () => ({ skillRepoPath: { getRepoPath: vi.fn(async () => '/library'), getCachedRepoPath: vi.fn(() => '/library') } }))
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const asset = (name) => ({ name, displayName: name, managed: true, description: '用途说明', origins: [], locations: [{ toolId: 'central', path: '/library/' + name }],
  tools: { codex: { enabled: true, state: 'synced', mutable: true }, 'claude-code': { enabled: false, state: 'disabled', mutable: true } } })
const alpha = asset('alpha')
const beta = asset('beta')
const snapshot = { skills: [alpha, beta], errors: [], tools: {
  codex: { available: true, load: { total: 2, personal: 2, tokens: 20 } },
  'claude-code': { available: true, load: { total: 0, personal: 0, tokens: 0 } },
} }
const complete = (name, total = 1, batchId = 'batch-a') => ({ name, assetId: 'asset-' + name, total, confirmedTotal: total, claude: total, codex: 0, completeness: 'complete', availability: 'available', batchId })
const pending = (name, scope = 'asset') => ({ ...complete(name, 0), total: null, completeness: 'pending', uncertaintyScope: scope })
const record = (name) => ({ invocationId: 'load-' + name, skillName: name, tool: 'codex', triggeredAt: '2026-10-07T07:00:00Z', session: { relativePath: 'sessions/' + name + '-project/root.jsonl' } })
const reply = (skills, batchId = 'batch-a') => ({ success: true, data: { batchId, skills } })
const detailProps = (overrides = {}) => ({ skill: alpha, snapshot, usage: complete('alpha'), usageFailed: false, usageStatus: 'ready',
  records: { status: 'ready', records: [record('alpha')] }, pluginNames: [], pendingKeys: new Set(), onToggle: vi.fn(), onDelete: vi.fn(), onRetryUsage: vi.fn(), ...overrides })
const listProps = (usageMap, overrides = {}) => ({ status: 'ready', snapshot, groups: [{ id: 'library', title: '资产库', skills: snapshot.skills }], tabs: [], tab: 'library',
  selectedId: 'alpha', onSelect: vi.fn(), query: '', onQueryChange: vi.fn(), onTabChange: vi.fn(), usageMap, usageStatus: 'ready', usageFailed: false, onRetry: vi.fn(), searchRef: { current: null }, ...overrides })
let api
beforeEach(() => {
  resetSkillUsageCache()
  api = { aggregateSkillUsage: vi.fn(async () => reply([complete('alpha'), complete('beta')])),
    getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: snapshot })),
    executeSkillCommand: vi.fn(async () => ({ success: true, snapshot })),
    listSkillRunSamples: vi.fn(async ({ skillName }) => ({ success: true, data: { records: [record(skillName)] } })) }
  window.electronAPI = api
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('#74 visible count and record states', () => {
  it('TC-001 W1 trusted detail shows total and loader using the existing pane', () => {
    const view = render(<SkillDetail {...detailProps()} />)
    expect(view.container.querySelector('.np-pane-hd .num')?.textContent).toBe('1')
    expect(screen.queryByText('Codex', { selector: '.np-lrow span' })).not.toBeNull()
    expect(view.container.querySelector('.np-pane-body .np-card')).not.toBeNull()
  })
  it('TC-002 W2 localized uncertainty shows dash and gray note, credible other asset remains numeric, actions stay available', () => {
    const map = new Map([['alpha', pending('alpha')], ['beta', complete('beta', 7)]])
    const view = render(<><SkillList {...listProps(map)} /><SkillDetail {...detailProps({ usage: pending('alpha'), records: { status: 'ready', records: [] } })} /></>)
    expect(view.container.querySelector('[data-id="alpha"] .end')?.textContent).toContain('—')
    expect(view.container.querySelector('[data-id="beta"] .end')?.textContent).toContain('7')
    const note = screen.queryByText('次数待核')
    expect(note).not.toBeNull()
    expect(note?.classList.contains('np-errline')).toBe(false)
    expect(screen.queryByText('近 30 天没有记录到调用')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除' })?.disabled).toBe(false)
  })
  it('TC-002 pending and localized failure use asset-library grouping; restoring proof restores used/unused, zero tabs stay hidden', () => {
    const map = new Map([['alpha', complete('alpha', 4)], ['beta', pending('beta')]])
    const uncertain = buildGroups(snapshot.skills, { usageMap: map })
    expect(uncertain.map((group) => group.id)).toEqual(['library'])
    expect(visibleTabsOf(uncertain, true)).toEqual([])
    map.set('beta', { ...pending('beta'), availability: 'error' })
    expect(buildGroups(snapshot.skills, { usageMap: map }).map((group) => group.id)).toEqual(['library'])
    map.set('beta', complete('beta', 0))
    const restored = buildGroups(snapshot.skills, { usageMap: map })
    expect(restored.map((group) => group.id)).toEqual(['used', 'unused'])
    expect(visibleTabsOf(restored, false)).toEqual(['used', 'unused'])
    expect(visibleTabsOf(buildGroups([alpha], { usageMap: map }), false)).toEqual([])
  })
  it('TC-003 W3 unknown affected scope uses statistical-pending note and never claims zero', () => {
    const view = render(<SkillDetail {...detailProps({ usage: pending('alpha', 'all'), records: { status: 'ready', records: [] } })} />)
    expect(screen.queryByText('统计待核')).not.toBeNull()
    expect(view.container.querySelector('.np-pane-hd .num')?.textContent).toBe('—')
    expect(screen.queryByText('近 30 天没用')).toBeNull()
  })
  it('TC-004 W4 real failure uses red message and existing retry; affected one does not erase known others', () => {
    const onRetryUsage = vi.fn()
    const bad = { ...pending('alpha'), availability: 'error' }
    const view = render(<><SkillList {...listProps(new Map([['alpha', bad], ['beta', complete('beta', 7)]]))} /><SkillDetail {...detailProps({ usage: bad, onRetryUsage, records: { status: 'error', records: [] } })} /></>)
    expect(view.container.querySelector('.np-errline')?.textContent).toBe('调用数据读取失败')
    expect(view.container.querySelector('[data-id="beta"] .end')?.textContent).toContain('7')
    const retry = screen.queryByRole('button', { name: '重试' })
    expect(retry).not.toBeNull()
    fireEvent.click(retry)
    expect(onRetryUsage).toHaveBeenCalledTimes(1)
  })
  it('TC-005 W5 reloading clears old numbers and old rows before displaying the skeleton', () => {
    const view = render(<SkillDetail {...detailProps({ usageStatus: 'loading', records: { status: 'loading', records: [record('old')] } })} />)
    expect(view.container.querySelector('.np-pane-hd .np-sk')).not.toBeNull()
    expect(view.container.querySelector('.np-lrow')).toBeNull()
    expect(screen.queryByText('读取中…')).not.toBeNull()
    expect(screen.queryByText('近 30 天没用')).toBeNull()
  })
  it('TC-006 W6 complete zero preserves signed original wording', () => {
    const view = render(<SkillDetail {...detailProps({ usage: complete('alpha', 0), records: { status: 'ready', records: [] } })} />)
    expect(screen.queryByText('近 30 天没用')).not.toBeNull()
    expect(screen.queryByText('近 30 天没有记录到调用')).not.toBeNull()
    expect(view.container.querySelector('.np-errline')).toBeNull()
  })
  it('TC-007 W7 approved pending state retains panes, tool controls and description at minimum desktop viewport', () => {
    vi.stubGlobal('innerWidth', 720)
    vi.stubGlobal('innerHeight', 500)
    const view = render(<div className="np-split"><SkillList {...listProps(new Map([['alpha', pending('alpha')]]))} /><SkillDetail {...detailProps({ usage: pending('alpha'), records: { status: 'ready', records: [] } })} /></div>)
    expect(screen.queryByText('次数待核')).not.toBeNull()
    expect(view.container.querySelectorAll('.np-pane')).toHaveLength(2)
    expect(screen.queryByText('说明')).not.toBeNull()
    expect(view.container.querySelectorAll('.sk-tool')).toHaveLength(2)
    vi.unstubAllGlobals()
  })
})

describe('#74 TC-008 refresh and identity boundaries', () => {
  it('CASE-029 manual refresh hides previous count immediately and late response cannot overwrite newer batch', async () => {
    const first = deferred()
    const fresh = deferred()
    api.aggregateSkillUsage.mockReturnValueOnce(first.promise).mockReturnValueOnce(fresh.promise)
    const hook = renderHook(({ token }) => useSkillUsage(['alpha'], 30, token), { initialProps: { token: 0 } })
    hook.rerender({ token: 1 })
    await act(async () => fresh.resolve(reply([complete('alpha', 9, 'new')], 'new')))
    expect(hook.result.current.usageMap.get('alpha')?.total).toBe(9)
    await act(async () => first.resolve(reply([complete('alpha', 3, 'old')], 'old')))
    expect(hook.result.current.usageMap.get('alpha')?.total).toBe(9)
    const reread = deferred()
    api.aggregateSkillUsage.mockReturnValueOnce(reread.promise)
    hook.rerender({ token: 2 })
    expect(hook.result.current.status).toBe('loading')
    expect(hook.result.current.usageMap.size).toBe(0)
    await act(async () => reread.resolve(reply([complete('alpha', 10)])))
  })
  it('CASE-034 name unchanged but verified asset mapping changes invalidate five-minute cache', async () => {
    const hook = renderHook(({ identity }) => useSkillUsage(['alpha'], 30, 0, identity), { initialProps: { identity: 'central-v1' } })
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    const changed = deferred()
    api.aggregateSkillUsage.mockReturnValueOnce(changed.promise)
    hook.rerender({ identity: 'collected-alias-v2' })
    expect(hook.result.current.status).toBe('loading')
    expect(hook.result.current.usageMap.size).toBe(0)
    expect(api.aggregateSkillUsage).toHaveBeenCalledTimes(2)
    await act(async () => changed.resolve(reply([complete('alpha', 2)])))
  })
  it('CASE-032 selecting B clears A records while B loads; ignored late A cannot populate B', async () => {
    const b = deferred()
    api.listSkillRunSamples.mockImplementation(({ skillName }) => skillName === 'beta' ? b.promise : Promise.resolve({ success: true, data: { records: [record('alpha')] } }))
    const view = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    fireEvent.click(screen.getByText('alpha', { selector: '.np-li b' }))
    await waitFor(() => expect(view.container.querySelector('.np-lrow')).not.toBeNull())
    fireEvent.click(screen.getByText('beta', { selector: '.np-li b' }))
    expect(view.container.querySelector('.np-lrow')).toBeNull()
    await act(async () => b.resolve({ success: true, data: { records: [record('beta')] } }))
    expect(screen.queryByRole('heading', { name: 'beta' })).not.toBeNull()
    expect(view.container.querySelectorAll('.np-lrow')).toHaveLength(1)
  })
  it('CASE-029 modern details carry the aggregate batch and asset ID, refresh obtains a fresh batch', async () => {
    api.skillUsageAggregate = vi.fn(async () => reply([complete('alpha', 1), complete('beta', 1)]))
    api.skillUsageRecords = vi.fn(async (options) => ({ success: true, data: { batchId: options.batchId, records: [] } }))
    render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    fireEvent.click(screen.getByText('alpha', { selector: '.np-li b' }))
    await waitFor(() => expect(api.skillUsageRecords).toHaveBeenCalled())
    expect(api.skillUsageRecords).toHaveBeenLastCalledWith({ assetId: 'asset-alpha', batchId: 'batch-a', windowDays: 30 })
  })
})
