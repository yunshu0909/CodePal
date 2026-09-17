/* @vitest-environment node */
/** One background clock; no UI lifecycle dependency. @module tests/sharedUsage/sharedScheduler */
import {it,expect,vi,afterEach} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {createUsageStatisticsScheduler}=require('../../electron/services/usageStatisticsScheduler')
afterEach(()=>vi.useRealTimers())
it('S04 every five minutes emits at most one tick and stop removes the timer',async()=>{
  vi.useFakeTimers();const tick=vi.fn(async()=>{}),bootstrap=vi.fn(async()=>{})
  const s=createUsageStatisticsScheduler({statistics:{tick,bootstrap},getCycles:async()=>[]});await s.start()
  expect(bootstrap).toHaveBeenCalledTimes(1);expect(tick).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(299999);expect(tick).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1);expect(tick).toHaveBeenCalledTimes(1)
  s.stop();await vi.advanceTimersByTimeAsync(600000);expect(tick).toHaveBeenCalledTimes(1)
})
it('S04 slow scan skips timer overlaps instead of accumulating a queue',async()=>{
  vi.useFakeTimers();let finish;const tick=vi.fn(()=>new Promise(r=>{finish=r}))
  const s=createUsageStatisticsScheduler({statistics:{tick,bootstrap:async()=>{}},getCycles:async()=>[]});await s.start()
  await vi.advanceTimersByTimeAsync(300000);await vi.advanceTimersByTimeAsync(900000);expect(tick).toHaveBeenCalledTimes(1)
  finish();await Promise.resolve();await vi.advanceTimersByTimeAsync(300000);expect(tick).toHaveBeenCalledTimes(2);s.stop()
})
it('S04 startup with a two-minute-old snapshot waits only the remaining three minutes',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-17T04:02Z'));const tick=vi.fn(async()=>{})
  const s=createUsageStatisticsScheduler({statistics:{tick,bootstrap:async()=>({lastRunAt:'2026-09-17T04:00:00.000Z'})}});await s.start()
  await vi.advanceTimersByTimeAsync(179999);expect(tick).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(tick).toHaveBeenCalledTimes(1);s.stop()
})
