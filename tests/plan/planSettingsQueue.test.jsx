/**
 * 订阅设置连着改、切回后改、写入被拒、停在页里读到新版本（#100 带进来的订阅问题）
 *
 * 页面接的是真实的账本服务和 IPC 校验（内存里的假存储，不读写磁盘），按版本号、周期把关和主进程一样；
 * 「保存还没回来」用挡住存储写入来模拟，「别处改过」直接改内存账本、版本号 +1。用量查询是假的。
 * 另有几条直接测订阅设置弹层：交什么在回车那一刻定下。
 *
 * @module tests/plan/planSettingsQueue
 */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRequire } from 'node:module'

vi.mock('../../src/components/Toast', () => {
  const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }
  return { toast, default: () => null, notifyToast: vi.fn(), resetToastForTests: vi.fn() }
})

const require = createRequire(import.meta.url)
const { createPlanStoreService } = require('../../electron/services/plan/planStoreService')
const { registerPlanHandlers } = require('../../electron/ipc/registerPlanHandlers')
const { notifyToast } = await import('../../src/components/Toast')
const { default: PlanManagementPage } = await import('../../src/pages/PlanManagementPage')
const { default: PlanSettingsPopover } = await import('../../src/pages/plan/components/PlanSettingsPopover')

const FAILED = { message: 'Claude Code 订阅更新失败', type: 'error' }
const CYCLE = { id: '2026-08-20', start: '2026-08-20', end: '2026-09-20', price: 20 }
const PLAN = { price: 20, billingDay: 20, autoRenew: false, version: 1, stopped: false, cycles: [CYCLE] }
const UNSET = { cycles: [], version: 0, stopped: false }

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

/** 真实账本服务 + IPC 校验接成 window.electronAPI；gates 里排着的 deferred 依次挡住存储写入（模拟那一笔还在保存） */
function ledgerApi({ plan = PLAN, now = '2026-09-16T04:00:00Z', metadata = { type: 'Pro', suggestedPrice: null, suggestedBillingDay: null } } = {}) {
  const data = { planLedgerV1: { schemaVersion: 1, plans: { claude: structuredClone(plan), codex: structuredClone(UNSET) } } }
  const a = { gates: [], total: 751, metadata }
  const store = {
    get: (k) => structuredClone(data[k]),
    set: async (k, v) => { if (a.gates.length) await a.gates.shift().promise; data[k] = structuredClone(v) },
  }
  const service = createPlanStoreService({ store, nowFn: () => new Date(now), metadataFn: async () => a.metadata })
  const handlers = {}
  registerPlanHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, service })
  const call = (channel) => (payload) => handlers[channel](null, payload)
  Object.assign(a, {
    ledger: () => data.planLedgerV1.plans.claude,
    /** 别处改了账本（另一个窗口 / 自动续费），页面不知道 */
    elsewhere: (fields) => { const p = data.planLedgerV1.plans.claude; Object.assign(p, fields); p.version += 1 },
    readPlan: vi.fn(call('plan-read')),
    savePlan: vi.fn(call('plan-save')),
    actPlan: vi.fn(call('plan-action')),
    setPlanCyclePrice: vi.fn(call('plan-cycle-price')),
    queryPlan: vi.fn(async ({ planId, cycleId }) => ({ success: true, data: { version: data.planLedgerV1.plans[planId].version, cycleId, total: a.total, models: [] } })),
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

/** 进页并等两张卡读完 */
async function visit() {
  const view = render(<PlanManagementPage />)
  await waitFor(() => expect(document.querySelector('.plan-sk')).toBeNull())
  await waitFor(() => expect(window.electronAPI.readPlan).toHaveBeenCalledTimes(2))
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
    await waitFor(() => expect(a.ledger().price).toBe(100))
    expect(a.ledger().autoRenew).toBe(true)
    expect(a.ledger().billingDay).toBe(20)
    expect(a.savePlan.mock.calls[1][0].expectedVersion).toBe(2)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('到期的卡：勾自动续费还在存就点「续了一期」，只多一期，不弹失败（自动续费已经续上了）', async () => {
    const a = ledgerApi({ now: '2026-09-21T04:00:00Z' })
    await visit()
    openSettings()
    const saving = deferred()
    a.gates.push(saving)
    fireEvent.click(screen.getByLabelText('到期自动进下一周期'))
    fireEvent.click(within(claudeCard()).getByRole('button', { name: '续了一期' }))
    await act(async () => {})
    await act(async () => saving.resolve())
    await waitFor(() => expect(a.ledger().autoRenew).toBe(true))
    await act(async () => {})
    await waitFor(() => expect(within(claudeCard()).queryByRole('button', { name: '续了一期' })).toBeNull())
    expect(a.ledger().cycles).toHaveLength(2)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('到期两个月的卡：改订阅费还在存时连点两次「续了一期」，只续一期，不弹失败', async () => {
    const a = ledgerApi({ now: '2026-11-25T04:00:00Z' })
    await visit()
    openSettings()
    const saving = deferred()
    a.gates.push(saving)
    typePrice('30')
    const renew = within(claudeCard()).getByRole('button', { name: '续了一期' })
    fireEvent.click(renew)
    fireEvent.click(renew)
    await act(async () => {})
    await act(async () => saving.resolve())
    await waitFor(() => expect(a.ledger().cycles).toHaveLength(2))
    await act(async () => {})
    await waitFor(() => expect(a.actPlan).toHaveBeenCalledTimes(1))
    expect(a.ledger().cycles).toHaveLength(2)
    expect(a.ledger().price).toBe(30)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('账本在别处改过（不是本页存的）：点「续了一期」仍按看着的那一版提交、被拒', async () => {
    const a = ledgerApi({ now: '2026-09-21T04:00:00Z' })
    await visit()
    a.elsewhere({ price: 30 })
    fireEvent.click(within(claudeCard()).getByRole('button', { name: '续了一期' }))
    await waitFor(() => expect(notifyToast).toHaveBeenCalledWith(FAILED))
    expect(a.actPlan.mock.calls[0][0].expectedVersion).toBe(1)
    expect(a.ledger().cycles).toHaveLength(1)
  })
})

describe('第一次设置', () => {
  it('没设过订阅，照提示值回车：订阅费、账单日、自动续费三样齐全交上去，存上', async () => {
    const a = ledgerApi({ plan: UNSET, metadata: { type: 'Pro', suggestedPrice: 20, suggestedBillingDay: 20 } })
    await visit()
    openSettings()
    fireEvent.keyDown(screen.getByLabelText('订阅费'), { key: 'Enter' })
    await waitFor(() => expect(a.ledger().price).toBe(20))
    expect(a.savePlan.mock.calls[0][0]).toMatchObject({ expectedVersion: 0, price: 20, billingDay: 20, autoRenew: false })
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })
})

describe('切回后改订阅设置', () => {
  it('切回马上打开设置、后台读到别处改过账单日：弹层里账单日换成新的，只改订阅费存进去的账单日是新的', async () => {
    const a = ledgerApi()
    ;(await visit()).unmount()
    a.elsewhere({ billingDay: 5 })
    const later = deferred()
    a.total = 1000
    a.queryPlan.mockImplementation(({ cycleId }) => later.promise.then(() => ({ success: true, data: { version: a.ledger().version, cycleId, total: a.total, models: [] } })))
    render(<PlanManagementPage />)
    openSettings()
    expect(screen.getByLabelText('账单日')).toHaveValue('20')
    await act(async () => {})
    await act(async () => later.resolve())
    await waitFor(() => expect(multiplier()).toBe('50×'))
    expect(screen.getByLabelText('账单日')).toHaveValue('5')
    typePrice('100')
    await waitFor(() => expect(a.ledger().price).toBe(100))
    expect(a.ledger().billingDay).toBe(5)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('垫着上次的卡（新数字还没出来）就改订阅费：只改订阅费，账单日照账本最新的，不弹失败', async () => {
    const a = ledgerApi()
    ;(await visit()).unmount()
    a.elsewhere({ billingDay: 5 })
    a.queryPlan.mockImplementation(() => new Promise(() => {}))
    render(<PlanManagementPage />)
    await act(async () => {})
    openSettings()
    typePrice('100')
    await waitFor(() => expect(a.ledger().price).toBe(100))
    expect(a.ledger().billingDay).toBe(5)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('切回后账本还没读回来就改订阅费：等读回来再按新账本存，不弹失败，账单日是新的', async () => {
    const a = ledgerApi()
    ;(await visit()).unmount()
    a.elsewhere({ billingDay: 5 })
    const later = deferred()
    const read = a.readPlan.getMockImplementation()
    a.readPlan.mockImplementation((p) => later.promise.then(() => read(p)))
    render(<PlanManagementPage />)
    openSettings()
    typePrice('100')
    await act(async () => {})
    expect(a.savePlan).not.toHaveBeenCalled()
    await act(async () => later.resolve())
    await waitFor(() => expect(a.ledger().price).toBe(100))
    expect(a.ledger().billingDay).toBe(5)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('上次的卡还没设订阅、别处已经设好：照提示值只改订阅费，账单日用账本里的，不用提示值', async () => {
    const a = ledgerApi({ plan: UNSET, metadata: { type: 'Pro', suggestedPrice: 20, suggestedBillingDay: 20 } })
    ;(await visit()).unmount()
    a.elsewhere({ ...PLAN, billingDay: 5, version: 0 })
    const later = deferred()
    const read = a.readPlan.getMockImplementation()
    a.readPlan.mockImplementation((p) => later.promise.then(() => read(p)))
    render(<PlanManagementPage />)
    openSettings()
    typePrice('100')
    await act(async () => {})
    await act(async () => later.resolve())
    await waitFor(() => expect(a.ledger().price).toBe(100))
    expect(a.ledger().billingDay).toBe(5)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('等账本读回来时统计又变了、又读了一次：接着等最新那次，按它存，不弹失败', async () => {
    const a = ledgerApi()
    ;(await visit()).unmount()
    a.elsewhere({ billingDay: 5 })
    const read = a.readPlan.getMockImplementation()
    const waits = []
    a.readPlan.mockImplementation((p) => {
      if (p.planId !== 'claude') return read(p)
      const d = deferred()
      waits.push(d)
      return d.promise.then(() => read(p))
    })
    render(<PlanManagementPage />)
    openSettings()
    typePrice('100')
    await act(async () => {})
    a.elsewhere({ billingDay: 6 })
    await act(async () => a.emitStats())
    expect(waits).toHaveLength(2)
    await act(async () => waits[0].resolve())
    expect(a.savePlan).not.toHaveBeenCalled()
    await act(async () => waits[1].resolve())
    await waitFor(() => expect(a.ledger().price).toBe(100))
    expect(a.ledger().billingDay).toBe(6)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('切回已停的卡、账本还没读回来就连点两次「重新开始」：只重开一期，不弹失败', async () => {
    const a = ledgerApi({ plan: { ...PLAN, stopped: true }, now: '2026-10-05T04:00:00Z' })
    ;(await visit()).unmount()
    const later = deferred()
    const read = a.readPlan.getMockImplementation()
    a.readPlan.mockImplementation((p) => later.promise.then(() => read(p)))
    render(<PlanManagementPage />)
    const restart = within(claudeCard()).getByRole('button', { name: '重新开始，从今天起算' })
    fireEvent.click(restart)
    fireEvent.click(restart)
    await act(async () => {})
    await act(async () => later.resolve())
    await waitFor(() => expect(a.ledger().stopped).toBe(false))
    await act(async () => {})
    await waitFor(() => expect(a.actPlan).toHaveBeenCalledTimes(1))
    expect(a.ledger().cycles).toHaveLength(2)
    expect(notifyToast).not.toHaveBeenCalledWith(FAILED)
  })

  it('写入被拒：卡片不停在「—」，马上重读，出新数字', async () => {
    const a = ledgerApi()
    ;(await visit()).unmount()
    a.elsewhere({ billingDay: 5 })
    let n = 0
    a.total = 1000
    a.queryPlan.mockImplementation(({ cycleId }) => (++n === 1 ? new Promise(() => {}) : Promise.resolve({ success: true, data: { version: a.ledger().version, cycleId, total: a.total, models: [] } })))
    a.savePlan.mockImplementation(async () => ({ success: false, error: 'PLAN_CONFLICT' }))
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
    a.elsewhere({ price: 40, cycles: [{ ...CYCLE, price: 40 }] })
    const later = deferred()
    a.total = 1000
    a.queryPlan.mockImplementation(({ cycleId }) => later.promise.then(() => ({ success: true, data: { version: a.ledger().version, cycleId, total: a.total, models: [] } })))
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
    a.elsewhere({ price: 30 })
    a.queryPlan.mockImplementation(async ({ cycleId }) => ({ success: true, data: { version: a.ledger().version, cycleId, pending: true } }))
    const watch = watchSkeleton()
    await act(async () => a.emitStats())
    a.readPlan.mockImplementation(async () => ({ success: false }))
    await act(async () => a.emitStats())
    expect(multiplier()).toBe('38×')
    watch.stop()
    expect(watch.seen).toEqual([])
  })
})

describe('订阅设置弹层：交什么在回车那一刻定下', () => {
  const plan = { ...PLAN }
  const pop = (props = {}) => {
    const onSave = props.onSave || vi.fn(async () => ({ success: true }))
    const view = render(<PlanSettingsPopover planId="claude" name="Claude Code" plan={plan} metadata={{ type: 'Pro' }} today="2026-09-16" onSave={onSave} onClose={() => {}} {...props} />)
    return { onSave, view }
  }

  it('自动续费还在存时改订阅费回车，之后卡上读到别处改的账单日：交的仍只有订阅费，不带回车那一刻的旧账单日', async () => {
    const renewal = deferred()
    const onSave = vi.fn((value) => ('autoRenew' in value ? renewal.promise : Promise.resolve({ success: true })))
    const { view } = pop({ onSave })
    fireEvent.click(screen.getByLabelText('到期自动进下一周期'))
    typePrice('100')
    view.rerender(<PlanSettingsPopover planId="claude" name="Claude Code" plan={{ ...plan, billingDay: 5, version: 2 }} metadata={{ type: 'Pro' }} today="2026-09-16" onSave={onSave} onClose={() => {}} />)
    expect(screen.getByLabelText('账单日')).toHaveValue('5')
    await act(async () => renewal.resolve({ success: true }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1][0]).toEqual({ price: 100 })
  })

  it('第一笔还没回来就改回原价、改账单日再回车：照最后一次输入交，不当成没改', async () => {
    const first = deferred()
    const onSave = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ success: true })
    pop({ onSave })
    typePrice('100')
    fireEvent.change(screen.getByLabelText('订阅费'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('账单日'), { target: { value: '12' } })
    fireEvent.keyDown(screen.getByLabelText('账单日'), { key: 'Enter' })
    await act(async () => first.resolve({ success: true }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1][0]).toEqual({ price: 20, billingDay: 12 })
  })

  it('第一笔还没回来就依次回车 100、120、100：三笔都交，最后一笔是 100', async () => {
    const first = deferred()
    const onSave = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ success: true })
    pop({ onSave })
    typePrice('100')
    typePrice('120')
    typePrice('100')
    await act(async () => first.resolve({ success: true }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(3))
    expect(onSave.mock.calls.map((c) => c[0].price)).toEqual([100, 120, 100])
  })

  it('弹层开着：存过账单日后别处改了账单日，再只改订阅费，不把存过的账单日再交一遍', async () => {
    const onSave = vi.fn(async () => ({ success: true }))
    const { view } = pop({ onSave })
    fireEvent.change(screen.getByLabelText('账单日'), { target: { value: '12' } })
    fireEvent.keyDown(screen.getByLabelText('账单日'), { key: 'Enter' })
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    await act(async () => {})
    view.rerender(<PlanSettingsPopover planId="claude" name="Claude Code" plan={{ ...plan, billingDay: 5, version: 3 }} metadata={{ type: 'Pro' }} today="2026-09-16" onSave={onSave} onClose={() => {}} />)
    expect(screen.getByLabelText('账单日')).toHaveValue('5')
    typePrice('100')
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1][0]).toEqual({ price: 100 })
  })

  it('弹层开着：存过 100、别处改成 120 后再输 100 回车：照交，不当成重复', async () => {
    const onSave = vi.fn(async () => ({ success: true }))
    const { view } = pop({ onSave })
    typePrice('100')
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    await act(async () => {})
    view.rerender(<PlanSettingsPopover planId="claude" name="Claude Code" plan={{ ...plan, price: 120, version: 3 }} metadata={{ type: 'Pro' }} today="2026-09-16" onSave={onSave} onClose={() => {}} />)
    expect(screen.getByLabelText('订阅费')).toHaveValue('120')
    typePrice('100')
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1][0]).toEqual({ price: 100 })
  })

  it('上次的卡没设订阅、也没有提示值：读到设好的订阅后空格子跟着填上，只改订阅费也能交', async () => {
    const unset = { cycles: [], version: 0, stopped: false }
    const { onSave, view } = pop({ plan: unset })
    expect(screen.getByLabelText('账单日')).toHaveValue('')
    view.rerender(<PlanSettingsPopover planId="claude" name="Claude Code" plan={{ ...plan, billingDay: 5 }} metadata={{ type: 'Pro' }} today="2026-09-16" onSave={onSave} onClose={() => {}} />)
    expect(screen.getByLabelText('账单日')).toHaveValue('5')
    typePrice('100')
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ price: 100 })
  })
})
