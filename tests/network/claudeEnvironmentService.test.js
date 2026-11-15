// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createClaudeEnvironmentService } = require('../../electron/modules/claudeEnvironment/service')
const { present, cleanNetwork, STALE_MS } = require('../../electron/modules/claudeEnvironment/state')
const metadata = () => ({ supported: true, available: true, fingerprint: 'profile-one', entryManaged: true, expectedIp: '203.0.113.24', proxyPort: 17897 })
const network = () => ({ proxyReady: true, isolationActive: true, egress: { ok: true, ip: '203.0.113.24', country: 'US' }, dns: { complete: true, resolvers: [{ ip: '198.51.100.53', country: 'US' }] } })
function create(extra = {}) {
  const store = { get: () => ({ enabled: false }), set: vi.fn() }
  const probe = vi.fn(async () => network())
  const notify = vi.fn()
  const service = createClaudeEnvironmentService({ store, probe, notify, inspect: async () => metadata(), ...extra })
  return { service, store, probe, notify }
}

describe('Claude 专用环境监测', () => {
  it('DNS 与 HTTP 地址不同但都在美国，仍判正常；不透传未知字段', async () => {
    const fixture = create({ probe: async () => ({ ...network(), authorization: 'secret_test_value' }) })
    const state = await fixture.service.sampleOnce()
    expect(state.code).toBe('healthy')
    expect(state.checks).toHaveLength(5)
    expect(JSON.stringify(state)).not.toContain('secret_test_value')
    expect(JSON.stringify(state)).not.toContain('profile-one')
    await fixture.service.dispose()
  })

  it('代理停止时 HTTP 和 DNS 均不借系统结果冒充专用路径', async () => {
    const { service } = create({ probe: async () => ({ proxyReady: false }) })
    const state = await service.sampleOnce()
    expect(state.code).toBe('proxy')
    expect(state.egress.ip).toBeNull()
    expect(state.checks.find(item => item.id === 'dns').label).toBe('未检测')
    expect(state.checks.find(item => item.id === 'dns').kind).toBe('unknown')
    await service.dispose()
  })

  it('检测超时后只在历史位置保留上次成功 IP，当前地区保持未知', async () => {
    const { service, probe } = create()
    await service.sampleOnce()
    probe.mockRejectedValueOnce(Error('HTTP failed with private data'))
    const state = await service.sampleOnce()
    expect(state.code).toBe('failed')
    expect(state.egress.ip).toBeNull()
    expect(state.lastSuccess.ip).toBe('203.0.113.24')
    expect(JSON.stringify(state)).not.toContain('private data')
    await service.dispose()
  })

  it('仍在美国但固定 IP 不同，明确标为启动器地址不一致', async () => {
    const data = network()
    data.egress.ip = '203.0.113.42'
    const { service } = create({ probe: async () => data })
    const state = await service.sampleOnce()
    expect(state.code).toBe('ipchanged')
    expect(state.label).toBe('出口 IP 已变')
    expect(state.checks.find(item => item.id === 'launcher').kind).toBe('warn')
    await service.dispose()
  })

  it('已知 DNS 地区不符合与缺少 DNS 证据分别表达', async () => {
    const data = network()
    data.dns.resolvers[0].country = 'CN'
    const { service, probe } = create({ probe: vi.fn(async () => data) })
    expect((await service.sampleOnce()).code).toBe('dnsRegion')
    data.dns.complete = false
    probe.mockResolvedValue(data)
    expect((await service.sampleOnce()).code).toBe('dns')
    await service.dispose()
  })

  it('持续监测同一异常不重复提醒，恢复后只提醒一次', async () => {
    const data = network()
    data.dns.complete = false
    const notify = vi.fn()
    const probe = vi.fn(async () => data)
    const service = createClaudeEnvironmentService({ store: { get: () => ({ enabled: true }), set: vi.fn() }, inspect: async () => metadata(), probe, notify })
    const first = await service.sampleOnce('automatic')
    expect(first.busy).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    await service.sampleOnce('automatic')
    expect(notify).toHaveBeenCalledTimes(1)
    data.dns.complete = true
    await service.sampleOnce('automatic')
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1][0].title).toContain('恢复正常')
    expect(notify.mock.calls[1][0].kind).toBe('recovered')
    await service.dispose()
  })

  it('恢复提醒复用全局完成图标，不继续使用异常的橙色图标', () => {
    const { withNetworkStyle } = require('../../electron/services/egressNotifier')
    const notification = withNetworkStyle({ kind: 'recovered', title: 'Claude 环境 · 恢复正常', body: '已恢复' }, '/assets')
    expect(notification.icon).toBe('/assets/done.png')
    expect(notification.sound).toBe('Glass')
  })

  it('初始化只建立一个调度；已配置环境默认监测，前台不重复发系统通知', async () => {
    const schedule = vi.fn(() => 7)
    const unschedule = vi.fn()
    const data = network()
    data.dns.complete = false
    const notify = vi.fn()
    const service = createClaudeEnvironmentService({ store: { get: () => ({}), set: vi.fn() }, inspect: async () => metadata(), probe: async () => data, notify, isWindowFocused: () => true, setIntervalFn: schedule, clearIntervalFn: unschedule })
    service.setForeground(true)
    await Promise.all([service.initialize(), service.initialize()])
    await service.sampleOnce()
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
    expect((await service.readState()).monitoring).toBe(true)
    await service.dispose()
    expect(unschedule).toHaveBeenCalledWith(7)
  })

  it('两个手动入口重叠时只采样一次，退出取消自己的探测', async () => {
    let finish
    const probe = vi.fn(({ signal }) => new Promise(resolve => {
      finish = resolve
      signal.addEventListener('abort', () => resolve(network()), { once: true })
    }))
    const { service } = create({ probe })
    const events = vi.fn()
    service.subscribe(events)
    const first = service.sampleOnce()
    const second = service.sampleOnce()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    const count = events.mock.calls.length
    await service.dispose()
    finish(network())
    await Promise.all([first, second])
    expect(events).toHaveBeenCalledTimes(count)
  })

  it('手动检测并入自动采样后，关闭持续监测仍让该次手动结果完成', async () => {
    let finish
    let activeSignal
    const probe = vi.fn(({ signal }) => new Promise(resolve => {
      finish = resolve
      activeSignal = signal
      signal.addEventListener('abort', () => resolve(network()), { once: true })
    }))
    const { service } = create({ probe })
    const automatic = service.sampleOnce('automatic')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    const manual = service.sampleOnce('manual')
    try {
      await service.setMonitoring(false)
      expect(activeSignal.aborted).toBe(false)
      finish(network())
      const result = await manual
      expect(result.code).toBe('healthy')
      expect(result.monitoring).toBe(false)
      expect(probe).toHaveBeenCalledTimes(1)
    } finally {
      finish(network())
      await automatic
      await service.dispose()
    }
  })

  it('首次初始化很慢时，不覆盖用户刚关闭的监测开关', async () => {
    let finishInspection
    let calls = 0
    let preference = {}
    const store = { get: () => preference, set: (_key, value) => { preference = value } }
    const schedule = vi.fn(() => 7)
    const probe = vi.fn(async () => network())
    const inspect = () => ++calls === 1 ? new Promise(resolve => { finishInspection = resolve }) : Promise.resolve(metadata())
    const { service } = create({ store, inspect, probe, setIntervalFn: schedule, clearIntervalFn: vi.fn() })
    const initializing = service.initialize()
    await service.setMonitoring(false)
    finishInspection(metadata())
    try {
      await initializing
      expect((await service.readState()).monitoring).toBe(false)
      expect(preference.enabled).toBe(false)
      expect(schedule).not.toHaveBeenCalled()
      expect(probe).not.toHaveBeenCalled()
    } finally {
      await service.dispose()
    }
  })

  it('采样途中入口改变，迟到的正常结果只能当历史证据', async () => {
    let calls = 0
    const { service } = create({ inspect: async () => ({ ...metadata(), fingerprint: ++calls === 1 ? 'old' : 'new', entryManaged: calls === 1 }) })
    const state = await service.sampleOnce()
    expect(state.code).toBe('stale')
    expect(state.checks.every(item => item.kind === 'unknown')).toBe(true)
    await service.dispose()
  })

  it('过期结果的每项状态都变成历史，不保留绿色正常点', () => {
    const state = present({ metadata: metadata(), sample: { checkedAt: 1, fingerprint: 'profile-one', network: cleanNetwork(network()) }, monitoring: false, busy: false, history: [], now: STALE_MS + 2 })
    expect(state.code).toBe('stale')
    expect(state.checks.every(item => item.kind === 'unknown' && item.label.startsWith('上次：'))).toBe(true)
  })

  it('未接入的机器不会发请求；保存开关失败时保留原设置', async () => {
    const unavailable = create({ inspect: async () => ({ supported: true, available: false, reason: 'missing' }) })
    await unavailable.service.initialize()
    await unavailable.service.sampleOnce()
    expect(unavailable.probe).not.toHaveBeenCalled()
    await expect(unavailable.service.setMonitoring(true)).rejects.toThrow('ENVIRONMENT_UNAVAILABLE')
    await unavailable.service.dispose()
    const failing = create({ store: { get: () => ({ enabled: false }), set: () => { throw Error('read-only') } } })
    await expect(failing.service.setMonitoring(true)).rejects.toThrow('PREFERENCES_FAILED')
    expect((await failing.service.readState()).monitoring).toBe(false)
    await failing.service.dispose()
  })
})
