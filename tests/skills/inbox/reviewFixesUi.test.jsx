/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：代码审核第 1 轮与实机检查补的页面行为
 *
 * 负责：
 * - TC-025：资产库已有、全局目录里一样的独立文件夹：从详情点「换成链接」→ 确认 → 真实主进程收进成功、位置换成链接
 * - TC-026：确认框打开后资产库变了：点「收进」提示内容刚变了，框里按现在的样子更新（变成一样就不再问留哪份），再点就收进成功
 * - TC-036：收进没执行（全局位置被占）确认框留着、写原因，不说「已恢复原样」；撤回被挡不弹定稿外的提示，卡上写原因
 * - TC-037：页面钩子不再导出已下线的「外部」组收进
 * - TC-038：Skills 页样式只用设计 token 里有的颜色变量（「不在资产库」的橙点和色段画得出来）
 * - TC-039：纯新用户：「资产库还没有 Skill」排在「要处理」各条之后
 * TC-025、TC-026 接真实的主进程处理函数，文件都在临时家目录。
 *
 * @module tests/skills/inbox/reviewFixesUi.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { resetToastForTests } from '../../../src/components/Toast'
import { createFakeCodexApi, isLinkTo, makeHome, writeClaudeSettings, writeSkill } from './helpers.js'
import { USAGE, copyRow, detail, dialog, inboxItems, listItems, makeApi, renderPage, select, snapshot, toastText } from './uiFixtures.jsx'

const require = createRequire(import.meta.url)
const { registerSkillControlHandlers } = require('../../../electron/handlers/registerSkillControlHandlers')
const ROOT = path.resolve(import.meta.dirname, '../../..')

vi.mock('../../../src/store/skillRepoPath', () => ({
  skillRepoPath: {
    getRepoPath: vi.fn(async () => '/Users/me/Documents/SkillManager'),
    getCachedRepoPath: vi.fn(() => null),
  },
}))

let env = null
afterEach(async () => {
  cleanup()
  resetToastForTests()
  document.querySelectorAll('.confirm-dialog-host').forEach((node) => node.remove())
  if (env) await env.cleanup()
  env = null
})

/** 页面接真实主进程处理函数（临时家目录） */
async function realApi() {
  env = await makeHome('review-ui')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  await writeClaudeSettings(env.homeDir, { theme: 'dark' })
  const handlers = {}
  registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir: env.homeDir }, { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) })
  return {
    getSkillControlSnapshot: (params) => handlers['skill-control:get-snapshot']({}, params || {}),
    executeSkillCommand: (params) => handlers['skill-control:execute']({}, params),
    aggregateSkillUsage: vi.fn(async () => ({ success: true, data: { skills: USAGE } })),
    listSkillRunSamples: vi.fn(async () => ({ success: true, data: { records: [] } })),
  }
}

describe('接真实主进程', () => {
  it('TC-025 GATE_RELINK 全局目录里一样的独立文件夹：点「换成链接」确认后真的换成链接', async () => {
    const api = await realApi()
    await writeSkill(env.repoPath, 'relink', 'same body')
    await writeSkill(path.join(env.homeDir, '.claude', 'skills'), 'relink', 'same body')
    await renderPage({ api })
    await waitFor(() => expect(listItems().some((item) => item.textContent.includes('relink'))).toBe(true), { timeout: 10000 })
    await select('relink')
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: '换成链接' })) })
    await waitFor(() => expect(dialog()).not.toBeNull())
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '收进' })) })
    await toastText('已从 Claude Code 收进资产库：relink')
    expect(document.body.textContent, 'GATE_RELINK 不应提示内容变了').not.toContain('内容刚变了')
    expect(await isLinkTo(path.join(env.homeDir, '.claude', 'skills', 'relink'), path.join(env.repoPath, 'relink')), 'GATE_RELINK 位置换成资产库链接').toBe(true)
  }, 20000)

  it('TC-026 DIALOG_REFRESH 确认框打开后资产库变了：提示并按现在的样子更新，再点就收进成功', async () => {
    const api = await realApi()
    const project = path.join(env.homeDir, 'work', 'p1')
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [project]: {} } }))
    await writeSkill(env.repoPath, 'drift', 'library v1')
    await writeSkill(path.join(project, '.claude', 'skills'), 'drift', 'project v2')
    await renderPage({ api })
    await waitFor(() => expect(listItems().some((item) => item.getAttribute('data-id') === 'inbox:drift')).toBe(true), { timeout: 10000 })
    await act(async () => { fireEvent.click(listItems().find((item) => item.getAttribute('data-id') === 'inbox:drift')) })
    await waitFor(() => expect(copyRow('/work/p1/')).toBeTruthy())
    fireEvent.click(within(copyRow('/work/p1/')).getByRole('button', { name: '收进' }))
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.click(within(dialog()).getByText('留资产库里的', { exact: true }))
    // 确认框开着时，资产库被改成和这一份一样
    await writeSkill(env.repoPath, 'drift', 'project v2')
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '收进' })) })
    await waitFor(() => expect(dialog().textContent).toContain('内容刚变了，上面已经按现在的样子更新，请重新选'))
    expect(within(dialog()).queryAllByRole('radio'), 'DIALOG_REFRESH 变成一样后不再问留哪份').toEqual([])
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '收进' })) })
    await toastText('已从 Claude Code 收进资产库：drift')
    await waitFor(() => expect(dialog()).toBeNull())
  }, 20000)
})

describe('结果提示', () => {
  const op = (fields) => ({
    operationId: `op_${fields.name}`,
    kind: 'collect',
    from: { toolId: 'claude-code', scope: 'project', projectName: 'my-blog', displayPath: `~/x/.claude/skills/${fields.name}` },
    at: '2026-10-03T13:40:00.000Z',
    ...fields,
  })

  it('TC-036 NOT_RUN_FEEDBACK 收进没执行留着确认框写原因；撤回被挡不弹提示、卡上写原因', async () => {
    const blockedSnap = snapshot({ operations: [op({ name: 'page-solution-design', state: 'blocked', reason: 'library-changed' })] })
    const snap = snapshot({ operations: [op({ name: 'page-solution-design', state: 'undoable' })] })
    await renderPage({
      snap,
      execute: async (params) => {
        if (params.action === 'collect') return { success: false, error: 'SLOT_OCCUPIED', data: { outcome: 'not-run' }, snapshot: null }
        return { success: false, error: 'UNDO_BLOCKED', data: { outcome: 'not-run', reason: 'library-changed', snapshot: blockedSnap }, snapshot: blockedSnap }
      },
    })
    await select('writing-assistant')
    fireEvent.click(within(copyRow('/my-blog/.claude/skills/writing-assistant')).getByRole('button', { name: '收进' }))
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.click(within(dialog()).getByText('留资产库里的', { exact: true }))
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '收进' })) })
    await waitFor(() => expect(dialog()?.textContent).toContain('收不了：Claude Code 全局目录里已经有一份自己的 writing-assistant，先处理那一份'))
    expect(document.body.textContent, 'NOT_RUN_FEEDBACK 没执行不能说已恢复原样').not.toContain('收进失败，已恢复原样')
    fireEvent.click(within(dialog()).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(dialog()).toBeNull())

    await select('page-solution-design')
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: '撤回' })) })
    await waitFor(() => expect(detail().textContent).toContain('现在撤不了：资产库里这份后来改过'))
    expect(document.body.textContent, 'NOT_RUN_FEEDBACK 撤回被挡不弹定稿外的提示').not.toContain('撤回失败')
  })

  it('TC-037 ADOPT_OFFLINE 页面钩子不再导出「外部」组的收进', async () => {
    const hook = await fs.readFile(path.join(ROOT, 'src', 'hooks', 'useSkillControl.js'), 'utf8')
    expect(hook).not.toMatch(/adoptExternalSkill/)
    expect(hook).not.toMatch(/action: 'adopt'/)
  })

  it('TC-038 TOKEN_COLORS Skills 页样式里的颜色变量都在设计 token 里有定义', async () => {
    const tokens = await fs.readFile(path.join(ROOT, 'src', 'styles', 'design-tokens.css'), 'utf8')
    const native = await fs.readFile(path.join(ROOT, 'src', 'styles', 'native.css'), 'utf8')
    const defined = new Set([...`${tokens}\n${native}`.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]))
    const css = await fs.readFile(path.join(ROOT, 'src', 'pages', 'skills', 'skills.css'), 'utf8')
    const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]))]
    expect(used.filter((name) => !defined.has(name)), 'TOKEN_COLORS 用到了没定义的变量').toEqual([])
  })

  it('TC-039 NEWBIE_NOTE 纯新用户：「资产库还没有 Skill」排在要处理各条之后', async () => {
    const items = inboxItems().map((item) => ({ ...item, relation: 'none', libraryDigest: null, copies: item.copies.map((copy) => ({ ...copy, relation: 'none' })) }))
    const readOnly = snapshot().skills.filter((skill) => !skill.managed)
    await renderPage({ snap: snapshot({ skills: readOnly, items }) })
    const list = document.querySelector('.np-pane--list')
    const note = [...list.querySelectorAll('*')].find((node) => node.children.length === 0 && node.textContent === '资产库还没有 Skill')
    expect(note, 'NEWBIE_NOTE 要有这一行').toBeTruthy()
    const inboxRows = [...list.querySelectorAll('[data-id^="inbox:"]')]
    expect(inboxRows.length).toBeGreaterThan(0)
    const last = inboxRows.at(-1)
    expect(Boolean(last.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING), 'NEWBIE_NOTE 排在要处理之后').toBe(true)
  })
})
