/**
 * 出口 IP 监控服务测试
 *
 * 负责：
 * - 按 specs/v2.3-网络诊断重做 的 AC-01..AC-12 断言服务层行为
 * - 上次结果与变化记录的持久化、7 天 / 200 条保留、归属地查询时机、失败原因
 * - 系统通知的发送条件（变化、连续 3 次失败、停在本页不发）
 *
 * @module tests/network/egressMonitorService.test
 */

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const service = require('../../electron/services/networkDiagnosticsService.js')
const { createNetworkDiagnosticsService } = service

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 8, 19, 6, 0, 0)
const TOKYO = { country: '日本', city: 'Tokyo' }
const LA = { country: '美国', city: 'Los Angeles' }

/** 内存版 electron-store */
function makeStore(initial = {}) {
  const data = { ...initial }
  return {
    data,
    get: vi.fn((key, fallback) => (key in data ? data[key] : fallback)),
    set: vi.fn((key, value) => { data[key] = value }),
  }
}

/**
 * 组装一个可控的服务实例
 * @param {object} o
 */
function setup(o = {}) {
  let now = o.now ?? T0
  const ips = [...(o.ips || [])]
  const store = makeStore(o.stored)
  const intervals = []
  const deps = {
    store,
    nowFn: () => now,
    probePublicIpFn: vi.fn(async () => {
      const next = ips.shift()
      if (next === undefined) throw new Error('no more fake results')
      return next
    }),
    lookupLocationFn: vi.fn(async (ip) => (o.locations ? o.locations[ip] ?? null : TOKYO)),
    notify: vi.fn(),
    isWindowFocused: vi.fn(() => o.focused ?? false),
    setIntervalFn: vi.fn((fn, ms) => { intervals.push({ fn, ms }); return intervals.length }),
    clearIntervalFn: vi.fn(),
    getWindow: () => null,
  }
  const svc = createNetworkDiagnosticsService(deps)
  return {
    svc, store, deps, intervals,
    advance: (ms) => { now += ms },
    ok: (ip) => ips.push({ success: true, ip, source: 'ipify', error: null }),
    fail: (error = 'REQUEST_TIMEOUT_6000MS') => ips.push({ success: false, ip: null, source: 'icanhazip', error }),
  }
}

describe('上次结果与进页读取', () => {
  it('TC-01 成功检测写入 lastResult；监控关着时 initialize 不发请求', async () => {
    const t = setup({ stored: { 'networkDiagnostics.lastResult': { ip: '203.0.113.24', location: TOKYO, checkedAt: T0 - DAY } } })
    t.svc.initialize()
    expect(t.deps.probePublicIpFn).not.toHaveBeenCalled()
    expect(t.svc.getState().current).toEqual({ ip: '203.0.113.24', location: TOKYO, checkedAt: T0 - DAY })

    t.ok('203.0.113.24')
    await t.svc.probeIpOnce()
    expect(t.store.data['networkDiagnostics.lastResult']).toEqual({ ip: '203.0.113.24', location: TOKYO, checkedAt: T0 })
  })
})

describe('变化记录', () => {
  it('TC-02 变化头插记录；监控关着时 foundByManual=true', async () => {
    const t = setup({ locations: { '203.0.113.24': TOKYO, '203.0.113.87': LA } })
    t.svc.initialize()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    t.advance(60_000)
    t.ok('203.0.113.87'); await t.svc.probeIpOnce()

    const log = t.store.data['networkDiagnostics.changeLog']
    expect(log).toEqual([{ at: T0 + 60_000, fromIp: '203.0.113.24', toIp: '203.0.113.87', fromLocation: TOKYO, toLocation: LA, foundByManual: true }])
    expect(t.svc.getState().changeLog[0].toIp).toBe('203.0.113.87')
    expect(t.svc.getState().status).toBe('switched')
  })

  it('TC-02 监控开着时 foundByManual=false；重启后与持久化 IP 比较也算变化', async () => {
    const t = setup({
      stored: {
        'networkDiagnostics.continuousMonitoring': true,
        'networkDiagnostics.lastResult': { ip: '198.51.100.9', location: TOKYO, checkedAt: T0 - DAY },
      },
      locations: { '203.0.113.24': LA },
    })
    t.ok('203.0.113.24')
    t.svc.initialize()
    await vi.waitFor(() => expect(t.store.data['networkDiagnostics.changeLog']).toHaveLength(1))
    expect(t.store.data['networkDiagnostics.changeLog'][0]).toMatchObject({ fromIp: '198.51.100.9', toIp: '203.0.113.24', foundByManual: false })
  })

  it('TC-03 只保留 7 天内且最多 200 条', async () => {
    const old = Array.from({ length: 250 }, (_, i) => ({
      at: T0 - i * 60_000, fromIp: '198.51.100.1', toIp: '198.51.100.2', fromLocation: null, toLocation: null, foundByManual: false,
    }))
    old.push({ at: T0 - 8 * DAY, fromIp: 'x', toIp: 'y', fromLocation: null, toLocation: null, foundByManual: false })
    const t = setup({ stored: { 'networkDiagnostics.changeLog': old, 'networkDiagnostics.lastResult': { ip: '198.51.100.2', location: TOKYO, checkedAt: T0 } } })
    t.svc.initialize()
    expect(t.svc.getState().changeLog).toHaveLength(200)

    t.advance(1000)
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    const saved = t.store.data['networkDiagnostics.changeLog']
    expect(saved).toHaveLength(200)
    expect(saved[0].toIp).toBe('203.0.113.24')
    expect(saved.every((r) => r.at >= T0 + 1000 - 7 * DAY)).toBe(true)
  })

  it('TC-03 读取时过滤掉已过 7 天的记录', () => {
    const t = setup({ stored: { 'networkDiagnostics.changeLog': [
      { at: T0 - 2 * DAY, fromIp: 'a', toIp: 'b', fromLocation: null, toLocation: null, foundByManual: false },
      { at: T0 - 7 * DAY - 1, fromIp: 'c', toIp: 'd', fromLocation: null, toLocation: null, foundByManual: false },
    ] } })
    t.svc.initialize()
    expect(t.svc.getState().changeLog.map((r) => r.toIp)).toEqual(['b'])
  })

  it('TC-04 第一次成功 hasCompared=false，第二次起 true 并持久化', async () => {
    const t = setup()
    t.svc.initialize()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    expect(t.svc.getState().hasCompared).toBe(false)
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    expect(t.svc.getState().hasCompared).toBe(true)
    expect(t.store.data['networkDiagnostics.hasCompared']).toBe(true)
  })

  it('TC-10 不再按 30 分钟一轮清零', async () => {
    const t = setup({ locations: { a: null } })
    t.svc.initialize()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    t.advance(40 * 60_000)
    t.ok('203.0.113.87'); await t.svc.probeIpOnce()
    t.advance(40 * 60_000)
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    expect(t.svc.getState().changeLog).toHaveLength(2)
  })
})

describe('归属地', () => {
  it('TC-05 第一次查；IP 不变不查；变了再查', async () => {
    const t = setup({ locations: { '203.0.113.24': TOKYO, '203.0.113.87': LA } })
    t.svc.initialize()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    expect(t.deps.lookupLocationFn).toHaveBeenCalledTimes(1)
    t.ok('203.0.113.87'); await t.svc.probeIpOnce()
    expect(t.deps.lookupLocationFn).toHaveBeenCalledTimes(2)
    expect(t.svc.getState().current.location).toEqual(LA)
  })

  it('TC-05 查不到时 location=null 且检测仍成功；下次检测补查', async () => {
    const t = setup()
    t.deps.lookupLocationFn.mockResolvedValueOnce(null)
    t.svc.initialize()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    expect(t.svc.getState().current).toMatchObject({ ip: '203.0.113.24', location: null })
    expect(t.svc.getState().status).toBe('stable')
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    expect(t.deps.lookupLocationFn).toHaveBeenCalledTimes(2)
    expect(t.svc.getState().current.location).toEqual(TOKYO)
  })

  it('TC-05 查询抛错也不影响检测成功', async () => {
    const t = setup()
    t.deps.lookupLocationFn.mockRejectedValueOnce(new Error('boom'))
    t.svc.initialize()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    expect(t.svc.getState()).toMatchObject({ status: 'stable', current: { ip: '203.0.113.24', location: null } })
  })
})

describe('失败原因', () => {
  it('TC-06 超时 → timeout，其他 → other，成功后清空；失败保留上次结果', async () => {
    const t = setup()
    t.svc.initialize()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    t.fail('REQUEST_TIMEOUT_6000MS'); await t.svc.probeIpOnce()
    expect(t.svc.getState()).toMatchObject({ status: 'failed', failReason: 'timeout', current: { ip: '203.0.113.24' } })
    t.fail('getaddrinfo ENOTFOUND api.ipify.org'); await t.svc.probeIpOnce()
    expect(t.svc.getState().failReason).toBe('other')
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    expect(t.svc.getState()).toMatchObject({ status: 'stable', failReason: null, consecutiveFailCount: 0 })
  })
})

describe('系统通知', () => {
  it('TC-07 监控开着发生变化 → 通知文案含两端归属地', async () => {
    const t = setup({ locations: { '203.0.113.24': TOKYO, '203.0.113.87': LA } })
    t.svc.initialize()
    t.ok('203.0.113.24')
    t.svc.setContinuousMonitoring(true)
    await vi.waitFor(() => expect(t.svc.getState().current?.ip).toBe('203.0.113.24'))
    t.ok('203.0.113.87')
    await t.intervals.at(-1).fn()
    await vi.waitFor(() => expect(t.deps.notify).toHaveBeenCalledTimes(1))
    expect(t.deps.notify).toHaveBeenCalledWith({
      kind: 'changed',
      title: '出口 IP 变了',
      body: '203.0.113.24（日本 · Tokyo）→ 203.0.113.87（美国 · Los Angeles）',
    })
  })

  it('TC-07 监控关着手动发现变化不通知；归属地缺失时省掉括号', async () => {
    const t = setup({ locations: {} })
    t.svc.initialize()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    t.ok('203.0.113.87'); await t.svc.probeIpOnce()
    expect(t.deps.notify).not.toHaveBeenCalled()
    expect(service.buildEgressNotification('changed', { fromIp: '1.1.1.1', toIp: '2.2.2.2', fromLocation: null, toLocation: { country: '日本', city: null } }))
      .toEqual({ kind: 'changed', title: '出口 IP 变了', body: '1.1.1.1 → 2.2.2.2（日本）' })
  })

  it('TC-08 连续 3 次失败只通知一次，成功后复位', async () => {
    const t = setup()
    t.svc.initialize()
    t.ok('203.0.113.24')
    t.svc.setContinuousMonitoring(true)
    await vi.waitFor(() => expect(t.svc.getState().status).toBe('stable'))
    const tick = t.intervals.at(-1).fn
    for (let i = 0; i < 4; i++) { t.fail(); await tick() }
    await vi.waitFor(() => expect(t.svc.getState().consecutiveFailCount).toBe(4))
    expect(t.deps.notify).toHaveBeenCalledTimes(1)
    expect(t.deps.notify).toHaveBeenCalledWith({ kind: 'unreachable', title: '测不到出口 IP', body: '已连续 3 次检测失败，检查网络或代理' })
    t.ok('203.0.113.24'); await tick()
    for (let i = 0; i < 3; i++) { t.fail(); await tick() }
    await vi.waitFor(() => expect(t.deps.notify).toHaveBeenCalledTimes(2))
  })

  it('TC-15 关着时手动失败不计入：重新打开监控后要再连续失败 3 次才通知', async () => {
    const t = setup()
    t.svc.initialize()
    t.ok('203.0.113.24'); await t.svc.probeIpOnce()
    for (let i = 0; i < 2; i++) { t.fail(); await t.svc.probeIpOnce() }
    t.fail()
    t.svc.setContinuousMonitoring(true)
    await vi.waitFor(() => expect(t.svc.getState().status).toBe('failed'))
    expect(t.svc.getState().consecutiveFailCount).toBe(1)
    expect(t.deps.notify).not.toHaveBeenCalled()
    const tick = t.intervals.at(-1).fn
    t.fail(); await tick()
    expect(t.deps.notify).not.toHaveBeenCalled()
    t.fail(); await tick()
    expect(t.deps.notify).toHaveBeenCalledTimes(1)
  })

  it('TC-15 对外 state 只含定稿 §7.2 的字段', () => {
    const t = setup()
    t.svc.initialize()
    expect(Object.keys(t.svc.getState()).sort()).toEqual(['changeLog', 'consecutiveFailCount', 'current', 'failReason', 'hasCompared', 'isEnabled', 'status'])
  })

  it('TC-08 监控关着时手动连续失败不通知', async () => {
    const t = setup()
    t.svc.initialize()
    for (let i = 0; i < 3; i++) { t.fail(); await t.svc.probeIpOnce() }
    expect(t.deps.notify).not.toHaveBeenCalled()
  })

  it('TC-09 停在本页且窗口聚焦时不通知；页面在前但窗口未聚焦时通知', async () => {
    const t = setup({ focused: true, locations: { '203.0.113.24': TOKYO, '203.0.113.87': LA } })
    t.svc.initialize()
    t.svc.setForeground(true)
    t.ok('203.0.113.24')
    t.svc.setContinuousMonitoring(true)
    await vi.waitFor(() => expect(t.svc.getState().current?.ip).toBe('203.0.113.24'))
    t.ok('203.0.113.87'); await t.intervals.at(-1).fn()
    await vi.waitFor(() => expect(t.svc.getState().current?.ip).toBe('203.0.113.87'))
    expect(t.deps.notify).not.toHaveBeenCalled()

    t.deps.isWindowFocused.mockReturnValue(false)
    t.ok('203.0.113.24'); await t.intervals.at(-1).fn()
    await vi.waitFor(() => expect(t.deps.notify).toHaveBeenCalledTimes(1))
  })
})

describe('开关与已撤掉的能力', () => {
  it('TC-10 服务不再导出 API 连通性探测', () => {
    expect(service.probeAllEndpoints).toBeUndefined()
    expect(service.ENDPOINT_PROBES).toBeUndefined()
  })

  it('TC-14 AC-12 打开开关后立即检测一次，并按间隔建定时器；关闭后清掉定时器', async () => {
    const t = setup()
    t.svc.initialize()
    t.ok('203.0.113.24')
    t.svc.setContinuousMonitoring(true)
    expect(t.deps.probePublicIpFn).toHaveBeenCalledTimes(1)
    expect(t.intervals.at(-1).ms).toBe(60000)
    await vi.waitFor(() => expect(t.svc.getState().current?.ip).toBe('203.0.113.24'))
    expect(t.store.data['networkDiagnostics.continuousMonitoring']).toBe(true)
    t.svc.setContinuousMonitoring(false)
    expect(t.deps.clearIntervalFn).toHaveBeenCalled()
    expect(t.svc.getState().isEnabled).toBe(false)
  })

  it('TC-14 AC-12 开关写入失败抛错且状态不变', () => {
    const t = setup()
    t.store.set.mockImplementation((key) => { if (key === 'networkDiagnostics.continuousMonitoring') throw new Error('disk full') })
    t.svc.initialize()
    expect(() => t.svc.setContinuousMonitoring(true)).toThrow()
    expect(t.svc.getState().isEnabled).toBe(false)
  })
})
