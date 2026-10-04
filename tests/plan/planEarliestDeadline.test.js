// @vitest-environment node
/** A stalled historical lookup must release ledger work without cancelling shared discovery. */
import { it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPlanStoreService } = require('../../electron/services/plan/planStoreService')

afterEach(() => vi.useRealTimers())

function fixture(earliestFn) {
  const data = new Map()
  return createPlanStoreService({
    store: {
      get: key => data.get(key),
      set: async (key, value) => data.set(key, structuredClone(value))
    },
    earliestFn,
    metadataFn: async () => ({ type: 'unknown' }),
    nowFn: () => new Date('2026-10-04T04:00Z')
  })
}

it('TC-014 a never-resolving earliest lookup releases a queued read and save within two seconds', async () => {
  vi.useFakeTimers()
  const service = fixture(() => new Promise(() => {}))
  let readFinished = false
  let saved = false
  const read = service.readLedger('claude').then(value => {
    readFinished = true
    return value
  })
  const save = service.save('claude', { price: 20, billingDay: 4, autoRenew: false }, 'fixture-save', { expectedVersion: 0 }).then(value => {
    saved = true
    return value
  })
  await vi.advanceTimersByTimeAsync(2100)
  expect(readFinished).toBe(true)
  expect(saved).toBe(true)
  expect((await read).plan.version).toBe(0)
  expect((await save).plan.version).toBe(1)
})

it('TC-014 a timed-out discovery stays shared and a late completion permits a fresh subsequent lookup', async () => {
  vi.useFakeTimers()
  let finish
  const discovery = new Promise(resolve => { finish = resolve })
  const earliest = vi.fn().mockImplementationOnce(() => discovery).mockResolvedValue(null)
  const service = fixture(earliest)
  let firstFinished = false
  const first = service.readLedger('claude').then(value => {
    firstFinished = true
    return value
  })
  await vi.advanceTimersByTimeAsync(2100)
  expect(firstFinished).toBe(true)
  await first
  let secondFinished = false
  const second = service.readLedger('claude').then(value => {
    secondFinished = true
    return value
  })
  await vi.advanceTimersByTimeAsync(2100)
  expect(secondFinished).toBe(true)
  await second
  expect(earliest).toHaveBeenCalledTimes(1)
  finish(null)
  await vi.advanceTimersByTimeAsync(0)
  expect((await service.readLedger('claude')).plan.version).toBe(0)
  expect(earliest).toHaveBeenCalledTimes(2)
})
