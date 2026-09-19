/**
 * 出口 IP 页面视图推导测试
 *
 * 负责：
 * - 从服务 state 推导页面画面：mode、标签、变化行、失败句
 * - 时间与归属地的写法、记录行、计数与两种空态
 *
 * @module tests/network/egressView.test
 */

import { describe, it, expect } from 'vitest'
import { deriveEgressView, formatClock, formatLocation } from '../../src/pages/network/egressView'

const at = (d, h, m, s) => new Date(2026, 8, d, h, m, s).getTime()
const NOW = at(19, 14, 40, 0)
const TOKYO = { country: '日本', city: 'Tokyo' }
const LA = { country: '美国', city: 'Los Angeles' }

const base = { isEnabled: false, status: 'idle', current: null, changeLog: [], hasCompared: false, failReason: null, consecutiveFailCount: 0 }
const withIp = (extra = {}) => ({ ...base, status: 'stable', current: { ip: '203.0.113.24', location: TOKYO, checkedAt: at(19, 14, 32, 5) }, ...extra })

describe('写法', () => {
  it('TC-13 时间：今天只写时间（卡片）或加「今天」（记录）；昨天；更早 M月D日', () => {
    expect(formatClock(at(19, 9, 5, 3), NOW)).toBe('09:05:03')
    expect(formatClock(at(19, 9, 5, 3), NOW, { todayPrefix: true })).toBe('今天 09:05:03')
    expect(formatClock(at(18, 22, 41, 17), NOW)).toBe('昨天 22:41:17')
    expect(formatClock(at(17, 8, 0, 0), NOW)).toBe('9月17日 08:00:00')
    expect(formatClock(new Date(2026, 0, 5, 1, 2, 3).getTime(), NOW)).toBe('1月5日 01:02:03')
  })

  it('TC-13 归属地：国家 · 城市；只有国家；都没有为空', () => {
    expect(formatLocation(TOKYO)).toBe('日本 · Tokyo')
    expect(formatLocation({ country: '日本', city: null })).toBe('日本')
    expect(formatLocation(null)).toBe('')
    expect(formatLocation({ country: null, city: null })).toBe('')
  })
})

describe('出口 IP 卡', () => {
  it('TC-13 从未检测', () => {
    const v = deriveEgressView(base, { now: NOW })
    expect(v).toMatchObject({ mode: 'na', tag: null, button: { label: '检测一次', primary: true, disabled: false } })
  })

  it('TC-13 首次检测中 / 再次检测中', () => {
    expect(deriveEgressView({ ...base, status: 'detecting' }, { now: NOW })).toMatchObject({ mode: 'first', button: { label: '检测中…', primary: true, disabled: true } })
    expect(deriveEgressView(withIp(), { now: NOW, probing: true })).toMatchObject({ mode: 'again', ip: '203.0.113.24', button: { label: '检测中…', primary: false, disabled: true } })
  })

  it('TC-13 有结果：监控关不挂标签，监控开 10 分钟内没变挂稳定', () => {
    const off = deriveEgressView(withIp(), { now: NOW })
    expect(off).toMatchObject({ mode: 'ok', tag: null, ip: '203.0.113.24', locationText: '日本 · Tokyo', checkedText: '14:32:05', change: null, button: { label: '检测一次', primary: false } })
    expect(deriveEgressView(withIp({ isEnabled: true }), { now: NOW }).tag).toBe('stable')
  })

  it('TC-13 10 分钟内变到当前 IP：变化行 + 监控开挂刚变化；超过 10 分钟收起', () => {
    const log = [{ at: at(19, 14, 35, 10), fromIp: '198.51.100.24', toIp: '203.0.113.24', fromLocation: LA, toLocation: TOKYO, foundByManual: false }]
    const v = deriveEgressView(withIp({ isEnabled: true, changeLog: log }), { now: NOW })
    expect(v.tag).toBe('changed')
    expect(v.change).toEqual({ timeText: '14:35:10', fromIp: '198.51.100.24', fromLocationText: '美国 · Los Angeles' })
    const later = deriveEgressView(withIp({ isEnabled: true, changeLog: log }), { now: at(19, 14, 45, 11) })
    expect(later).toMatchObject({ tag: 'stable', change: null })
    const manual = deriveEgressView(withIp({ changeLog: log }), { now: NOW })
    expect(manual.tag).toBeNull()
    expect(manual.change).not.toBeNull()
  })

  it('TC-13 失败：两种原因，按钮换重试，有上次结果时给上次成功，不挂标签', () => {
    const v = deriveEgressView(withIp({ isEnabled: true, status: 'failed', failReason: 'timeout' }), { now: NOW })
    expect(v).toMatchObject({ mode: 'fail', tag: null, failText: '连接检测服务超时，检查网络或代理后重试', button: { label: '重试', primary: false } })
    expect(v.lastSuccess).toEqual({ ip: '203.0.113.24', locationText: '日本 · Tokyo', timeText: '14:32:05' })
    const first = deriveEgressView({ ...base, status: 'failed', failReason: 'other' }, { now: NOW })
    expect(first).toMatchObject({ mode: 'fail', failText: '公网 IP 检测失败，请检查网络连接', lastSuccess: null })
  })
})

describe('变化记录', () => {
  it('TC-13 计数、行、检测时发现', () => {
    const log = [
      { at: at(19, 14, 35, 10), fromIp: '203.0.113.24', toIp: '203.0.113.87', fromLocation: null, toLocation: null, foundByManual: true },
      { at: at(18, 22, 41, 17), fromIp: '198.51.100.9', toIp: '203.0.113.24', fromLocation: null, toLocation: null, foundByManual: false },
    ]
    const v = deriveEgressView(withIp({ changeLog: log }), { now: NOW })
    expect(v.logCountText).toBe('近 7 天 2 次')
    expect(v.log).toEqual([
      { key: `${log[0].at}-203.0.113.87`, timeText: '今天 14:35:10', fromIp: '203.0.113.24', toIp: '203.0.113.87', foundByManual: true },
      { key: `${log[1].at}-203.0.113.24`, timeText: '昨天 22:41:17', fromIp: '198.51.100.9', toIp: '203.0.113.24', foundByManual: false },
    ])
    expect(v.emptyText).toBeNull()
  })

  it('TC-13 两种空态', () => {
    expect(deriveEgressView(withIp(), { now: NOW }).emptyText).toBe('还没有 IP 变化记录')
    expect(deriveEgressView(withIp({ hasCompared: true }), { now: NOW }).emptyText).toBe('近 7 天没有 IP 变化')
  })
})
