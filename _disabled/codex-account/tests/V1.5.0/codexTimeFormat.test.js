/**
 * codexTimeFormat 单元测试
 *
 * 覆盖：
 * - fiveHourWindowText / sevenDayWindowText：各种时间差下的文案 + urgent 标记
 * - lastSwitchText：刚刚 / N 分钟前 / 今天 HH:MM / 昨天 / N 天前 / MM-DD
 *
 * @module 自动化测试/V1.5.0/codexTimeFormat.test
 */

import { describe, it, expect } from 'vitest'
import {
  fiveHourWindowText,
  sevenDayWindowText,
  lastSwitchText,
} from '../../src/pages/codex-account/codexTimeFormat.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('fiveHourWindowText', () => {
  it('null 切入 → 尚未切入过', () => {
    expect(fiveHourWindowText(null).text).toBe('尚未切入过')
  })
  it('刚切入 → 剩 ~4h59m', () => {
    const now = Date.now()
    const r = fiveHourWindowText(now - MIN, now)
    expect(r.text).toMatch(/^约 4h/)
    expect(r.urgent).toBe(false)
  })
  it('距切入 4h → 还剩约 1h', () => {
    const now = Date.now()
    const r = fiveHourWindowText(now - 4 * HOUR, now)
    expect(r.text).toMatch(/^约 1h/)
  })
  it('距切入 4h30m → 还剩 30m，进入 urgent', () => {
    const now = Date.now()
    const r = fiveHourWindowText(now - (4 * HOUR + 30 * MIN), now)
    expect(r.text).toMatch(/^约 30m/)
    expect(r.urgent).toBe(true)
  })
  it('超过 5h → 本地计时已过（V1.6.2 改文案，避免误导真实窗口已重置）', () => {
    const now = Date.now()
    expect(fiveHourWindowText(now - 6 * HOUR, now).text).toBe('本地计时已过')
  })
})

describe('sevenDayWindowText', () => {
  it('刚切入 → 剩 6d 23h', () => {
    const now = Date.now()
    const r = sevenDayWindowText(now - MIN, now)
    expect(r.text).toMatch(/^约 6d 23h/)
  })
  it('距切入 3 天 → 剩 4 天', () => {
    const now = Date.now()
    const r = sevenDayWindowText(now - 3 * DAY, now)
    expect(r.text).toMatch(/^约 4d/)
  })
  it('超过 7 天 → 本地计时已过（V1.6.2 改文案）', () => {
    const now = Date.now()
    expect(sevenDayWindowText(now - 8 * DAY, now).text).toBe('本地计时已过')
  })
})

describe('lastSwitchText', () => {
  it('null → 从未使用', () => {
    expect(lastSwitchText(null)).toBe('从未使用')
  })
  it('< 1 分钟 → 刚刚', () => {
    const now = Date.now()
    expect(lastSwitchText(now - 30 * 1000, now)).toBe('刚刚')
  })
  it('5 分钟前', () => {
    const now = Date.now()
    expect(lastSwitchText(now - 5 * MIN, now)).toBe('5 分钟前')
  })
  it('今日几小时前 → 今天 HH:MM', () => {
    const now = new Date('2026-04-19T20:00:00').getTime()
    const earlier = new Date('2026-04-19T15:30:00').getTime()
    expect(lastSwitchText(earlier, now)).toBe('今天 15:30')
  })
  it('昨天 → 昨天 HH:MM', () => {
    const now = new Date('2026-04-19T10:00:00').getTime()
    const y = new Date('2026-04-18T14:30:00').getTime()
    expect(lastSwitchText(y, now)).toBe('昨天 14:30')
  })
  it('3 天前 → N 天前', () => {
    const now = new Date('2026-04-19T10:00:00').getTime()
    const x = new Date('2026-04-16T10:00:00').getTime()
    expect(lastSwitchText(x, now)).toBe('3 天前')
  })
  it('> 7 天 → MM-DD 日期', () => {
    const now = new Date('2026-04-19T10:00:00').getTime()
    const x = new Date('2026-03-10T10:00:00').getTime()
    expect(lastSwitchText(x, now)).toBe('03-10')
  })
})
