/**
 * 订阅设置连着改、切回后改、写入被拒、停在页里读到新版本（#100 带进来的订阅问题）
 *
 * 假接口按版本号把关，和主进程一样：提交的 expectedVersion 不是账本当前版本就拒绝（PLAN_CONFLICT）；
 * 只交自动续费的是单独那条路，其余必须订阅费、账单日、自动续费三样齐全。全部是假接口，不读写磁盘。
 *
 * @module tests/plan/planSettingsQueue
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../../src/components/Toast', () => {
  const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }
  return { toast, default: () => null, notifyToast: vi.fn(), resetToastForTests: vi.fn() }
})

const { notifyToast } = await import('../../src/components/Toast')
const { default: PlanManagementPage } = await import('../../src/pages/PlanManagementPage')

const FAILED = { message: 'Claude Code 订阅更新失败', type: 'error' }
const CYCLE = { id: '2026-08-20', start: '2026-08-20', end: '2026-09-20', price: 20 }
const PLAN = { price: 20, billingDay: 20, autoRenew: false, version: 1, stopped: false, cycles: [CYCLE] }

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

/** 假账本：按版本号把关；gates 里排着的 deferred 依次挡住写入（模拟那一笔还在保存） */
function ledgerApi({ plan = PLAN, today = '2026-09-16' } = {}) {
  const a = {
    state: { claude: structuredClone(plan), codex: { cycles: [], version: 0, stopped: false } },
    gates: [],
    today,
  }
  const snap = (id) => ({ plan: structuredClone(a.state[id]), metadata: { type: 'Pro' }, today: a.today })
  const write = async (p, change) => {
    if (a.gates.length) await a.gates.shift().promise
    const s = a.state[p.planId]
    if (p.expectedVersion !== s.version) return { success: false, error: 'PLAN_CONFLICT' }
    if (change(s) === false) return { success: false, error: 'INVALID_SETTINGS' }
    s.version += 1
    return { success: true, data: { ...snap(p.planId), changed: true, duplicate: false } }
  }
  Object.assign(a, {
    readPlan: vi.fn(async ({ planId }) => ({ success: true, data: snap(planId) })),
    queryPlan: vi.fn(async ({ planId, cycleId }) => ({ success: true, data: { version: a.state[planId].version, cycleId, total: 751, models: [] } })),
    savePlan: vi.fn((p) => write(p, (s) => {
      const { planId, operationId, expectedVersion, ...fields } = p
      const renewalOnly = Object.keys(fields).length === 1 && typeof fields.autoRenew === 'boolean'
      if (!renewalOnly && !(typeof fields.price === 'number' && Number.isInteger(fields.billingDay) && typeof fields.autoRenew === 'boolean')) return false
      Object.assign(s, fields)
      if (!renewalOnly) s.cycles = s.cycles.map((c, i) => (i === s.cycles.length - 1 ? { ...c, price: fields.price } : c))
    })),
    actPlan: vi.fn((p) => write(p, (s) => {
      if (p.action !== 'renew') return
      const last = s.cycles.at(-1)
      s.cycles = [...s.cycles, { id: '2026-09-20', start: '2026-09-20', end: '2026-10-20', price: last.price }]
    })),
    onUsageStatisticsChanged: vi.fn((cb) => { a.emitStats = cb; return () => {} }),
  })
  window.electronAPI = a
  return a
}

const claudeCard = () => screen.getAllByTestId('plan-card')[0]
const multiplier = () => claudeCard().querySelector('.plan-x').textContent
const openSettings = () => fireEvent.click(screen.getByRole('button', { name: 'Claude Code 订阅设置' }))
const typePrice = (value) => {
  fireEvent.change(screen.getByLabelText('订阅费'), { target: { value } })
  fireEvent.keyDown(screen.getByLabelText('订阅费'), { key: 'Enter' })
}

/** 进页并等数字出来 */
async function visit() {
  const view = render(<PlanManagementPage />)
  await waitFor(() => expect(document.querySelector('.plan-sk')).toBeNull())
  await waitFor(() => expect(multiplier()).not.toBe('—'))
  await act(async () => {})
  return view
}

/** 盯住每一次 DOM 变化，记下有没有出过灰块 */
function watchSkeleton() {
  const seen = []
  const observer = new MutationObserver(() => { if (document.querySelector('.plan-sk')) seen.push(multiplier()) })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  return { seen, stop: () => observer.disconnect() }
}

afterEach(() => {
  cleanup()
  delete window.electronAPI
  vi.clearAllMocks()
})

describe('订阅设置连着改两样', () => {
  it('勾自动续费那一笔还在存，就改订阅费回车：两样都存上，第二笔用第一笔存完的版本，不弹失败', async () => {
    const a = ledgerApi()
    await visit()
    openSettings()
    const saving = deferred()
    a.gates.push(saving)
    fireEvent.click(screen.getByLabelText('到期自动进下一周期'))
    typePrice('100')
    await act(async () => {})
    await act(async () => saving.resolve())
    await waitFor(() => expect(a.savePlan).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(a.state.claude.price).toBe(100))
    expect(a.state.claude.autoRenew).toBe(true)
    expect(a.savePlan.mock.calls[1][0].expectedVersion).toBe(2)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('到期的卡：勾自动续费还在存就点「续了一期」，两笔都成，不弹失败', async () => {
    const a = ledgerApi({ today: '2026-09-21' })
    await visit()
    openSettings()
    const saving = deferred()
    a.gates.push(saving)
    fireEvent.click(screen.getByLabelText('到期自动进下一周期'))
    fireEvent.click(within(claudeCard()).getByRole('button', { name: '续了一期' }))
    await act(async () => {})
    await act(async () => saving.resolve())
    await waitFor(() => expect(a.actPlan).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(a.state.claude.cycles).toHaveLength(2))
    expect(a.state.claude.autoRenew).toBe(true)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('账本在别处改过（不是本页存的）：点「续了一期」仍按看着的那一版提交、被拒', async () => {
    const a = ledgerApi({ today: '2026-09-21' })
    await visit()
    a.state.claude.version = 2
    fireEvent.click(within(claudeCard()).getByRole('button', { name: '续了一期' }))
    await waitFor(() => expect(notifyToast).toHaveBeenCalledWith(FAILED))
    expect(a.actPlan.mock.calls[0][0].expectedVersion).toBe(1)
    expect(a.state.claude.cycles).toHaveLength(1)
  })
})

describe('第一次设置', () => {
  it('没设过订阅，照提示值回车：订阅费、账单日、自动续费三样齐全交上去，存上', async () => {
    const a = ledgerApi({ plan: { cycles: [], version: 0, stopped: false } })
    a.readPlan = vi.fn(async ({ planId }) => ({ success: true, data: { plan: structuredClone(a.state[planId]), metadata: { type: 'Pro', suggestedPrice: 20, suggestedBillingDay: 20 }, today: a.today } }))
    render(<PlanManagementPage />)
    await waitFor(() => expect(a.readPlan).toHaveBeenCalledTimes(2))
    await act(async () => {})
    openSettings()
    fireEvent.keyDown(screen.getByLabelText('订阅费'), { key: 'Enter' })
    await waitFor(() => expect(a.state.claude.price).toBe(20))
    expect(a.savePlan.mock.calls[0][0]).toMatchObject({ expectedVersion: 0, price: 20, billingDay: 20, autoRenew: false })
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })
})

describe('切回后改订阅设置', () => {
  it('切回马上打开设置、后台读到别处改过账单日：弹层里账单日换成新的，只改订阅费存进去的账单日是新的', async () => {
    const a = ledgerApi()
    ;(await visit()).unmount()
    a.state.claude = { ...a.state.claude, billingDay: 5, version: 2 }
    const later = deferred()
    a.queryPlan = vi.fn(({ planId, cycleId }) => later.promise.then(() => ({ success: true, data: { version: a.state[planId].version, cycleId, total: 1000, models: [] } })))
    render(<PlanManagementPage />)
    openSettings()
    expect(screen.getByLabelText('账单日')).toHaveValue('20')
    await act(async () => {})
    await act(async () => later.resolve())
    await waitFor(() => expect(multiplier()).toBe('50×'))
    expect(screen.getByLabelText('账单日')).toHaveValue('5')
    typePrice('100')
    await waitFor(() => expect(a.state.claude.price).toBe(100))
    expect(a.state.claude.billingDay).toBe(5)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('垫着上次的卡（新数字还没出来）就改订阅费：只改订阅费，账单日照账本最新的，不弹失败', async () => {
    const a = ledgerApi()
    ;(await visit()).unmount()
    a.state.claude = { ...a.state.claude, billingDay: 5, version: 2 }
    a.queryPlan = vi.fn(() => new Promise(() => {}))
    render(<PlanManagementPage />)
    await act(async () => {})
    openSettings()
    typePrice('100')
    await waitFor(() => expect(a.state.claude.price).toBe(100))
    expect(a.state.claude.billingDay).toBe(5)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('写入被拒：卡片不停在「—」，马上重读，出新数字', async () => {
    const a = ledgerApi()
    ;(await visit()).unmount()
    a.state.claude = { ...a.state.claude, billingDay: 5, version: 2 }
    let n = 0
    a.queryPlan = vi.fn(({ planId, cycleId }) => (++n === 1 ? new Promise(() => {}) : Promise.resolve({ success: true, data: { version: a.state[planId].version, cycleId, total: 1000, models: [] } })))
    a.savePlan = vi.fn(async () => ({ success: false, error: 'PLAN_CONFLICT' }))
    render(<PlanManagementPage />)
    await act(async () => {})
    expect(multiplier()).toBe('38×')
    openSettings()
    typePrice('100')
    await waitFor(() => expect(notifyToast).toHaveBeenCalledWith(FAILED))
    await waitFor(() => expect(multiplier()).toBe('50×'))
  })
})

describe('停在页里读到新账本版本', () => {
  it('统计变了、后台读到新版本：新数字出来之前还是刚才的数字，不出灰块；出来了原地换', async () => {
    const a = ledgerApi()
    await visit()
    expect(multiplier()).toBe('38×')
    a.state.claude = { ...a.state.claude, price: 40, version: 2, cycles: [{ ...CYCLE, price: 40 }] }
    const later = deferred()
    a.queryPlan = vi.fn(({ planId, cycleId }) => later.promise.then(() => ({ success: true, data: { version: a.state[planId].version, cycleId, total: 1000, models: [] } })))
    const watch = watchSkeleton()
    await act(async () => a.emitStats())
    expect(multiplier()).toBe('38×')
    await act(async () => later.resolve())
    expect(multiplier()).toBe('25×')
    watch.stop()
    expect(watch.seen).toEqual([])
  })

  it('读到新版本后统计中、接着账本又读失败：还是刚才的数字，不变成「—」', async () => {
    const a = ledgerApi()
    await visit()
    a.state.claude = { ...a.state.claude, version: 2 }
    a.queryPlan = vi.fn(async ({ planId, cycleId }) => ({ success: true, data: { version: a.state[planId].version, cycleId, pending: true } }))
    const watch = watchSkeleton()
    await act(async () => a.emitStats())
    a.readPlan = vi.fn(async () => ({ success: false }))
    await act(async () => a.emitStats())
    expect(multiplier()).toBe('38×')
    watch.stop()
    expect(watch.seen).toEqual([])
  })
})
