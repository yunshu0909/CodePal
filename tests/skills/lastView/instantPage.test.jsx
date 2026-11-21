/**
 * #101 Skills 重开、闲置、规则升级后不用重新等：页面这一侧
 * - 用户 2026-11-21 定（原话「可以 按你推荐的来」）：
 *   题 1 次数后台重算时先显示上次的旧数字、旁边标「更新中」，算完原地换；资产增删（身份对不上）照旧先藏起来
 *   题 2 重开后先显示上次关应用前的列表和次数，几秒内换成最新的
 * 每个测试一个新的 window.electronAPI 对象 = 一次新的运行（重开应用）。
 * @module tests/skills/lastView/instantPage.test
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import SkillsPage from '../../../src/pages/skills/SkillsPage'
import SkillDetail from '../../../src/pages/skills/SkillDetail'
import useSkillUsage, { resetSkillUsageCache, usageCacheKey } from '../../../src/hooks/useSkillUsage'
import { usageIdentityOf } from '../../../src/pages/skills/skillsModel'
import { skillRepoPath } from '../../../src/store/skillRepoPath'

vi.mock('../../../src/store/skillRepoPath', () => ({ skillRepoPath: { getRepoPath: vi.fn(), getCachedRepoPath: vi.fn() } }))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const asset = (name, enabled = true) => ({ name, displayName: name, managed: true, description: name + ' 用途', origins: [], locations: [{ toolId: 'central', path: '/library/' + name }],
  tools: { codex: { enabled, state: enabled ? 'synced' : 'disabled', mutable: true }, 'claude-code': { enabled: false, state: 'disabled', mutable: true } } })
const snapOf = (skills, generatedAt = '2026-11-20T09:30:00Z') => ({ generatedAt, skills, errors: [], tools: {
  codex: { available: true, load: { total: 1, personal: 1, tokens: 10 } },
  'claude-code': { available: true, load: { total: 0, personal: 0, tokens: 0 } },
} })
const count = (name, total, batchId = '11111111-2222-3333-4444-555555555555') => ({ name, assetId: 'asset-' + name, total, confirmedTotal: total, claude: total, codex: 0, completeness: 'complete', availability: 'available', batchId })
const keyOf = (snapshot) => usageCacheKey(snapshot.skills.map((skill) => skill.name).sort(), 30, usageIdentityOf(snapshot.skills))
const lastView = (snapshot, usage, repoPath = '/library') => ({ success: true, data: {
  snapshot: snapshot ? { repoPath, savedAt: '2026-11-20T09:30:01Z', data: snapshot } : null,
  usage: usage ? { cacheKey: usage.cacheKey ?? keyOf(snapshot), windowDays: 30, savedAt: '2026-11-20T09:30:02Z', data: { skills: usage.skills } } : null,
} })

let api
let repo
let cachedRepo
beforeEach(() => {
  repo = '/library'
  cachedRepo = '/library'
  skillRepoPath.getRepoPath.mockImplementation(async () => repo)
  skillRepoPath.getCachedRepoPath.mockImplementation(() => cachedRepo)
  resetSkillUsageCache()
  api = {
    getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: snapOf([asset('alpha'), asset('beta')]) })),
    getSkillsLastView: vi.fn(async () => ({ success: true, data: { snapshot: null, usage: null } })),
    executeSkillCommand: vi.fn(async () => ({ success: true, snapshot: snapOf([asset('alpha', false), asset('beta')]) })),
    skillUsageAggregate: vi.fn(async () => ({ success: true, data: { batchId: '11111111-2222-3333-4444-555555555555', skills: [count('alpha', 5), count('beta', 0)] } })),
    skillUsageRecords: vi.fn(async (options) => ({ success: true, data: { batchId: options.batchId, records: [] } })),
  }
  window.electronAPI = api
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const listCount = (container, name) => container.querySelector(`[data-id="${name}"] .end .n`)?.textContent ?? null

describe('#101 重开应用后先显示上次的列表和次数', () => {
  it('TC-101-11 实时快照和次数都还没回来：第一时间出上次的列表和次数，标「更新中」；读完原地换成最新的', async () => {
    const stale = snapOf([asset('alpha'), asset('beta')])
    api.getSkillsLastView.mockResolvedValue(lastView(stale, { skills: [count('alpha', 3), count('beta', 0)] }))
    const liveSnap = deferred()
    const liveUsage = deferred()
    api.getSkillControlSnapshot.mockReturnValueOnce(liveSnap.promise)
    api.skillUsageAggregate.mockReturnValueOnce(liveUsage.promise)
    const view = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    expect(listCount(view.container, 'alpha')).toBe('3')
    expect(view.container.querySelector('.np-pane--list .np-sk'), '列表和页签都不是骨架').toBeNull()
    expect(screen.getByText('更新中', { selector: '.sk-updating' })).toBeInTheDocument()
    // 上次的快照还没核对：先不读次数（免得按名字读到别的资产、存错身份），核对完再读并带上身份键让主进程存一份
    expect(api.skillUsageAggregate).toHaveBeenCalledTimes(0)
    await act(async () => liveSnap.resolve({ success: true, data: snapOf([asset('alpha'), asset('beta')], '2026-11-21T10:00:00Z') }))
    expect(api.skillUsageAggregate).toHaveBeenCalledTimes(1)
    expect(api.skillUsageAggregate.mock.calls[0][0]).toMatchObject({ windowDays: 30, skillNames: ['alpha', 'beta'], cacheKey: keyOf(stale) })
    expect(listCount(view.container, 'alpha')).toBe('3')
    expect(screen.getByText('更新中', { selector: '.sk-updating' })).toBeInTheDocument()
    await act(async () => liveUsage.resolve({ success: true, data: { batchId: '22222222-2222-3333-4444-555555555555', skills: [count('alpha', 4), count('beta', 0)] } }))
    expect(listCount(view.container, 'alpha')).toBe('4')
    expect(screen.queryByText('更新中', { selector: '.sk-updating' })).toBeNull()
    // 身份没变：实时快照回来不再重读次数
    expect(api.skillUsageAggregate).toHaveBeenCalledTimes(1)
  })

  it('TC-101-12 刚开应用还不知道资产库路径时，上次的快照放进它自己那个资产库，路径一确认就显示', async () => {
    cachedRepo = null
    const stale = snapOf([asset('alpha'), asset('beta')])
    api.getSkillsLastView.mockResolvedValue(lastView(stale, { skills: [count('alpha', 3), count('beta', 0)] }))
    api.getSkillControlSnapshot.mockReturnValueOnce(new Promise(() => {}))
    api.skillUsageAggregate.mockReturnValueOnce(new Promise(() => {}))
    const view = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    expect(listCount(view.container, 'alpha')).toBe('3')
  })

  it('TC-101-13 上次的快照属于别的资产库：不用，照旧骨架等实时的', async () => {
    api.getSkillsLastView.mockResolvedValue(lastView(snapOf([asset('other')]), { skills: [count('other', 9)] }, '/old-library'))
    const liveSnap = deferred()
    api.getSkillControlSnapshot.mockReturnValueOnce(liveSnap.promise)
    const view = render(<SkillsPage />)
    await act(async () => {})
    await act(async () => {})
    expect(screen.queryByText('other', { selector: '.np-li b' })).toBeNull()
    expect(view.container.querySelector('.np-pane--list .np-sk')).not.toBeNull()
    await act(async () => liveSnap.resolve({ success: true, data: snapOf([asset('alpha'), asset('beta')]) }))
    expect(await screen.findByText('alpha', { selector: '.np-li b' })).toBeInTheDocument()
  })

  it('TC-101-14 实时快照先回来：上次的那份迟到也不盖掉它', async () => {
    const late = deferred()
    api.getSkillsLastView.mockReturnValueOnce(late.promise)
    const view = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    await act(async () => late.resolve(lastView(snapOf([asset('ghost')]), { skills: [count('ghost', 9)] })))
    expect(screen.queryByText('ghost', { selector: '.np-li b' })).toBeNull()
    expect(view.container.querySelector('[data-id="alpha"]')).not.toBeNull()
  })

  it('TC-101-15 上次的次数和现在的资产对不上号（增删过）：列表先出上次的，次数照旧先藏起来', async () => {
    const stale = snapOf([asset('alpha'), asset('beta')])
    api.getSkillsLastView.mockResolvedValue(lastView(stale, { cacheKey: keyOf(snapOf([asset('alpha')])), skills: [count('alpha', 3)] }))
    api.getSkillControlSnapshot.mockReturnValueOnce(new Promise(() => {}))
    api.skillUsageAggregate.mockReturnValueOnce(new Promise(() => {}))
    const view = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    expect(listCount(view.container, 'alpha')).toBeNull()
    expect(view.container.querySelector('.sk-tabs-sk .np-sk'), '页签那一行是骨架（次数没读到）').not.toBeNull()
    expect(screen.queryByText('更新中', { selector: '.sk-updating' })).toBeNull()
  })

  it('TC-101-16 显示上次的时候去开关：显示操作后的状态，之前发出的实时读取迟到也不盖回去', async () => {
    const stale = snapOf([asset('alpha'), asset('beta')])
    api.getSkillsLastView.mockResolvedValue(lastView(stale, { skills: [count('alpha', 3), count('beta', 0)] }))
    const liveSnap = deferred()
    api.getSkillControlSnapshot.mockReturnValueOnce(liveSnap.promise)
    const view = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    fireEvent.click(screen.getByText('alpha', { selector: '.np-li b' }))
    const codexSwitch = view.container.querySelectorAll('[role="switch"]')[1]
    expect(codexSwitch).toHaveAttribute('aria-checked', 'true')
    await act(async () => { fireEvent.click(codexSwitch) })
    await waitFor(() => expect(api.executeSkillCommand).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(view.container.querySelectorAll('[role="switch"]')[1]).toHaveAttribute('aria-checked', 'false'))
    await act(async () => liveSnap.resolve({ success: true, data: snapOf([asset('alpha', true), asset('beta')]) }))
    expect(view.container.querySelectorAll('[role="switch"]')[1]).toHaveAttribute('aria-checked', 'false')
  })

  it('TC-101-17 没有上次的（第一次装、或缓存被删）：照旧骨架，读完正常显示', async () => {
    const view = render(<SkillsPage />)
    expect(view.container.querySelector('.np-sk')).not.toBeNull()
    await screen.findByText('alpha', { selector: '.np-li b' })
    await waitFor(() => expect(listCount(view.container, 'alpha')).toBe('5'))
    expect(screen.queryByText('更新中', { selector: '.sk-updating' })).toBeNull()
  })
})

describe('#101 闲置和重新读取：旧数字留着，标「更新中」', () => {
  it('TC-101-18 闲置超过 5 分钟再切回：次数不变成骨架，显示旧数字 + 更新中，读完原地换', async () => {
    const first = renderHook(() => useSkillUsage(['alpha'], 30))
    await waitFor(() => expect(first.result.current.usageMap.get('alpha')?.total).toBe(5))
    first.unmount()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000)
    const fresh = deferred()
    api.skillUsageAggregate.mockReturnValueOnce(fresh.promise)
    const back = renderHook(() => useSkillUsage(['alpha'], 30))
    expect(back.result.current.status).toBe('refreshing')
    expect(back.result.current.usageMap.get('alpha')?.total).toBe(5)
    // 旧批次的明细不拿来配新数字：更新中没有批次号，明细等新批次
    expect(back.result.current.batchId).toBeNull()
    await act(async () => fresh.resolve({ success: true, data: { batchId: '33333333-2222-3333-4444-555555555555', skills: [count('alpha', 6)] } }))
    expect(back.result.current.status).toBe('ready')
    expect(back.result.current.usageMap.get('alpha')?.total).toBe(6)
    clock.mockRestore()
  })

  it('TC-101-19 点重新读取：旧数字留着标更新中；迟到的旧响应不盖新结果', async () => {
    const first = deferred()
    const second = deferred()
    const third = deferred()
    api.skillUsageAggregate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
    const hook = renderHook(({ token }) => useSkillUsage(['alpha'], 30, token), { initialProps: { token: 0 } })
    await act(async () => first.resolve({ success: true, data: { batchId: 'a', skills: [count('alpha', 2, 'a')] } }))
    expect(hook.result.current.usageMap.get('alpha')?.total).toBe(2)
    hook.rerender({ token: 1 })
    expect(hook.result.current.status).toBe('refreshing')
    expect(hook.result.current.usageMap.get('alpha')?.total).toBe(2)
    hook.rerender({ token: 2 })
    expect(hook.result.current.status).toBe('refreshing')
    // 两次重新读取都真的发出去了：第 2 次（second）和第 3 次（third）
    expect(api.skillUsageAggregate).toHaveBeenCalledTimes(3)
    await act(async () => third.resolve({ success: true, data: { batchId: 'c', skills: [count('alpha', 8, 'c')] } }))
    expect(hook.result.current.usageMap.get('alpha')?.total).toBe(8)
    // 先发出的 second 后回来：不能盖掉更新的 third
    await act(async () => second.resolve({ success: true, data: { batchId: 'b', skills: [count('alpha', 1, 'b')] } }))
    expect(hook.result.current.usageMap.get('alpha')?.total).toBe(8)
    hook.unmount()
    const again = renderHook(() => useSkillUsage(['alpha'], 30, 2))
    expect(again.result.current.usageMap.get('alpha')?.total).toBe(8)
  })

  it('TC-101-20 更新中读失败：照现在显示读取失败，不继续挂着旧数字', async () => {
    const hook = renderHook(({ token }) => useSkillUsage(['alpha'], 30, token), { initialProps: { token: 0 } })
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    api.skillUsageAggregate.mockResolvedValueOnce({ success: false, error: 'SKILL_USAGE_FAILED' })
    hook.rerender({ token: 1 })
    await waitFor(() => expect(hook.result.current.status).toBe('error'))
    expect(hook.result.current.usageMap.size).toBe(0)
  })

  it('TC-101-21 详情栏头：更新中时显示旧数字和「更新中」，明细等新批次', () => {
    const skill = asset('alpha')
    render(<SkillDetail skill={skill} snapshot={snapOf([skill])} usage={count('alpha', 3)} usageFailed={false} usageStatus="refreshing"
      onRetryUsage={vi.fn()} records={{ status: 'loading', records: [] }} pluginNames={[]} pendingKeys={new Set()} onToggle={vi.fn()} onDelete={vi.fn()} />)
    const meta = document.querySelector('.np-pane-hd .meta')
    expect(meta.textContent).toContain('近 30 天 3 次')
    expect(meta.textContent).toContain('更新中')
    expect(meta.querySelector('.np-sk')).toBeNull()
  })
})

describe('#101 审核后补：删除、迟到的旧次数、切回接着等、选中项换组', () => {
  it('TC-101-22 显示上次的时候点删除：先等实时读取核对，确认框按实际要删的位置写', async () => {
    const stale = snapOf([asset('alpha'), asset('beta')])
    api.getSkillsLastView.mockResolvedValue(lastView(stale, { skills: [count('alpha', 3), count('beta', 0)] }))
    const liveSnap = deferred()
    api.getSkillControlSnapshot.mockReturnValueOnce(liveSnap.promise)
    const view = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    fireEvent.click(screen.getByText('alpha', { selector: '.np-li b' }))
    fireEvent.click(within(view.container.querySelector('.np-pane--detail')).getByRole('button', { name: '删除' }))
    await act(async () => {})
    // 实时读取还没回来：不出确认框
    expect(screen.queryByText('删除 alpha？')).toBeNull()
    const live = asset('alpha')
    live.locations = [...live.locations, { toolId: 'codex', path: '/home/.codex/skills/alpha' }]
    await act(async () => liveSnap.resolve({ success: true, data: snapOf([live, asset('beta')], '2026-11-21T10:00:00Z') }))
    expect(await screen.findByText('删除 alpha？')).toBeInTheDocument()
    expect(screen.getByText(/Codex 里的都会删掉/)).toBeInTheDocument()
  })

  it('TC-101-23 实时列表先到、上次的次数后到：同一身份的旧次数照样先显示，标更新中', async () => {
    const late = deferred()
    api.getSkillsLastView.mockReturnValueOnce(late.promise)
    const liveUsage = deferred()
    api.skillUsageAggregate.mockReturnValueOnce(liveUsage.promise)
    const live = snapOf([asset('alpha'), asset('beta')])
    api.getSkillControlSnapshot.mockResolvedValueOnce({ success: true, data: live })
    const view = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    expect(api.skillUsageAggregate).toHaveBeenCalledTimes(1)
    // 上次的快照文件没了，只剩次数那一份
    await act(async () => late.resolve({ success: true, data: { snapshot: null, usage: { cacheKey: keyOf(live), windowDays: 30, data: { skills: [count('alpha', 3), count('beta', 0)] } } } }))
    expect(listCount(view.container, 'alpha')).toBe('3')
    expect(screen.getByText('更新中', { selector: '.sk-updating' })).toBeInTheDocument()
    expect(api.skillUsageAggregate).toHaveBeenCalledTimes(1)
    await act(async () => liveUsage.resolve({ success: true, data: { batchId: '22222222-2222-3333-4444-555555555555', skills: [count('alpha', 4), count('beta', 0)] } }))
    expect(listCount(view.container, 'alpha')).toBe('4')
    expect(screen.queryByText('更新中', { selector: '.sk-updating' })).toBeNull()
  })

  it('TC-101-24 点重新读取后切走再切回：接着等那次重读，不重复排队，读完换成新的', async () => {
    const view = render(<SkillsPage />)
    await waitFor(() => expect(listCount(view.container, 'alpha')).toBe('5'))
    const reread = deferred()
    api.skillUsageAggregate.mockReturnValueOnce(reread.promise)
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await waitFor(() => expect(api.skillUsageAggregate).toHaveBeenCalledTimes(2))
    view.unmount()
    const again = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    expect(listCount(again.container, 'alpha')).toBe('5')
    expect(screen.getByText('更新中', { selector: '.sk-updating' })).toBeInTheDocument()
    await act(async () => reread.resolve({ success: true, data: { batchId: '44444444-2222-3333-4444-555555555555', skills: [count('alpha', 9), count('beta', 0)] } }))
    expect(listCount(again.container, 'alpha')).toBe('9')
    expect(api.skillUsageAggregate).toHaveBeenCalledTimes(2)
  })

  it('TC-101-25 次数更新完，选中的那条从「在用」换到「没用」：页签跟过去，选中行还看得见', async () => {
    api.getSkillControlSnapshot.mockResolvedValue({ success: true, data: snapOf([asset('alpha'), asset('beta'), asset('gamma')]) })
    api.skillUsageAggregate.mockResolvedValueOnce({ success: true, data: { batchId: 'a', skills: [count('alpha', 5), count('beta', 2), count('gamma', 0)] } })
    const view = render(<SkillsPage />)
    await waitFor(() => expect(listCount(view.container, 'alpha')).toBe('5'))
    fireEvent.click(screen.getByText('alpha', { selector: '.np-li b' }))
    expect(screen.getByRole('tab', { name: /在用/ })).toHaveAttribute('aria-selected', 'true')
    const reread = deferred()
    api.skillUsageAggregate.mockReturnValueOnce(reread.promise)
    // 外部触发的重读（和「重新读取」同一条路）：选中详情时总览的按钮不在页面上
    view.rerender(<SkillsPage refreshSignal={1} />)
    await waitFor(() => expect(api.skillUsageAggregate).toHaveBeenCalledTimes(2))
    await act(async () => reread.resolve({ success: true, data: { batchId: 'b', skills: [count('alpha', 0), count('beta', 2), count('gamma', 0)] } }))
    await waitFor(() => expect(screen.getByRole('tab', { name: /没用/ })).toHaveAttribute('aria-selected', 'true'))
    expect(view.container.querySelector('.np-pane--list [data-id="alpha"]')).not.toBeNull()
  })

  it('TC-101-26 后台又读了一遍、选中项的组没变：不抢走用户自己点的页签', async () => {
    api.getSkillControlSnapshot.mockResolvedValue({ success: true, data: snapOf([asset('alpha'), asset('beta'), asset('gamma')]) })
    api.skillUsageAggregate.mockResolvedValue({ success: true, data: { batchId: 'a', skills: [count('alpha', 5), count('beta', 2), count('gamma', 0)] } })
    const view = render(<SkillsPage />)
    await waitFor(() => expect(listCount(view.container, 'alpha')).toBe('5'))
    fireEvent.click(screen.getByText('alpha', { selector: '.np-li b' }))
    fireEvent.click(screen.getByRole('tab', { name: /没用/ }))
    expect(screen.getByRole('tab', { name: /没用/ })).toHaveAttribute('aria-selected', 'true')
    view.rerender(<SkillsPage refreshSignal={1} />)
    await waitFor(() => expect(api.skillUsageAggregate).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.getByRole('tab', { name: /没用/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('TC-101-27 身份变了又变回来：接着等原来那次读取，不重复排队', async () => {
    const first = deferred()
    api.skillUsageAggregate.mockReturnValueOnce(first.promise).mockReturnValueOnce(new Promise(() => {}))
    const hook = renderHook(({ identity }) => useSkillUsage(['alpha'], 30, 0, identity), { initialProps: { identity: 'A' } })
    hook.rerender({ identity: 'B' })
    hook.rerender({ identity: 'A' })
    expect(api.skillUsageAggregate).toHaveBeenCalledTimes(2)
    await act(async () => first.resolve({ success: true, data: { batchId: 'a', skills: [count('alpha', 7, 'a')] } }))
    expect(hook.result.current.status).toBe('ready')
    expect(hook.result.current.usageMap.get('alpha')?.total).toBe(7)
  })

  it('TC-101-28 上次的快照核对失败：停在上次读到的，不标更新中、不按旧名字去读次数', async () => {
    const stale = snapOf([asset('alpha'), asset('beta')])
    api.getSkillsLastView.mockResolvedValue(lastView(stale, { skills: [count('alpha', 3), count('beta', 0)] }))
    const liveSnap = deferred()
    api.getSkillControlSnapshot.mockReturnValueOnce(liveSnap.promise)
    const view = render(<SkillsPage />)
    await screen.findByText('alpha', { selector: '.np-li b' })
    await act(async () => liveSnap.resolve({ success: false, error: 'SCAN_FAILED' }))
    expect(screen.getByText('读取失败，下面是上次读到的结果')).toBeInTheDocument()
    expect(listCount(view.container, 'alpha')).toBe('3')
    expect(screen.queryByText('更新中', { selector: '.sk-updating' })).toBeNull()
    expect(api.skillUsageAggregate).not.toHaveBeenCalled()
  })
})
