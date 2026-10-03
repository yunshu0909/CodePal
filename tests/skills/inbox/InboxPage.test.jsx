/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：页面——要处理组与总览
 *
 * 负责：
 * - TC-013：左栏「要处理」组排在在用前，行尾按关系；没有要处理时不出这组；总览第三块四行按条件出现、
 *   按份计数；工具卡多「不在资产库」一行且三行相加等于总数；资产库不存在时左栏写资产库还没有 Skill；
 *   外部组、全部收进资产库、栏头收进资产库都不出现；点 N 个 Skill 要处理选中第一个
 * electronAPI 全是假的，照定稿包画面造快照。
 *
 * @module tests/skills/inbox/InboxPage.test
 */

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { resetToastForTests } from '../../../src/components/Toast'
import { baseSkills, detail, groupTitles, inboxItems, listItem, renderPage, snapshot } from './uiFixtures.jsx'

vi.mock('../../../src/store/skillRepoPath', () => ({
  skillRepoPath: {
    getRepoPath: vi.fn(async () => '/Users/me/Documents/SkillManager'),
    getCachedRepoPath: vi.fn(() => null),
  },
}))

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-03T21:40:00+08:00'))
})
afterAll(() => { vi.useRealTimers() })
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  cleanup()
  resetToastForTests()
})

const rowLabel = (pane, text) => within(pane).getAllByText(text, { exact: true }).map((node) => node.closest('.np-row')).find(Boolean)

describe('要处理组与总览', () => {
  it('TC-013 INBOX_PAGE 左栏要处理组排第一，行尾按关系；没有外部组和旧收进按钮', async () => {
    const { container } = await renderPage({
      snap: snapshot({ operations: [{ operationId: 'op1', name: 'page-solution-design', kind: 'collect', from: { toolId: 'claude-code', scope: 'project', projectName: 'p', displayPath: '~/p/.claude/skills/page-solution-design' }, at: '2026-10-03T13:10:00.000Z', state: 'undoable' }], ignored: [{ ignoreId: 'ig1', name: 'security-triage', toolId: 'codex', scope: 'project', projectName: 'side-project', displayPath: '~/Documents/side-project/.agents/skills/security-triage', stillLoaded: false }] }),
    })
    // v2.1.11 左栏页签（用户 10-03 定）：要处理是第一个页签，有要处理时先停在它
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0].textContent, 'INBOX_PAGE 要处理页签排第一').toMatch(/^要处理\s*5$/)
    expect(tabs[0].getAttribute('aria-selected'), 'INBOX_PAGE 先停在要处理').toBe('true')
    expect(groupTitles(container).some((title) => title.startsWith('外部')), 'INBOX_PAGE 外部组下线').toBe(false)
    expect(listItem('writing-assistant').textContent).toContain('不一样')
    expect(listItem('writing-assistant').textContent).toContain('my-blog · 2 份')
    expect(listItem('github-repo-search').textContent).toContain('资产库已有')
    expect(listItem('liuyao-divination').textContent).toContain('资产库没有')
    expect(listItem('liuyao-divination').textContent).not.toMatch(/份/)
    expect(screen.queryByText('全部收进资产库')).toBeNull()
    expect(screen.queryByText('收进资产库')).toBeNull()

    const pane = detail()
    expect(within(pane).getByText('5 个 Skill 要处理')).toBeTruthy()
    expect(within(pane).getByText('7 份，在全局目录和 3 个项目里；左栏「要处理」逐个看')).toBeTruthy()
    expect(within(pane).getByText('从 3 个项目里找到')).toBeTruthy()
    expect(within(pane).getByText('看了你用 Claude Code、Codex 打开过的 9 个目录')).toBeTruthy()
    expect(within(pane).getByText('收进记录 1 次')).toBeTruthy()
    expect(within(pane).getByText('收进过的都在这里，可以撤回')).toBeTruthy()
    expect(within(pane).getByText('已忽略 1 份')).toBeTruthy()
    expect(within(pane).getByText('不再出现在要处理里，点开可以取消忽略')).toBeTruthy()
  })

  it('TC-013 INBOX_PAGE 工具卡多一行不在资产库，三行相加等于总数', async () => {
    await renderPage()
    const pane = detail()
    const claudeCard = [...pane.querySelectorAll('.sk-tool-card')].find((card) => card.textContent.includes('Claude Code'))
    const row = rowLabel(claudeCard, '不在资产库')
    expect(row, 'INBOX_PAGE 工具卡要有不在资产库一行').toBeTruthy()
    expect(row.textContent).toContain('在「要处理」或「已忽略」里，收进后在这页开关')
    const values = [...claudeCard.querySelectorAll('.sk-rows .sk-n')].map((node) => Number(node.textContent))
    const total = Number(claudeCard.querySelector('.sk-count').textContent)
    expect(values.reduce((sum, value) => sum + value, 0), 'INBOX_PAGE 三行相加等于总数').toBe(total)
  })

  it('TC-013 INBOX_PAGE 没有要处理时不出这组，总览第三块叫找到的项目', async () => {
    const { container } = await renderPage({ snap: snapshot({ items: [] }) })
    expect(groupTitles(container).some((title) => title.startsWith('要处理'))).toBe(false)
    const pane = detail()
    expect(within(pane).getByText('找到的项目', { selector: '.np-glabel, .np-glabel *' })).toBeTruthy()
    expect(within(pane).queryByText(/个 Skill 要处理/)).toBeNull()
    expect(within(pane).getByText('从 3 个项目里找到')).toBeTruthy()
    expect(within(pane).queryByText(/已忽略/)).toBeNull()
  })

  it('TC-013 INBOX_PAGE 资产库还不存在：左栏写资产库还没有 Skill，要处理照常', async () => {
    const skills = baseSkills().filter((skill) => !skill.managed)
    const { container } = await renderPage({
      snap: snapshot({ skills, items: inboxItems().filter((item) => item.relation === 'none'), central: { available: true, exists: false, skillCount: 0, displayPath: '~/Documents/SkillManager/' } }),
    })
    expect(container.querySelector('.np-pane--list').textContent).toContain('资产库还没有 Skill')
    // 只剩要处理一组：页签整排不出，直接列这 2 个
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(container.querySelectorAll('.np-pane--list [data-id^="inbox:"]')).toHaveLength(2)
  })

  it('TC-013 INBOX_PAGE 点 N 个 Skill 要处理选中第一个', async () => {
    await renderPage()
    fireEvent.click(within(detail()).getByText('5 个 Skill 要处理'))
    expect(await screen.findByRole('heading', { level: 2, name: 'writing-assistant' })).toBeTruthy()
    expect(listItem('writing-assistant').getAttribute('aria-selected')).toBe('true')
  })
})
