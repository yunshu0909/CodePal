/**
 * Skills 左栏页签（specs/v2.1.11-Skills要处理-实现；2026-10-03 用户试用后定：顶部页签，选第 4 版下划线页签）
 *
 * 负责：
 * - TC-044：栏头从上到下是搜索 → 一行装载总览 → 页签；页签写名字和条数；有要处理先停在要处理，列表只列这一组
 * - TC-045：切页签只换左栏、右栏不动；只读组跟在最后一个页签末尾、带小标题；键盘左右键切换
 * - TC-046：为 0 的页签不出；只剩一个时整排不出
 * - TC-047：选中项跟随：总览点「N 个要处理」跳回要处理；收进后跟到资产库那一条所在的页签；后台重新读取不动用户点的页签
 * - TC-048：搜索：三组一起列、带组标题，页签变淡写搜到几个；清掉回原页签；搜索里点过一条，清掉后跟到它所在的页签
 * - TC-049：要处理清空后这个页签消失，停到在用
 * - TC-050：TabBar 组件：页签角色、选中、数字、左右键、变淡不能点
 * - TC-051：次数没读到时页签那一行是骨架，列表照常列出（有要处理列要处理，没有列资产库）
 *
 * @module tests/skills/inbox/leftTabs.test
 */

import React, { useState } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { resetToastForTests } from '../../../src/components/Toast'
import TabBar from '../../../src/components/TabBar/TabBar'
import { baseSkills, copyRow, detail, dialog, inboxItems, makeApi, managed, renderPage, select, snapshot } from './uiFixtures.jsx'

vi.mock('../../../src/store/skillRepoPath', () => ({
  skillRepoPath: {
    getRepoPath: vi.fn(async () => '/Users/me/Documents/SkillManager'),
    getCachedRepoPath: vi.fn(() => null),
  },
}))

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-03T21:45:00+08:00'))
})
afterAll(() => { vi.useRealTimers() })
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  cleanup()
  resetToastForTests()
  document.querySelectorAll('.confirm-dialog-host').forEach((node) => node.remove())
})

const pane = () => document.querySelector('.np-pane--list')
const tabTexts = () => screen.queryAllByRole('tab').map((tab) => tab.textContent)
const currentTab = () => screen.queryAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent
const tab = (label) => screen.getAllByRole('tab').find((node) => node.textContent.startsWith(label))
const bodyIds = () => [...pane().querySelectorAll('.np-pane-body [role="option"]')].map((node) => node.getAttribute('data-id'))
const headers = () => [...pane().querySelectorAll('.np-pane-body .np-lg')].map((node) => node.textContent)
const respond = (snap, data = {}) => ({ success: true, data: { outcome: 'done', snapshot: snap, ...data }, snapshot: snap, error: null })
const withoutInbox = (name) => inboxItems().filter((item) => item.name !== name)

describe('栏头与页签', () => {
  it('TC-044 TABS_LAYOUT 搜索 → 一行装载总览 → 页签；有要处理先停在要处理，列表只列这一组', async () => {
    await renderPage()
    const head = pane().querySelector('.np-pane-hd')
    const order = [...head.querySelectorAll('input, [role="option"], [role="tablist"]')].map((node) => node.getAttribute('role') || node.tagName.toLowerCase())
    expect(order, 'TABS_LAYOUT 栏头顺序').toEqual(['input', 'option', 'tablist'])
    const overview = head.querySelector('[role="option"]')
    expect(overview.textContent, 'TABS_LAYOUT 装载总览一行写两个工具的数').toMatch(/^装载总览Claude\s*12·Codex\s*7$/)
    expect(overview.getAttribute('aria-selected')).toBe('true')
    expect(tabTexts(), 'TABS_LAYOUT 页签写名字和条数').toEqual(['要处理5', '在用1', '没用4'])
    expect(currentTab(), 'TABS_LAYOUT 有要处理先停在要处理').toBe('要处理5')
    expect(bodyIds().every((id) => id.startsWith('inbox:')), 'TABS_LAYOUT 列表只列要处理').toBe(true)
    expect(bodyIds()).toHaveLength(5)
    expect(headers(), 'TABS_LAYOUT 页签已说明是哪组，不再出组标题').toEqual([])
  })

  it('TC-045 TABS_SWITCH 切页签只换左栏；只读跟在最后一个页签末尾带小标题；左右键切换', async () => {
    await renderPage()
    fireEvent.click(tab('在用'))
    expect(currentTab()).toBe('在用1')
    expect(bodyIds()).toEqual(['page-solution-design'])
    expect(within(detail()).getByRole('heading', { level: 2, name: '装载总览' }), 'TABS_SWITCH 右栏不动').toBeTruthy()
    fireEvent.click(tab('没用'))
    expect(bodyIds().slice(0, 4).sort()).toEqual(['github-repo-search', 'logo-design', 'multi-perspective-analysis', 'writing-assistant'])
    expect(headers().map((text) => text.replace(/\s*\d+$/, '')), 'TABS_SWITCH 只读带小标题').toEqual(['只读 · 同步来的和系统自带的'])
    expect(bodyIds().slice(-1)).toEqual(['pptx'])
    fireEvent.keyDown(tab('没用'), { key: 'ArrowRight' })
    expect(currentTab(), 'TABS_SWITCH 右键从最后一个绕回第一个').toBe('要处理5')
    fireEvent.keyDown(tab('要处理'), { key: 'ArrowLeft' })
    expect(currentTab()).toBe('没用4')
  })

  it('TC-046 TABS_ZERO_HIDDEN 为 0 的页签不出；只剩一组整排不出', async () => {
    await renderPage({ snap: snapshot({ items: [] }) })
    expect(tabTexts(), 'TABS_ZERO_HIDDEN 没有要处理就不出这个页签').toEqual(['在用1', '没用4'])
    expect(currentTab()).toBe('在用1')
    cleanup()
    const unusedOnly = baseSkills().filter((skill) => skill.name !== 'page-solution-design')
    await renderPage({ snap: snapshot({ items: [], skills: unusedOnly }) })
    expect(screen.queryAllByRole('tablist'), 'TABS_ZERO_HIDDEN 只剩没用一组：整排不出').toHaveLength(0)
    expect(bodyIds().length).toBeGreaterThan(0)
  })
})

describe('选中跟随', () => {
  it('TC-047 TABS_FOLLOW 总览点要处理跳回要处理；收进后跟到资产库那条；重新读取不动用户点的页签', async () => {
    const collected = snapshot({
      items: withoutInbox('liuyao-divination'),
      skills: [...baseSkills(), managed('liuyao-divination', '六爻复盘与交叉校验')],
    })
    const api = makeApi({ execute: async () => respond(collected, { operationId: 'op_ly' }) })
    await renderPage({ api })
    fireEvent.click(tab('在用'))
    fireEvent.click(within(detail()).getByText('5 个 Skill 要处理'))
    expect(await screen.findByRole('heading', { level: 2, name: 'writing-assistant' })).toBeTruthy()
    expect(currentTab(), 'TABS_FOLLOW 从在用跳回要处理').toBe('要处理5')

    await select('liuyao-divination')
    fireEvent.click(within(copyRow('/.codex/skills/liuyao-divination')).getByRole('button', { name: '收进' }))
    await waitFor(() => expect(dialog()).not.toBeNull())
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '收进' })) })
    await waitFor(() => expect(currentTab(), 'TABS_FOLLOW 收进后跟到没用').toBe('没用5'))
    const row = pane().querySelector('[data-id="liuyao-divination"]')
    expect(row, 'TABS_FOLLOW 刚收进的那条看得见').not.toBeNull()
    expect(row.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(pane().querySelector('[data-id="__overview"]'))
    fireEvent.click(tab('在用'))
    api.getSkillControlSnapshot.mockResolvedValue({ success: true, data: collected, error: null })
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: '重新读取' })) })
    await waitFor(() => expect(api.getSkillControlSnapshot.mock.calls.length).toBeGreaterThan(1))
    expect(currentTab(), 'TABS_FOLLOW 重新读取不把用户点的页签拉走').toBe('在用1')
  })
})

describe('搜索与清空', () => {
  it('TC-048 TABS_SEARCH 三组一起列带组标题，页签变淡写搜到几个；清掉回原页签；搜索里点过一条，清掉后跟到它的页签', async () => {
    await renderPage()
    fireEvent.click(tab('在用'))
    const input = screen.getByPlaceholderText('搜索名称和用途')
    fireEvent.change(input, { target: { value: 'design' } })
    await waitFor(() => expect(screen.getAllByRole('tab').every((node) => node.disabled)).toBe(true))
    expect(tabTexts(), 'TABS_SEARCH 页签不增减、数字换成搜到几个').toEqual(['要处理0', '在用1', '没用1'])
    expect(headers().map((text) => text.replace(/\s*\d+$/, '')), 'TABS_SEARCH 三组一起列带组标题').toEqual(['在用 · 近 30 天', '近 30 天没用'])
    expect(bodyIds()).toEqual(['page-solution-design', 'logo-design'])
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(currentTab(), 'TABS_SEARCH 清掉回原页签').toBe('在用1'))

    fireEvent.change(input, { target: { value: 'logo' } })
    await waitFor(() => expect(bodyIds()).toEqual(['logo-design']))
    fireEvent.click(pane().querySelector('[data-id="logo-design"]'))
    await screen.findByRole('heading', { level: 2, name: 'logo-design' })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(currentTab(), 'TABS_SEARCH 跟到选中那条的页签').toBe('没用4'))
    expect(pane().querySelector('[data-id="logo-design"]').getAttribute('aria-selected')).toBe('true')
  })

  it('TC-049 TABS_INBOX_CLEARED 要处理清空后这个页签消失，停到在用', async () => {
    const one = inboxItems().filter((item) => item.name === 'liuyao-divination')
    const cleared = snapshot({ items: [], ignored: [{ ignoreId: 'ig1', name: 'liuyao-divination', toolId: 'codex', scope: 'project', projectName: 'notes-app', displayPath: '~/x', stillLoaded: false }] })
    await renderPage({ snap: snapshot({ items: one }), execute: async () => respond(cleared) })
    expect(currentTab()).toBe('要处理1')
    await select('liuyao-divination')
    await act(async () => { fireEvent.click(within(copyRow('/.codex/skills/liuyao-divination')).getByRole('button', { name: '忽略' })) })
    await waitFor(() => expect(tabTexts(), 'TABS_INBOX_CLEARED 要处理页签消失').toEqual(['在用1', '没用4']))
    expect(currentTab(), 'TABS_INBOX_CLEARED 停到在用').toBe('在用1')
  })
})

describe('组件与读取中', () => {
  it('TC-050 TABBAR 页签角色、选中、数字、左右键、变淡不能点', () => {
    const onChange = vi.fn()
    function Harness({ disabled = false }) {
      const [value, setValue] = useState('a')
      return <TabBar ariaLabel="分组" value={value} disabled={disabled} onChange={(next) => { onChange(next); setValue(next) }} options={[{ value: 'a', label: '甲', count: 3 }, { value: 'b', label: '乙', count: 0 }]} />
    }
    const view = render(<Harness />)
    expect(screen.getByRole('tablist', { name: '分组' })).toBeTruthy()
    const [a, b] = screen.getAllByRole('tab')
    expect(a.textContent).toBe('甲3')
    expect(a.getAttribute('aria-selected')).toBe('true')
    expect(b.getAttribute('tabindex')).toBe('-1')
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('b')
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true')
    view.unmount()
    render(<Harness disabled />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.every((node) => node.disabled), 'TABBAR 变淡不能点').toBe(true)
  })

  it('TC-051 TABS_USAGE_PENDING 次数没读到：页签那一行是骨架，列表照常列出', async () => {
    const api = makeApi()
    api.aggregateSkillUsage = vi.fn(() => new Promise(() => {}))
    await renderPage({ api })
    expect(screen.queryAllByRole('tablist'), 'TABS_USAGE_PENDING 页签先不出').toHaveLength(0)
    expect(pane().querySelector('.sk-tabs-sk .np-sk'), 'TABS_USAGE_PENDING 页签那一行是骨架').not.toBeNull()
    expect(bodyIds().every((id) => id.startsWith('inbox:')) && bodyIds().length === 5, 'TABS_USAGE_PENDING 有要处理先列要处理').toBe(true)
    cleanup()
    const api2 = makeApi({ snap: snapshot({ items: [] }) })
    api2.aggregateSkillUsage = vi.fn(() => new Promise(() => {}))
    await renderPage({ api: api2 })
    expect(pane().querySelector('.np-pane-body .np-sk'), 'TABS_USAGE_PENDING 列表不出骨架').toBeNull()
    expect(bodyIds(), 'TABS_USAGE_PENDING 没有要处理就先列资产库').toEqual(expect.arrayContaining(['page-solution-design', 'logo-design']))
  })
})
