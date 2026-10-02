/**
 * Skill 快照缓存的并发契约测试
 * - 使用受控 Promise 核对读写乱序、上下文隔离与有效空结果
 * @module tests/skills/SkillControlCache
 */
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import useSkillControl from '../../src/hooks/useSkillControl'
import { skillRepoPath } from '../../src/store/skillRepoPath'
vi.mock('../../src/store/skillRepoPath', () => ({ skillRepoPath: { getRepoPath: vi.fn(), getCachedRepoPath: vi.fn() } }))

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const live = (name) => ({ success: true, data: { skills: [{ name }], generatedAt: name } })
const create = async () => {
  const modulePath = '../../src/store/services/' + 'skillControlCache.js'
  return (await import(/* @vite-ignore */ modulePath)).createSkillControlCache()
}

describe('Skill snapshot cache contract', () => {
  it('TC-009 COALESCED_READ overlapping reads share one live request', async () => {
    const cache = await create()
    const entry = cache.entry('/library')
    const pending = deferred()
    const load = vi.fn(() => pending.promise)
    const first = cache.refresh(entry, load)
    const second = cache.refresh(entry, load)
    expect(load).toHaveBeenCalledTimes(1)
    pending.resolve(live('one'))
    await Promise.all([first, second])
    expect(entry.state.snapshot.skills[0].name).toBe('one')
  })
  it('TC-012 WRITE_SUPERSEDES_READ old reads cannot overwrite a verified command snapshot', async () => {
    const cache = await create()
    const entry = cache.entry('/library')
    const pending = deferred()
    const read = cache.refresh(entry, () => pending.promise)
    await cache.execute(entry, 'skill:codex', async () => ({ success: true, snapshot: { skills: [{ name: 'disabled' }] } }))
    pending.resolve(live('enabled'))
    await read
    expect(entry.state.snapshot.skills[0].name).toBe('disabled')
  })
  it('TC-013 WRITE_BOUNDARY reads finishing during a write cannot act as post-write verification', async () => {
    const cache = await create()
    const entry = cache.entry('/library')
    const pendingRead = deferred()
    const pendingWrite = deferred()
    const oldRead = cache.refresh(entry, () => pendingRead.promise)
    const write = cache.execute(entry, 'skill:codex', () => pendingWrite.promise)
    pendingRead.resolve(live('before'))
    await oldRead
    expect(entry.state.pendingKeys.has('skill:codex')).toBe(true)
    expect(entry.state.snapshot).toBeNull()
    const loader = vi.fn(async () => live('after'))
    const refresh = cache.refresh(entry, loader)
    expect(loader).not.toHaveBeenCalled()
    pendingWrite.resolve({ success: true })
    await Promise.all([write, refresh])
    expect(entry.state.snapshot.skills[0].name).toBe('after')
  })
  it('TC-015 CONTEXT_ISOLATION separate asset libraries never share a snapshot', async () => {
    const cache = await create()
    const old = cache.entry('/library-old')
    const pending = deferred()
    const read = cache.refresh(old, () => pending.promise)
    const fresh = cache.entry('/library-new')
    expect(fresh.state.snapshot).toBeNull()
    pending.resolve(live('old'))
    await read
    expect(fresh.state.snapshot).toBeNull()
    expect(old.state.snapshot.skills[0].name).toBe('old')
    let repo = '/library-old'
    skillRepoPath.getRepoPath.mockImplementation(async () => repo)
    skillRepoPath.getCachedRepoPath.mockImplementation(() => repo)
    const next = deferred()
    window.electronAPI = { getSkillControlSnapshot: vi.fn().mockResolvedValueOnce(live('old')).mockReturnValueOnce(next.promise) }
    const first = renderHook(() => useSkillControl())
    await waitFor(() => expect(first.result.current.snapshot).not.toBeNull())
    first.unmount()
    repo = '/library-new'
    const second = renderHook(() => useSkillControl())
    expect(second.result.current.snapshot).toBeNull()
    await act(async () => next.resolve(live('new')))
    expect(second.result.current.snapshot.skills[0].name).toBe('new')
    second.unmount()
  })
  it('TC-016 EMPTY_SNAPSHOT a valid empty response is retained; a failed response cannot replace it', async () => {
    const cache = await create()
    const entry = cache.entry('/library')
    await cache.refresh(entry, async () => ({ success: true, data: { skills: [], generatedAt: 'success' } }))
    await cache.refresh(entry, async () => ({ success: false, error: 'SCAN_FAILED' }))
    expect(entry.state.snapshot).toEqual({ skills: [], generatedAt: 'success' })
    expect(entry.state.refreshState).toBe('error')
  })
})
