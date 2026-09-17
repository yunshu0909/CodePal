/* @vitest-environment node */
/** Daily cache, partial failure and IPC input contracts. @module tests/usageCalendarService */
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { aggregateUsageCalendar } = require('../electron/services/usageCalendarService')
const day = total => ({models:{a:{total}},summary:{total},generatedAt:'2026-09-16T04:00:00Z'})
const dependencies = () => ({nowFn:()=>new Date('2026-09-16T04:00:00Z'),findEarliestLogDateFn:async()=> '2026-09-15',readDailySummaryFn:vi.fn(async()=>day(60e6)),writeDailySummaryFn:vi.fn(),recomputeDailySummaryFn:vi.fn(async()=>day(5e6)),onProgress:vi.fn()})
describe('usage calendar daily results', () => {
  it('TC002/010/011: bypasses today cache, exposes each day and includes today in month', async () => {
    const deps = dependencies()
    const r = await aggregateUsageCalendar({month:'2026-09',taskId:'one'},deps)
    expect(r.success).toBe(true)
    expect(r.data.days['2026-09-15']).toMatchObject({status:'ready',total:60e6})
    expect(r.data.days['2026-09-16']).toMatchObject({status:'ready',total:5e6})
    expect(r.data.total).toBe(65e6)
    expect(deps.readDailySummaryFn.mock.calls.map(c=>c[0])).toEqual(['2026-09-15'])
    expect(deps.recomputeDailySummaryFn.mock.calls[0][0]).toBe('2026-09-16')
    expect(deps.writeDailySummaryFn).not.toHaveBeenCalledWith('2026-09-16', expect.anything(), expect.anything())
    expect(deps.onProgress.mock.calls.some(([p])=>p.taskId==='one'&&p.data.days['2026-09-15']?.status==='ready')).toBe(true)
  })
  it('TC012: failure retains other days, is not zero, retries only the requested day', async () => {
    const deps=dependencies();deps.readDailySummaryFn=async()=>null;deps.recomputeDailySummaryFn=vi.fn(async key=>{if(key.endsWith('15'))throw Error('unreadable');return day(5e6)})
    const r=await aggregateUsageCalendar({month:'2026-09',taskId:'partial'},deps)
    expect(r.data.complete).toBe(false)
    expect(r.data.days['2026-09-15']).toMatchObject({status:'failed'})
    expect(r.data.days['2026-09-15'].total).toBeUndefined()
    expect(r.data.total).toBe(5e6)
    deps.recomputeDailySummaryFn.mockClear()
    await aggregateUsageCalendar({month:'2026-09',taskId:'retry',retryDate:'2026-09-15'},deps)
    expect(deps.recomputeDailySummaryFn.mock.calls.map(c=>c[0])).toEqual(['2026-09-15'])
  })
  it('TC007/013: distinguishes no logs, all failures and invalid input', async () => {
    const deps=dependencies();deps.findEarliestLogDateFn=async()=>null
    expect((await aggregateUsageCalendar({month:'2026-09'},deps)).data.days).toEqual({})
    expect((await aggregateUsageCalendar({month:'2026-99'},deps)).success).toBe(false)
    expect((await aggregateUsageCalendar({month:'2026-10'},deps)).success).toBe(false)
    deps.findEarliestLogDateFn=async()=> '2026-09-15';deps.readDailySummaryFn=async()=>null;deps.recomputeDailySummaryFn=async()=>{throw Error('fail')}
    const r=await aggregateUsageCalendar({month:'2026-09'},deps)
    expect(r.data.failedDays).toBe(2)
    expect(r.data.complete).toBe(false)
  })
})
