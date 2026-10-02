/**
 * Skills 页缓存与回访测试
 * - 真正卸载并重新挂载，控制后台读取、操作和次数返回的顺序
 * @module tests/skills/SkillsCachePage
 */
import React from 'react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import SkillsPage from '../../src/pages/skills/SkillsPage'
import useSkillControl from '../../src/hooks/useSkillControl'
import useSkillUsage, { resetSkillUsageCache } from '../../src/hooks/useSkillUsage'
import { skillRepoPath } from '../../src/store/skillRepoPath'

vi.mock('../../src/store/skillRepoPath', () => ({ skillRepoPath: { getRepoPath: vi.fn(), getCachedRepoPath: vi.fn() } }))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const makeSnapshot = (enabled = true, name = 'sample') => ({
  generatedAt: enabled ? '2026-09-30T02:00:00Z' : '2026-09-30T02:01:00Z',
  skills: [{ name, displayName: name, description: 'sample description', managed: true, origins: [], locations: [],
    tools: { codex: { enabled, state: enabled ? 'synced' : 'disabled', mutable: true }, 'claude-code': { enabled: false, state: 'disabled', mutable: true } } }],
  errors: [], tools: { codex: { available: true, load: { personal: enabled ? 1 : 0, system: 0, total: enabled ? 1 : 0, tokens: 10 } }, 'claude-code': { available: true, load: { personal: 0, synced: 0, total: 0, tokens: 0 } } },
})
const live = (snap = makeSnapshot()) => ({ success: true, data: snap })
let api
let repo
beforeEach(() => {
  repo = '/library'
  skillRepoPath.getRepoPath.mockImplementation(async () => repo)
  skillRepoPath.getCachedRepoPath.mockImplementation(() => repo)
  resetSkillUsageCache()
  api = {
    getSkillControlSnapshot: vi.fn(async () => live()),
    executeSkillCommand: vi.fn(async () => ({ success: true, snapshot: makeSnapshot(false) })),
    aggregateSkillUsage: vi.fn(async () => ({ success: true, data: { skills: [{ name: 'sample', total: 7 }] } })),
    listSkillRunSamples: vi.fn(async () => ({ success: true, data: { records: [] } })),
  }
  window.electronAPI = api
})
afterEach(cleanup)
const ready = async () => {
  const view = render(<SkillsPage />)
  await screen.findByText('sample', { selector: '.np-li b' })
  await act(async () => {})
  return view
}
const revisit = async () => {
  const view = await ready()
  view.unmount()
  const next = deferred()
  api.getSkillControlSnapshot.mockImplementationOnce(() => next.promise)
  const again = render(<SkillsPage />)
  return { next, again }
}

describe('Skills page cache contract', () => {
  it('TC-021 selected invocation records are read from the existing live API', async () => {
    await ready()
    fireEvent.click(screen.getByText('sample', { selector: '.np-li b' }))
    await waitFor(() => expect(api.listSkillRunSamples).toHaveBeenCalledWith({ skillName: 'sample', windowDays: 30 }))
    expect(api.listSkillRunSamples).toHaveBeenCalledTimes(1)
  })

  it('TC-001 first load uses existing skeleton, failed first read offers retry', async () => {
    const pending = deferred()
    api.getSkillControlSnapshot.mockReturnValue(pending.promise)
    const view = render(<SkillsPage />)
    expect(view.container.querySelector('.np-sk')).not.toBeNull()
    await act(async () => pending.resolve({ success: false, error: 'SCAN_FAILED' }))
    expect(await screen.findByText('Skill 状态读取失败')).toBeInTheDocument()
  })
  it('TC-002 CACHED_REVISIT remount displays last snapshot before background response', async () => {
    const { next, again } = await revisit()
    expect(screen.getByText('sample', { selector: '.np-li b' }), 'CACHED_REVISIT').toBeInTheDocument()
    expect(again.container.querySelector('.np-sk'), 'CACHED_REVISIT').toBeNull()
    await act(async () => next.resolve(live()))
  })
  it('TC-003 BACKGROUND_UPDATE background success publishes one new snapshot and read time', async () => {
    const { next } = await revisit()
    expect(screen.getByText('sample', { selector: '.np-li b' }), 'BACKGROUND_UPDATE').toBeInTheDocument()
    await act(async () => next.resolve(live(makeSnapshot(false, 'updated'))))
    expect(await screen.findByText('updated', { selector: '.np-li b' })).toBeInTheDocument()
    expect(screen.queryByText('sample', { selector: '.np-li b' })).toBeNull()
  })
  it('TC-004 BACKGROUND_FAILURE failed background read keeps last content and time with visible feedback', async () => {
    const { next } = await revisit()
    await act(async () => next.resolve({ success: false, error: 'SCAN_FAILED' }))
    expect(screen.getByText('sample', { selector: '.np-li b' }), 'BACKGROUND_FAILURE').toBeInTheDocument()
    expect(screen.getByText('读取失败，下面是上次读到的结果'), 'BACKGROUND_FAILURE').toBeInTheDocument()
  })
  it('TC-005 DETAIL_FAILURE read failure is visible while viewing a detail', async () => {
    const view = await ready()
    fireEvent.click(screen.getByText('sample', { selector: '.np-li b' }))
    view.unmount()
    api.getSkillControlSnapshot.mockResolvedValueOnce({ success: false, error: 'SCAN_FAILED' })
    render(<SkillsPage />)
    await waitFor(() => expect(screen.getByText('读取失败，下面是上次读到的结果'), 'DETAIL_FAILURE').toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'sample' }), 'DETAIL_FAILURE').toBeInTheDocument()
  })
  it('TC-006 CACHED_USAGE_FIRST_FRAME usage counts are available in the remount layout, not an empty map', async () => {
    const first = renderHook(() => useSkillUsage(['sample'], 30))
    await waitFor(() => expect(first.result.current.usageMap.get('sample')?.total).toBe(7))
    first.unmount()
    let inLayout
    function Probe() {
      const result = useSkillUsage(['sample'], 30)
      React.useLayoutEffect(() => { inLayout = result.usageMap.get('sample')?.total }, [])
      return null
    }
    render(<Probe />)
    expect(inLayout, 'CACHED_USAGE_FIRST_FRAME').toBe(7)
    expect(api.aggregateSkillUsage).toHaveBeenCalledTimes(1)
  })
  it('TC-007 BROWSING_CONTEXT query and selection survive navigation until confirmed removal', async () => {
    const view = await ready()
    fireEvent.click(screen.getByText('sample', { selector: '.np-li b' }))
    fireEvent.change(screen.getByPlaceholderText('搜索名称和用途'), { target: { value: 'sample' } })
    view.unmount()
    const pending = deferred()
    api.getSkillControlSnapshot.mockReturnValueOnce(pending.promise)
    render(<SkillsPage />)
    expect(screen.getByPlaceholderText('搜索名称和用途'), 'BROWSING_CONTEXT').toHaveValue('sample')
    expect(screen.getByRole('heading', { name: 'sample' }), 'BROWSING_CONTEXT').toBeInTheDocument()
    await act(async () => pending.resolve(live({ ...makeSnapshot(), skills: [] })))
    expect(screen.getByRole('heading', { name: '装载总览' })).toBeInTheDocument()
  })
  it('TC-008 unreadable tool replaces old usable state and disables its switch', async () => {
    const view = await ready()
    const snap = makeSnapshot()
    snap.errors = [{ toolId: 'codex', origin: 'config', code: 'READ_FAILED' }]
    snap.skills[0].tools.codex = { enabled: null, state: 'unavailable', mutable: false }
    snap.tools.codex.load = null
    api.getSkillControlSnapshot.mockResolvedValueOnce(live(snap))
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await screen.findByText('Codex 状态无法读取，其他数据仍可使用')
    fireEvent.click(screen.getByText('sample', { selector: '.np-li b' }))
    const switches = view.container.querySelectorAll('[role="switch"]')
    expect(switches[1]).toHaveAttribute('aria-disabled', 'true')
  })
  it('TC-010 UNMOUNTED_COMPLETION a request finishing without a mounted page seeds the next view', async () => {
    const pending = deferred()
    api.getSkillControlSnapshot.mockReturnValueOnce(pending.promise)
    const first = render(<SkillsPage />)
    await waitFor(() => expect(api.getSkillControlSnapshot).toHaveBeenCalledTimes(1))
    first.unmount()
    await act(async () => pending.resolve(live()))
    api.getSkillControlSnapshot.mockReturnValueOnce(new Promise(() => {}))
    const next = render(<SkillsPage />)
    expect(screen.getByText('sample', { selector: '.np-li b' }), 'UNMOUNTED_COMPLETION').toBeInTheDocument()
    expect(next.container.querySelector('.np-sk'), 'UNMOUNTED_COMPLETION').toBeNull()
  })
  it('TC-011 REFRESH_COORDINATION manual refresh joins a background read and retains data', async () => {
    const { next } = await revisit()
    const button = screen.getByRole('button', { name: '读取中…' })
    expect(button, 'REFRESH_COORDINATION').toBeDisabled()
    expect(screen.getByText('sample', { selector: '.np-li b' }), 'REFRESH_COORDINATION').toBeInTheDocument()
    expect(api.getSkillControlSnapshot).toHaveBeenCalledTimes(2)
    await act(async () => next.resolve(live()))
    expect(screen.getByRole('button', { name: '重新读取' })).toBeEnabled()
  })
  it('TC-014 PENDING_ACROSS_NAVIGATION a pending switch remains disabled across remount', async () => {
    const first = renderHook(() => useSkillControl())
    await waitFor(() => expect(first.result.current.snapshot).not.toBeNull())
    const pending = deferred()
    api.executeSkillCommand.mockReturnValueOnce(pending.promise)
    let command
    act(() => { command = first.result.current.setActivation({ skillName: 'sample', toolId: 'codex', enabled: false }) })
    await waitFor(() => expect(api.executeSkillCommand).toHaveBeenCalledTimes(1))
    first.unmount()
    const second = renderHook(() => useSkillControl())
    expect(second.result.current.pendingKeys.has('sample:codex'), 'PENDING_ACROSS_NAVIGATION').toBe(true)
    await act(async () => { pending.resolve({ success: true, snapshot: makeSnapshot(false) }); await command })
    expect(second.result.current.snapshot.skills[0].tools.codex.enabled).toBe(false)
  })
  it('TC-017 operation failure retains live STATE_UNKNOWN snapshot and actual error', async () => {
    const hook = renderHook(() => useSkillControl())
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull())
    api.executeSkillCommand.mockResolvedValueOnce({ success: false, error: 'STATE_UNKNOWN', snapshot: makeSnapshot(false) })
    let outcome
    await act(async () => { outcome = await hook.result.current.setActivation({ skillName: 'sample', toolId: 'codex', enabled: false }) })
    expect(outcome.error).toBe('STATE_UNKNOWN')
    expect(hook.result.current.snapshot.skills[0].tools.codex.enabled).toBe(false)
    expect(api.executeSkillCommand).toHaveBeenCalledTimes(1)
  })
  it('TC-018 COMMAND_CACHE_UPDATE verified deletion survives leaving and returning', async () => {
    const first = renderHook(() => useSkillControl())
    await waitFor(() => expect(first.result.current.snapshot).not.toBeNull())
    api.executeSkillCommand.mockResolvedValueOnce({ success: true, snapshot: { ...makeSnapshot(), skills: [] } })
    await act(async () => { await first.result.current.execute({ skillName: 'sample', toolId: 'all', action: 'delete' }) })
    first.unmount()
    api.getSkillControlSnapshot.mockReturnValueOnce(new Promise(() => {}))
    const second = renderHook(() => useSkillControl())
    expect(second.result.current.snapshot?.skills, 'COMMAND_CACHE_UPDATE').toEqual([])
  })
  it('TC-019 USAGE_CACHE_SCOPE different usage windows cannot share cached counts; expiry and force reread', async () => {
    const first = renderHook(() => useSkillUsage(['sample'], 30))
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    first.unmount()
    const otherWindow = renderHook(() => useSkillUsage(['sample'], 7))
    await waitFor(() => expect(otherWindow.result.current.status).toBe('ready'))
    expect(api.aggregateSkillUsage, 'USAGE_CACHE_SCOPE').toHaveBeenCalledTimes(2)
    otherWindow.unmount()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000)
    const expired = renderHook(() => useSkillUsage(['sample'], 7))
    await waitFor(() => expect(api.aggregateSkillUsage).toHaveBeenCalledTimes(3))
    expired.unmount()
    clock.mockRestore()
    const forced = renderHook(({ token }) => useSkillUsage(['sample'], 7, token), { initialProps: { token: 0 } })
    forced.rerender({ token: 1 })
    await waitFor(() => expect(api.aggregateSkillUsage).toHaveBeenCalledTimes(4))
  })
  it('TC-020 EXISTING_SIGNAL shared state keeps fresh data on remount without forced usage reread', async () => {
    const view = await ready()
    api.getSkillControlSnapshot.mockResolvedValueOnce(live(makeSnapshot(false)))
    view.rerender(<SkillsPage refreshSignal={1} />)
    await waitFor(() => expect(api.getSkillControlSnapshot).toHaveBeenCalledTimes(2))
    await act(async () => {})
    view.unmount()
    api.getSkillControlSnapshot.mockReturnValueOnce(new Promise(() => {}))
    const hook = renderHook(() => useSkillControl(1))
    expect(hook.result.current.snapshot?.skills[0].tools.codex.enabled, 'EXISTING_SIGNAL').toBe(false)
    expect(api.aggregateSkillUsage).toHaveBeenCalledTimes(1)
  })
})
