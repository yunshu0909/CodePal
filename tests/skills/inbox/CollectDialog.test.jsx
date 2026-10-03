/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：页面——要处理的详情与收进确认框
 *
 * 负责：
 * - TC-014：副本行文字照定稿；超过 4 个文件先列 4 个、点开列全部；同名都不在资产库时标这 N 份内容一样；
 *   资产库没有时启用卡只写在哪能用和装载状态、没有开关；确认框标题带工具和位置；不一样时两个选项文案带受影响工具、
 *   没选时收进灰；适配提醒、第一次收进新建资产库、收不了、内容刚变了（清空选择）、可重试失败（保留选择）；
 *   资产库已有的详情里占位原因与换成链接，点了打开这一份的确认框
 *
 * @module tests/skills/inbox/CollectDialog.test
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { resetToastForTests } from '../../../src/components/Toast'
import { baseSkills, copyRow, detail, dialog, inboxItems, managed, renderPage, select, snapshot } from './uiFixtures.jsx'

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

const clickIn = (node, text) => fireEvent.click(within(node).getByText(text, { exact: true }))
const openCollect = async (pathText) => {
  fireEvent.click(within(copyRow(pathText)).getByRole('button', { name: '收进' }))
  await waitFor(() => expect(dialog()).not.toBeNull())
  return dialog()
}

describe('要处理的详情', () => {
  it('TC-014 COLLECT_DIALOG 副本行文字、文件差异、展开全部、这 N 份内容一样、收进前的启用状态', async () => {
    await renderPage()
    await select('writing-assistant')
    const pane = detail()
    expect(pane.textContent).toContain('要处理 · 资产库里的版本不一样 · 2 份')
    const row = copyRow('/.claude/skills/writing-assistant')
    expect(row.textContent).toContain('Claude Code · my-blog 项目')
    expect(row.textContent).toContain('~/Documents/projects/my-blog/.claude/skills/writing-assistant')
    expect(row.textContent).toContain('和资产库不一样：少 3 个')
    const codexRow = copyRow('/.agents/skills/writing-assistant')
    const files = [...codexRow.querySelectorAll('.sk-f')].map((node) => node.textContent)
    expect(files[0], 'COLLECT_DIALOG SKILL.md 排第一').toContain('SKILL.md')

    await select('multi-perspective-analysis')
    const many = copyRow('/test/.claude/skills/multi-perspective-analysis')
    expect(many.textContent).toContain('还有 3 个文件')
    expect([...many.querySelectorAll('.sk-f:not(.sk-more)')].length).toBe(4)
    const firstTwo = [...many.querySelectorAll('.sk-f')].slice(0, 2).map((node) => node.textContent)
    expect(firstTwo[0]).toContain('SKILL.md')
    expect(firstTwo[1], 'COLLECT_DIALOG 脚本其次').toContain('scripts/run.py')
    fireEvent.click(within(many).getByText(/还有 3 个文件/))
    expect([...many.querySelectorAll('.sk-f:not(.sk-more)')].length, 'COLLECT_DIALOG 点开列全部').toBe(7)

    await select('dsh-code-review')
    expect(detail().textContent, 'COLLECT_DIALOG 同名都不在资产库时比较彼此').toContain('这 2 份内容一样')
    await select('liuyao-divination')
    const enable = detail()
    expect(enable.textContent).toContain('在notes-app 项目里能用；收进后可在这里开关')
    expect(enable.textContent).toContain('装载中')
    expect(within(enable).queryByRole('switch'), 'COLLECT_DIALOG 收进前没有开关').toBeNull()
  })
})

describe('收进确认框', () => {
  it('TC-014 COLLECT_DIALOG 标题带工具和位置；两个选项与受影响的工具；没选时收进灰；适配提醒', async () => {
    await renderPage()
    await select('writing-assistant')
    let box = await openCollect('/.agents/skills/writing-assistant')
    expect(box.textContent).toContain('收进 writing-assistant（Codex · my-blog 项目）？')
    expect(box.textContent).toContain('资产库里已经有一份内容不一样的，留哪一份？')
    expect(box.textContent).toContain('原件放进备份，Codex 改用资产库里的')
    expect(box.textContent, 'COLLECT_DIALOG 换成这一份要写受影响的工具').toContain('资产库里的被换掉；Claude Code 也会改用这一份')
    expect(box.textContent).toContain('这一份可能为 Codex 改过工具名或路径，两种选法都可能让某个工具用不了。拿不准就取消，原件留在项目里。')
    expect(box.textContent).toContain('在 Codex 里打开，之后 Codex 的所有项目都能用')
    expect(box.textContent).toContain('原件从 my-blog 项目移走，放进备份，能撤回')
    const confirm = within(box).getByRole('button', { name: '收进' })
    expect(confirm.disabled, 'COLLECT_DIALOG 没选时收进灰').toBe(true)
    clickIn(box, '留资产库里的')
    expect(within(box).getByRole('button', { name: '收进' }).disabled).toBe(false)
    clickIn(box, '取消')
    await waitFor(() => expect(dialog()).toBeNull())

    await select('github-repo-search')
    box = await openCollect('/my-blog/.claude/skills/github-repo-search')
    expect(box.textContent).toContain('资产库里已经有一样的，不再放一份')
    expect(within(box).getByRole('button', { name: '收进' }).disabled).toBe(false)
  })

  it('TC-014 COLLECT_DIALOG 第一次收进写明会新建资产库；收不了时写原因、收进灰', async () => {
    const items = inboxItems()
    items.find((item) => item.name === 'liuyao-divination').copies[0].blockedBy = { toolId: 'codex' }
    await renderPage({ snap: snapshot({ items, skills: baseSkills().filter((skill) => !skill.managed), central: { available: true, exists: false, skillCount: 0, displayPath: '~/Documents/SkillManager/' } }) })
    await select('dsh-code-review')
    let box = await openCollect('/cloned-repo/.claude/skills/dsh-code-review')
    expect(box.textContent, 'COLLECT_DIALOG 第一次收进新建资产库').toContain('第一次收进：会新建资产库 ~/Documents/SkillManager/')
    clickIn(box, '取消')
    await waitFor(() => expect(dialog()).toBeNull())
    await select('liuyao-divination')
    box = await openCollect('/notes-app/.codex/skills/liuyao-divination')
    expect(box.textContent, 'COLLECT_DIALOG 收不了').toContain('收不了：Codex 全局目录里已经有一份自己的 liuyao-divination，先处理那一份')
    expect(within(box).getByRole('button', { name: '收进' }).disabled).toBe(true)
  })

  it('TC-014 COLLECT_DIALOG 内容刚变了清空选择；可重试的失败保留选择并写原因', async () => {
    let calls = 0
    await renderPage({
      execute: async () => {
        calls += 1
        if (calls === 1) return { success: false, error: 'CONTENT_CHANGED', data: { outcome: 'not-run' }, snapshot: null }
        return { success: false, error: 'SOURCE_BUSY', data: { outcome: 'not-run' }, snapshot: null }
      },
    })
    await select('writing-assistant')
    const box = await openCollect('/.claude/skills/writing-assistant')
    clickIn(box, '换成这一份')
    await act(async () => { fireEvent.click(within(box).getByRole('button', { name: '收进' })) })
    await waitFor(() => expect(dialog().textContent).toContain('内容刚变了，上面已经按现在的样子更新，请重新选'))
    expect(within(dialog()).getByRole('button', { name: '收进' }).disabled, 'COLLECT_DIALOG 内容变了清空选择').toBe(true)
    clickIn(dialog(), '留资产库里的')
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '收进' })) })
    await waitFor(() => expect(dialog().textContent).toContain('没有收进：原件正被别的程序占用。选好的还在，可以再试一次'))
    expect(within(dialog()).getByRole('button', { name: '收进' }).disabled, 'COLLECT_DIALOG 可重试失败保留选择').toBe(false)
  })
})

describe('资产库已有的详情：占位原因与换成链接', () => {
  it('TC-014 COLLECT_DIALOG 占位原因写在开关下面，一样的独立文件夹给换成链接，点了打开确认框', async () => {
    const skills = baseSkills().map((skill) => (skill.name === 'logo-design'
      ? managed('logo-design', '设计、诊断和迭代产品或品牌 Logo', {
        gate: {
          codex: {
            why: 'same',
            sourceId: 'src_logosame',
            copy: { sourceId: 'src_logosame', toolId: 'codex', scope: 'global', projectName: null, displayPath: '~/.agents/skills/logo-design', relation: 'same', digest: 'd_logo', diff: { added: [], removed: [], changed: [] }, adaptedHint: false, isLink: false, blockedBy: null },
          },
        },
      })
      : skill))
    await renderPage({ snap: snapshot({ skills }) })
    await select('logo-design')
    const pane = detail()
    expect(pane.textContent).toContain('Codex 全局目录里是一份和资产库一样的独立文件夹；换成资产库的链接后才能在这里开关')
    const codexRow = [...pane.querySelectorAll('.np-row')].find((row) => row.textContent.includes('Codex 全局目录里是一份'))
    expect(within(codexRow).getByRole('switch').getAttribute('aria-disabled') === 'true' || within(codexRow).getByRole('switch').disabled).toBe(true)
    fireEvent.click(within(codexRow).getByRole('button', { name: '换成链接' }))
    await waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog().textContent).toContain('收进 logo-design（Codex · 全局目录）？')
    expect(dialog().textContent).toContain('资产库里已经有一样的，不再放一份')
    expect(dialog().textContent).toContain('原件换成指向资产库的链接，旧内容放进备份，能撤回')

    const ignoredSkills = skills.map((skill) => (skill.name === 'logo-design' ? { ...skill, gate: { codex: { why: 'ignored' } } } : skill))
    cleanup()
    await renderPage({ snap: snapshot({ skills: ignoredSkills }) })
    await select('logo-design')
    expect(detail().textContent).toContain('Codex 用的是全局目录里自己那份（已忽略）；要改用资产库的，先到「已忽略」取消，再收进')
  })
})
