/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：代码审核第 2 轮补的行为
 *
 * 负责：
 * - TC-040：「换成这一份」的撤回在两次改名之间强退：继续恢复不删已经挪进备份的新版（含后来的使用记录）
 * - TC-041：备份之前原件就被改了：不收进（not-run），原件和改动都在，资产库不动
 * - TC-042：原件挪走后、核对之前强退：继续恢复把挪走的那份（含备份后的改动）原样放回，不用旧备份顶替
 * - TC-043：同名几份都不在资产库且内容不一样：从第二份起写「和第一份不一样」并逐个列出差异文件（定稿 A16）
 * 所有写入只在临时家目录；TC-043 页面接真实主进程处理函数。
 *
 * @module tests/skills/inbox/reviewFixes2.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { resetToastForTests } from '../../../src/components/Toast'
import { createFakeCodexApi, exists, makeHome, readTree, writeClaudeSettings, writeSkill } from './helpers.js'
import { USAGE, detail, listItems, renderPage } from './uiFixtures.jsx'

const require = createRequire(import.meta.url)
const { getSkillControlSnapshot, executeSkillCommand } = require('../../../electron/services/skillControlService')
const { registerSkillControlHandlers } = require('../../../electron/handlers/registerSkillControlHandlers')
const { backupDir } = require('../../../electron/modules/skills/skillsDataDir')

vi.mock('../../../src/store/skillRepoPath', () => ({
  skillRepoPath: {
    getRepoPath: vi.fn(async () => '/Users/me/Documents/SkillManager'),
    getCachedRepoPath: vi.fn(() => null),
  },
}))

let env
let deps
let p1
let p2

beforeEach(async () => {
  env = await makeHome('review-fixes-2')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  p1 = path.join(env.homeDir, 'work', 'p1')
  p2 = path.join(env.homeDir, 'work', 'p2')
  await fs.mkdir(p1, { recursive: true })
  await fs.mkdir(p2, { recursive: true })
  await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [p1]: {}, [p2]: {} } }))
  await writeClaudeSettings(env.homeDir, { theme: 'dark' })
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
})
afterEach(async () => {
  cleanup()
  resetToastForTests()
  await env.cleanup()
})

const run = (params, extra = {}) => executeSkillCommand({ repoPath: env.repoPath, homeDir: env.homeDir, ...params }, { ...deps, ...extra })
const snapshotOf = () => getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, deps)
const claudeIn = (project) => path.join(project, '.claude', 'skills')
const crash = () => Object.assign(new Error('CRASH'), { code: 'CRASH', crash: true })
async function copyOf(name) {
  const snap = await snapshotOf()
  return snap.inbox.items.find((item) => item.name === name).copies[0]
}
async function stateOf(operationId) {
  return (await snapshotOf()).operations.find((op) => op.operationId === operationId)
}
async function rejection(promise) {
  try { await promise } catch (error) { return error }
  return null
}

describe('撤回与恢复的强退窗口', () => {
  it('TC-040 UNDO_STAGE_KEPT 撤回在两次改名之间强退：继续恢复不删挪进备份的新版和使用记录', async () => {
    await writeSkill(env.repoPath, 'swap-stage', 'library v1')
    const libraryV1 = await readTree(path.join(env.repoPath, 'swap-stage'))
    await writeSkill(claudeIn(p1), 'swap-stage', 'project v2')
    const { operationId } = await run({ action: 'collect', skillName: 'swap-stage', sourceId: (await copyOf('swap-stage')).sourceId, keep: 'source' })
    await fs.mkdir(path.join(env.repoPath, 'swap-stage', '.codepal'), { recursive: true })
    await fs.writeFile(path.join(env.repoPath, 'swap-stage', '.codepal', 'usage.jsonl'), '{"run":1}\n')
    const newVersion = await readTree(path.join(env.repoPath, 'swap-stage'))
    const error = await rejection(run({ action: 'undo', operationId }, {
      collectHook: async (stepId, phase) => { if (stepId === 'library' && phase === 'revert-between') throw crash() },
    }))
    expect(error?.code, 'UNDO_STAGE_KEPT 应在两次改名之间强退').toBe('CRASH')
    const result = await run({ action: 'resume', operationId })
    expect(result.outcome).toBe('done')
    expect(await readTree(path.join(env.repoPath, 'swap-stage')), 'UNDO_STAGE_KEPT 资产库回到旧版').toEqual(libraryV1)
    const staged = path.join(backupDir(env.homeDir, operationId), 'library-after')
    expect(await readTree(staged), 'UNDO_STAGE_KEPT 挪进备份的新版连同使用记录一字不少').toEqual(newVersion)
  })

  it('TC-041 BACKUP_BOUND 备份之前原件就被改了：不收进，原件和改动都在，资产库不动', async () => {
    const original = await writeSkill(claudeIn(p1), 'early-edit', 'project v1')
    const expected = { ...(await readTree(original)), 'late.md': 'before backup' }
    const copy = await copyOf('early-edit')
    const error = await rejection(run({ action: 'collect', skillName: 'early-edit', sourceId: copy.sourceId }, {
      collectHook: async (stepId, phase) => {
        if (stepId === 'backup-source' && phase === 'apply-before') await fs.writeFile(path.join(original, 'late.md'), 'before backup')
      },
    }))
    expect(error?.code, 'BACKUP_BOUND 应停下').toBe('SOURCE_CHANGED')
    expect(error?.outcome, 'BACKUP_BOUND 什么都没动').toBe('not-run')
    expect(await readTree(original), 'BACKUP_BOUND 原件和改动都在').toEqual(expected)
    expect(await exists(path.join(env.repoPath, 'early-edit'))).toBe(false)
    expect((await snapshotOf()).operations.filter((op) => op.name === 'early-edit')).toEqual([])
  })

  it('TC-042 MOVED_SOURCE_RESTORED 原件挪走后、核对之前强退：继续恢复放回挪走的那份，不用旧备份顶替', async () => {
    const original = await writeSkill(claudeIn(p1), 'moved-edit', 'project v1')
    const expected = { ...(await readTree(original)), 'notes.md': 'written after backup' }
    const copy = await copyOf('moved-edit')
    const error = await rejection(run({ action: 'collect', skillName: 'moved-edit', sourceId: copy.sourceId }, {
      collectHook: async (stepId, phase) => {
        if (stepId === 'backup-source' && phase === 'apply-after') await fs.writeFile(path.join(original, 'notes.md'), 'written after backup')
        if (stepId === 'remove-source' && phase === 'apply-moved') throw crash()
      },
    }))
    expect(error?.code, 'MOVED_SOURCE_RESTORED 应在挪走后强退').toBe('CRASH')
    expect((await stateOf(error.operationId)).state).toBe('partial')
    const result = await run({ action: 'resume', operationId: error.operationId })
    expect(result.outcome).toBe('done')
    expect(await readTree(original), 'MOVED_SOURCE_RESTORED 挪走的那份原样放回（含备份后写的）').toEqual(expected)
    expect(await exists(path.join(env.repoPath, 'moved-edit'))).toBe(false)
  })
})

describe('几份都不在资产库', () => {
  it('TC-043 PEER_DIFF 同名两份都不在资产库且不一样：第二份写和第一份差在哪并列出文件', async () => {
    env.handlers = {}
    registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { env.handlers[channel] = fn } }, homeDir: env.homeDir }, deps)
    // 资产库放一个无关的：资产库空时页面不读调用次数，渲染等不到
    await writeSkill(env.repoPath, 'anchor', 'anchor')
    await writeSkill(claudeIn(p1), 'twins', 'same body')
    await writeSkill(claudeIn(p2), 'twins', 'same body', { 'extra.md': 'only in p2' })
    const api = {
      getSkillControlSnapshot: (params) => env.handlers['skill-control:get-snapshot']({}, params || {}),
      executeSkillCommand: (params) => env.handlers['skill-control:execute']({}, params),
      aggregateSkillUsage: vi.fn(async () => ({ success: true, data: { skills: USAGE } })),
      listSkillRunSamples: vi.fn(async () => ({ success: true, data: { records: [] } })),
    }
    await renderPage({ api })
    await waitFor(() => expect(listItems().some((item) => item.getAttribute('data-id') === 'inbox:twins')).toBe(true), { timeout: 10000 })
    await act(async () => { fireEvent.click(listItems().find((item) => item.getAttribute('data-id') === 'inbox:twins')) })
    await waitFor(() => expect(detail().querySelectorAll('.sk-copy').length).toBe(2))
    expect(detail().textContent).toContain('这 2 份内容不一样')
    const [first, second] = [...detail().querySelectorAll('.sk-copy')]
    expect(first.textContent, 'PEER_DIFF 第一份只写资产库没有').not.toContain('和第一份不一样')
    expect(second.textContent, 'PEER_DIFF 第二份写和第一份差在哪').toMatch(/和第一份不一样：(多|少) 1 个/)
    expect(second.textContent, 'PEER_DIFF 列出差异文件').toContain('extra.md')
  }, 20000)
})
