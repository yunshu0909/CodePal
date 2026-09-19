/**
 * 对话回顾视图推导测试
 *
 * 负责：
 * - AC-20 分组与时间写法；AC-21 项目色与项目菜单；AC-22 筛选；AC-23 消息分组
 *
 * @module tests/sessions/sessionView.test
 */

import { describe, expect, it } from 'vitest'
import {
  dayGroup, formatRowTime, formatWhen, formatDateTime, groupSessions, projectColor, iconColor,
  buildProjectMenu, filterSessions, groupMessages, displayTitle, resumeCommand,
} from '../../src/pages/sessions/sessionView'

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0).getTime()
const NOW = at(2026, 9, 19, 15, 20) // 周六

describe('分组与时间写法', () => {
  it('TC-20 今天 / 昨天 / 前 7 天 / 更早 的边界', () => {
    expect(dayGroup(at(2026, 9, 19, 0, 0), NOW)).toBe('今天')
    expect(dayGroup(at(2026, 9, 18, 23, 59), NOW)).toBe('昨天')
    expect(dayGroup(at(2026, 9, 17, 12), NOW)).toBe('前 7 天')
    expect(dayGroup(at(2026, 9, 12, 0, 1), NOW)).toBe('前 7 天')
    expect(dayGroup(at(2026, 9, 11, 23, 59), NOW)).toBe('更早')
  })

  it('TC-20 行尾时间：今天、昨天写时分；前 7 天写星期；更早写日期；跨年带年', () => {
    expect(formatRowTime(at(2026, 9, 19, 9, 5), NOW)).toBe('09:05')
    expect(formatRowTime(at(2026, 9, 18, 22, 41), NOW)).toBe('22:41')
    expect(formatRowTime(at(2026, 9, 16, 10), NOW)).toBe('周三')
    expect(formatRowTime(at(2026, 9, 14, 10), NOW)).toBe('周一')
    expect(formatRowTime(at(2026, 9, 2, 20), NOW)).toBe('9月2日')
    expect(formatRowTime(at(2025, 12, 30, 20), NOW)).toBe('2025年12月30日')
  })

  it('TC-20 对话页元信息写法', () => {
    expect(formatWhen(at(2026, 9, 19, 14, 36), NOW)).toBe('今天 14:36')
    expect(formatWhen(at(2026, 9, 18, 22, 41), NOW)).toBe('昨天 22:41')
    expect(formatWhen(at(2026, 9, 16, 10, 2), NOW)).toBe('9月16日 10:02')
    expect(formatWhen(at(2025, 12, 30, 8, 0), NOW)).toBe('2025年12月30日 08:00')
  })

  it('TC-20 消息流开头的日期行写绝对日期（code 门 F-03，照定稿 A9）', () => {
    expect(formatDateTime(at(2026, 9, 19, 10, 12), NOW)).toBe('9月19日 10:12')
    expect(formatDateTime(at(2025, 12, 30, 8, 0), NOW)).toBe('2025年12月30日 08:00')
  })

  it('TC-20 分组保持倒序、只出现有内容的组', () => {
    const s = (id, t) => ({ sessionId: id, modifiedAt: new Date(t).toISOString() })
    const groups = groupSessions([s('a', at(2026, 9, 19, 14)), s('b', at(2026, 9, 19, 9)), s('c', at(2026, 9, 2))], NOW)
    expect(groups.map((g) => [g.label, g.items.map((i) => i.sessionId)])).toEqual([['今天', ['a', 'b']], ['更早', ['c']]])
  })
})

describe('项目', () => {
  it('TC-21 项目色确定、在 6 色内（不用红）；自动调用一律灰', () => {
    const palette = ['blue', 'purple', 'orange', 'teal', 'brown', 'green']
    expect(palette).toContain(projectColor('skills'))
    expect(projectColor('skills')).toBe(projectColor('skills'))
    const colors = new Set(['skills', 'skill-manager', 'diaodu', 'agent-demo', 'dev-workflow-plugin', 'test', 'a', 'b'].map(projectColor))
    expect(colors.size).toBeGreaterThan(2)
    expect(iconColor({ projectName: 'skills', auto: true })).toBe('gray')
    expect(iconColor({ projectName: 'skills', auto: false })).toBe(projectColor('skills'))
  })

  it('TC-21 项目菜单只含手动对话的项目，带计数与上级目录，按最近活动排', () => {
    const s = (path, name, parent, t, auto = false) => ({ projectPath: path, projectName: name, parentDir: parent, modifiedAt: new Date(t).toISOString(), auto })
    const menu = buildProjectMenu([
      s('/p/skills', 'skills', '~/p', at(2026, 9, 18)),
      s('/q/diaodu', 'diaodu', '~/q', at(2026, 9, 19)),
      s('/p/skills', 'skills', '~/p', at(2026, 9, 10)),
      s('/tmp/evidence', 'evidence', '/tmp', at(2026, 9, 19, 12), true),
    ])
    expect(menu).toEqual([
      { projectPath: '/q/diaodu', projectName: 'diaodu', parentDir: '~/q', count: 1 },
      { projectPath: '/p/skills', projectName: 'skills', parentDir: '~/p', count: 2 },
    ])
  })

  it('TC-22 按项目、按是否含自动调用过滤', () => {
    const items = [
      { sessionId: '1', projectPath: '/p/a', auto: false },
      { sessionId: '2', projectPath: '/p/a', auto: true },
      { sessionId: '3', projectPath: '/p/b', auto: false },
    ]
    const ids = (o) => filterSessions(items, o).map((i) => i.sessionId)
    expect(ids({ projectPath: null, includeAuto: false })).toEqual(['1', '3'])
    expect(ids({ projectPath: null, includeAuto: true })).toEqual(['1', '2', '3'])
    expect(ids({ projectPath: '/p/a', includeAuto: true })).toEqual(['1', '2'])
  })

  it('标题回退与 resume 命令', () => {
    expect(displayTitle({ title: null })).toBe('（无标题）')
    expect(displayTitle({ title: '有' })).toBe('有')
    expect(resumeCommand('/a b/c', 'id-1')).toBe('cd "/a b/c" && claude --resume id-1')
  })
})

describe('消息分组', () => {
  it('TC-23 工具调用合块放在下一段文字前；有文字的回答单独成块；compact 单独成块', () => {
    const tu = (n) => Array.from({ length: n }, (_, i) => ({ name: 'Read', target: `f${i}` }))
    const blocks = groupMessages([
      { offset: 1, kind: 'ask', text: '问' },
      { offset: 2, kind: 'answer', text: '', toolUses: tu(2) },
      { offset: 3, kind: 'answer', text: '', toolUses: tu(3) },
      { offset: 4, kind: 'answer', text: '答', toolUses: tu(1) },
      { offset: 5, kind: 'compact' },
      { offset: 6, kind: 'ask', text: '再问' },
    ])
    expect(blocks.map((b) => b.type)).toEqual(['ask', 'tools', 'answer', 'tools', 'compact', 'ask'])
    expect(blocks[1].toolUses).toHaveLength(5)
    expect(blocks[3].toolUses).toHaveLength(1)
    expect(blocks[2].message.text).toBe('答')
  })

  it('TC-23 结尾的工具调用也要成块', () => {
    const blocks = groupMessages([{ offset: 1, kind: 'ask', text: '问' }, { offset: 2, kind: 'answer', text: '', toolUses: [{ name: 'Bash', target: 'ls' }] }])
    expect(blocks.map((b) => b.type)).toEqual(['ask', 'tools'])
  })
})
