/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：页面——结果、撤回与三个视图
 *
 * 负责：
 * - TC-015：五种 outcome 的 Toast 照定稿；还有剩下的份时选中留在这个名字、全部处理完跟着去用法组并出下一个要处理；
 *   忽略一份与忽略完一个名字的 Toast 和自动选下一个；最近收进卡的样子（可撤、撤不了带原因、没做完带继续恢复、撤回中），
 *   没做完时这个 Skill 的开关和收进忽略都灰；连带别的工具先弹确认；收进记录视图六种状态与计数；
 *   已忽略视图与三种取消结果；找到的项目视图；离开 Skills 页再进来最近收进卡和收进记录照样出现
 *
 * @module tests/skills/inbox/InboxFlows.test
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { resetToastForTests } from '../../../src/components/Toast'
import { copyRow, detail, dialog, inboxItems, listItem, makeApi, renderPage, select, snapshot, toastText } from './uiFixtures.jsx'

process.env.TZ = 'Asia/Shanghai'

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

const op = (fields) => ({
  operationId: `op_${fields.name}_${fields.state}`,
  kind: 'collect',
  from: { toolId: 'claude-code', scope: 'project', projectName: 'my-blog', displayPath: `~/Documents/projects/my-blog/.claude/skills/${fields.name}` },
  at: '2026-10-03T13:40:00.000Z',
  ...fields,
})
const without = (items, name) => items.filter((item) => item.name !== name)
const respond = (snap, data = {}) => ({ success: true, data: { outcome: 'done', snapshot: snap, ...data }, snapshot: snap, error: null })
const fail = (error, outcome, snap = null) => ({ success: false, error, data: { outcome }, snapshot: snap })

async function collectFirstCopy(pathText, pick) {
  fireEvent.click(within(copyRow(pathText)).getByRole('button', { name: '收进' }))
  await waitFor(() => expect(dialog()).not.toBeNull())
  if (pick) fireEvent.click(within(dialog()).getByText(pick, { exact: true }))
  await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '收进' })) })
}

describe('收进的结果与选中', () => {
  it('TC-015 INBOX_FLOWS 还有剩下的份时留在这个名字；全部处理完跟着去用法组并出下一个要处理', async () => {
    const remaining = inboxItems().map((item) => (item.name === 'writing-assistant' ? { ...item, copies: [item.copies[1]] } : item))
    const afterFirst = snapshot({ items: remaining, operations: [op({ name: 'writing-assistant', state: 'undoable' })] })
    const afterAll = snapshot({ items: without(inboxItems(), 'writing-assistant'), operations: [op({ name: 'writing-assistant', state: 'undoable', at: '2026-10-03T13:42:00.000Z', from: { toolId: 'codex', scope: 'project', projectName: 'my-blog' } })] })
    let call = 0
    await renderPage({ execute: async () => { call += 1; return respond(call === 1 ? afterFirst : afterAll, { operationId: 'op1' }) } })
    await select('writing-assistant')
    await collectFirstCopy('/.claude/skills/writing-assistant', '留资产库里的')
    await toastText('已从 Claude Code 收进资产库：writing-assistant')
    expect(screen.getByRole('heading', { level: 2, name: 'writing-assistant' })).toBeTruthy()
    expect(detail().textContent, 'INBOX_FLOWS 还有剩下的份留在这个名字').toContain('要处理的副本')
    expect(detail().textContent).toContain('最近收进')
    expect(detail().textContent).toContain('从 Claude Code · my-blog 项目 收进 · 21:40；原件在备份里；已开着的会话重开后才用上新版本')

    await collectFirstCopy('/.agents/skills/writing-assistant', '留资产库里的')
    await toastText('已从 Codex 收进资产库：writing-assistant')
    await waitFor(() => expect(listItem('writing-assistant').closest('[role="listbox"]').querySelector('.np-li.on').textContent).toContain('writing-assistant'))
    expect(detail().textContent, 'INBOX_FLOWS 全部处理完跟着去用法组').not.toContain('要处理的副本')
    fireEvent.click(within(detail()).getByRole('button', { name: '下一个要处理' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'multi-perspective-analysis' })).toBeTruthy()
  })

  it('TC-015 INBOX_FLOWS 收进的另外三种结果各自的提示', async () => {
    const results = [
      [respond(null, { outcome: 'done-unverified', operationId: 'opx' }), '已收进，但状态没读出来，请点「重新读取」'],
      [fail('INJECTED', 'rolled-back'), '收进失败，已恢复原样'],
      [fail('INJECTED', 'partial'), '收进没做完，也没能全部恢复；请点「继续恢复」'],
    ]
    for (const [result, text] of results) {
      await renderPage({ execute: async () => result })
      await select('liuyao-divination')
      await collectFirstCopy('/.codex/skills/liuyao-divination')
      await toastText(text)
      await waitFor(() => expect(dialog()).toBeNull())
      cleanup()
      resetToastForTests()
    }
  })
})

describe('忽略', () => {
  it('TC-015 INBOX_FLOWS 忽略一份、忽略完一个名字后自动选下一个', async () => {
    const one = inboxItems().map((item) => (item.name === 'dsh-code-review' ? { ...item, copies: [item.copies[1]], peers: null } : item))
    const done = without(inboxItems(), 'dsh-code-review')
    let call = 0
    await renderPage({ execute: async () => { call += 1; return respond(snapshot({ items: call === 1 ? one : done })) } })
    await select('dsh-code-review')
    await act(async () => { fireEvent.click(within(copyRow('/.claude/skills/dsh-code-review')).getByRole('button', { name: '忽略' })) })
    await toastText('已忽略 1 份')
    expect(screen.getByRole('heading', { level: 2, name: 'dsh-code-review' })).toBeTruthy()
    await act(async () => { fireEvent.click(within(copyRow('/.agents/skills/dsh-code-review')).getByRole('button', { name: '忽略' })) })
    await toastText('已忽略 dsh-code-review')
    expect(await screen.findByRole('heading', { level: 2, name: 'liuyao-divination' }), 'INBOX_FLOWS 忽略完自动选下一个').toBeTruthy()
  })
})

describe('最近收进卡与撤回', () => {
  it('TC-015 INBOX_FLOWS 撤不了带原因；没做完带继续恢复且这个 Skill 的操作都灰；撤回中', async () => {
    let release
    const pending = new Promise((resolve) => { release = resolve })
    const snap = snapshot({
      operations: [
        op({ name: 'page-solution-design', state: 'blocked', reason: 'library-changed' }),
        op({ name: 'github-repo-search', state: 'partial', partialKind: 'collect' }),
        op({ name: 'writing-assistant', state: 'undoable' }),
      ],
    })
    await renderPage({ snap, execute: async () => { await pending; return respond(snap) } })
    await select('page-solution-design')
    expect(detail().textContent).toContain('现在撤不了：资产库里这份后来改过')
    expect(within(detail()).getByRole('button', { name: '撤回' }).disabled).toBe(true)

    await select('github-repo-search')
    expect(detail().textContent).toContain('上次收进没做完')
    expect(detail().textContent).toContain('恢复好之前这个 Skill 的其他操作都先停着')
    expect(within(detail()).getByRole('button', { name: '继续恢复' })).toBeTruthy()
    const row = copyRow('/my-blog/.claude/skills/github-repo-search')
    expect(within(row).getByRole('button', { name: '收进' }).disabled, 'INBOX_FLOWS 没做完时收进灰').toBe(true)
    expect(within(row).getByRole('button', { name: '忽略' }).disabled).toBe(true)
    for (const toggle of within(detail()).queryAllByRole('switch')) expect(toggle.getAttribute('aria-disabled')).toBe('true')

    await select('writing-assistant')
    fireEvent.click(within(detail()).getByRole('button', { name: '撤回' }))
    await waitFor(() => expect(within(detail()).getByRole('button', { name: '撤回中…' }).disabled).toBe(true))
    await act(async () => { release() })
  })

  it('TC-015 INBOX_FLOWS 撤回连带别的工具先确认；确认后带 confirmed 再撤；成功提示', async () => {
    const snap = snapshot({ operations: [op({ name: 'page-solution-design', state: 'undoable' })] })
    const api = makeApi({
      snap,
      execute: async (params) => (params.confirmed
        ? respond(snap)
        : { success: true, data: { outcome: 'needs-confirm', needsConfirm: { toolIds: ['codex'] }, snapshot: snap }, snapshot: snap, error: null }),
    })
    await renderPage({ api })
    await select('page-solution-design')
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: '撤回' })) })
    await waitFor(() => expect(document.body.textContent).toContain('撤回 page-solution-design？'))
    expect(document.body.textContent).toContain('Codex 后来也打开了它。撤回后资产库里没有这一份了，Codex 里也会没有它。')
    const confirmBox = [...document.querySelectorAll('[role="dialog"]')].at(-1)
    await act(async () => { fireEvent.click(within(confirmBox).getByRole('button', { name: '撤回' })) })
    await toastText('已撤回 page-solution-design，原件放回原处')
    expect(api.executeSkillCommand.mock.calls.at(-1)[0]).toMatchObject({ action: 'undo', confirmed: true })
  })

  it('TC-015 INBOX_FLOWS 重新进入 Skills 页先显示上次的要处理清单，后台读完换成新的', async () => {
    const before = snapshot({ items: inboxItems().filter((item) => item.name === 'writing-assistant') })
    const after = snapshot({ items: inboxItems().filter((item) => item.name === 'liuyao-divination') })
    const api = makeApi({ snap: before })
    const inboxRow = (name) => document.querySelector(`[data-id="inbox:${name}"]`)
    await renderPage({ api })
    expect(inboxRow('writing-assistant')).toBeTruthy()
    cleanup()
    let release
    api.getSkillControlSnapshot.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ success: true, data: after, error: null }) }))
    await renderPage({ api })
    expect(inboxRow('writing-assistant'), 'INBOX_FLOWS 进来先显示上次的清单').toBeTruthy()
    await act(async () => { release() })
    await waitFor(() => expect(inboxRow('liuyao-divination')).toBeTruthy())
    expect(inboxRow('writing-assistant'), 'INBOX_FLOWS 后台读完换成新的').toBeNull()
  })

  it('TC-015 INBOX_FLOWS 离开 Skills 页再进来，最近收进卡和收进记录照样出现', async () => {
    const snap = snapshot({ operations: [op({ name: 'page-solution-design', state: 'undoable' })] })
    await renderPage({ snap })
    cleanup()
    await renderPage({ snap })
    await select('page-solution-design')
    expect(detail().textContent).toContain('最近收进')
  })
})

describe('三个视图', () => {
  it('TC-015 INBOX_FLOWS 收进记录：六种状态与计数', async () => {
    const operations = [
      op({ name: 'writing-assistant', state: 'undoable', at: '2026-10-03T13:42:00.000Z', from: { toolId: 'codex', scope: 'project', projectName: 'my-blog' } }),
      op({ name: 'writing-assistant', state: 'waiting', at: '2026-10-03T13:40:00.000Z' }),
      op({ name: 'liuyao-divination', state: 'partial', partialKind: 'collect', at: '2026-10-03T13:31:00.000Z', from: { toolId: 'codex', scope: 'project', projectName: 'notes-app' } }),
      op({ name: 'git-push', state: 'blocked', reason: 'library-changed', at: '2026-10-03T12:10:00.000Z' }),
      op({ name: 'hatch-pet-old', state: 'library-deleted', at: '2026-10-01T12:05:00.000Z', from: { toolId: 'claude-code', scope: 'global', projectName: null } }),
      op({ name: 'case-radar', state: 'undone', at: '2026-09-30T10:12:00.000Z', undoneAt: '2026-09-30T10:30:00.000Z', from: { toolId: 'claude-code', scope: 'project', projectName: 'IP' } }),
    ]
    await renderPage({ snap: snapshot({ operations }) })
    fireEvent.click(within(detail()).getByText('收进记录 6 次'))
    expect(await screen.findByRole('heading', { level: 2, name: '收进记录' })).toBeTruthy()
    const pane = detail()
    expect(pane.textContent).toContain('6 次，其中 3 次现在能撤回或要继续恢复 · 没撤回的原件在备份里；同一个名字先撤后一次')
    const rows = [...pane.querySelectorAll('.sk-prow')]
    const rowOf = (text) => rows.find((row) => row.textContent.includes(text))
    expect(rowOf('从 Codex · my-blog 项目 收进 · 今天 21:42')).toBeTruthy()
    expect(within(rowOf('先撤回上面那次')).getByRole('button', { name: '撤回' }).disabled).toBe(true)
    expect(within(rowOf('上次没做完')).getByRole('button', { name: '继续恢复' })).toBeTruthy()
    expect(within(rowOf('资产库里这份后来改过')).getByRole('button', { name: '撤回' }).disabled).toBe(true)
    expect(within(rowOf('资产库里已经删了；撤回只把原件放回原处')).getByRole('button', { name: '撤回' }).disabled).toBe(false)
    const undone = rowOf('已撤回 · 9月30日 18:30')
    expect(undone, 'INBOX_FLOWS 已撤回的写时间').toBeTruthy()
    expect(within(undone).queryByRole('button')).toBeNull()
  })

  it('TC-015 INBOX_FLOWS 已忽略：全局那份写照常装载；三种取消结果', async () => {
    const ignored = [
      { ignoreId: 'ig1', name: 'security-triage', toolId: 'codex', scope: 'project', projectName: 'side-project', displayPath: '~/Documents/side-project/.agents/skills/security-triage', stillLoaded: false },
      { ignoreId: 'ig2', name: 'pdf-tools', toolId: 'claude-code', scope: 'global', projectName: null, displayPath: '~/.claude/skills/pdf-tools', stillLoaded: true },
    ]
    const replies = [
      respond(snapshot({ ignored })),
      respond(snapshot({ ignored }), { reason: 'same-as-library' }),
      respond(snapshot({ ignored }), { reason: 'source-gone' }),
      fail('WRITE_FAILED', 'not-run', snapshot({ ignored })),
    ]
    let call = 0
    await renderPage({ snap: snapshot({ ignored }), execute: async () => replies[call++] })
    fireEvent.click(within(detail()).getByText('已忽略 2 份'))
    expect(await screen.findByRole('heading', { level: 2, name: '已忽略' })).toBeTruthy()
    const pane = detail()
    expect(pane.textContent).toContain('2 份 · 只是不再提示，文件和开关都不变')
    expect(pane.textContent).toContain('Claude Code · 全局目录；在 Claude Code 里照常装载')
    expect(pane.textContent).toContain('Codex · side-project 项目')
    const texts = ['已取消忽略，回到要处理', '已取消忽略；它和资产库一样，可以在它的「启用」里换成链接', '这一份已经不在了，已删掉忽略记录', '操作失败，已保留原状态']
    for (const text of texts) {
      await act(async () => { fireEvent.click(within(detail()).getAllByRole('button', { name: '取消忽略' })[0]) })
      await toastText(text)
    }
  })

  it('TC-015 INBOX_FLOWS 找到的项目：份数与读不了的原因', async () => {
    await renderPage()
    fireEvent.click(within(detail()).getByText('从 3 个项目里找到'))
    expect(await screen.findByRole('heading', { level: 2, name: '找到的项目' })).toBeTruthy()
    const pane = detail()
    expect(pane.textContent).toContain('~/Documents/projects/my-blog')
    expect(pane.textContent).toMatch(/4\s*份/)
    expect(pane.textContent).toContain('读不了：没有权限')
    expect(pane.textContent).toContain('只看里面真有 .claude/skills、.agents/skills、.codex/skills 的目录；家目录和临时目录不看。')
    expect(listItem('装载总览').getAttribute('aria-selected'), 'INBOX_FLOWS 二级视图左栏仍选中装载总览').toBe('true')
  })
})
