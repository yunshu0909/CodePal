/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：接口与快照契约
 *
 * 负责：
 * - TC-011：get-snapshot 不带资产库路径也读到配置里的资产库，返回 inbox / projects / ignored / operations / gate；
 *   页面传来的 repoPath 被忽略；五个新动作都返回 {success, data:{outcome, snapshot}, error}；
 *   同名两个写操作并发时第二个等第一个做完；preload 原样转发；useSkillControl 不再传 repoPath 和 projectRoots
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/handlers.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeCodexApi, makeHome, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { registerSkillControlHandlers } = require('../../../electron/handlers/registerSkillControlHandlers')

const ROOT = path.resolve(import.meta.dirname, '../../..')

let env
let handlers
let deps
let project

beforeEach(async () => {
  env = await makeHome('handlers')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  project = path.join(env.homeDir, 'work', 'proj')
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [project]: {} } }))
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
  handlers = {}
  registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir: env.homeDir }, deps)
})
afterEach(async () => { await env.cleanup() })

const snapshot = (params = {}) => handlers['skill-control:get-snapshot']({}, params)
const execute = (params) => handlers['skill-control:execute']({}, params)

describe('接口与快照契约', () => {
  it('TC-011 INBOX_IPC 快照不靠页面给路径，带 inbox / projects / ignored / operations / gate', async () => {
    await writeSkill(env.repoPath, 'lib-one', 'lib')
    await writeSkill(path.join(env.homeDir, '.claude', 'skills'), 'lib-one', 'changed')
    await writeSkill(path.join(project, '.claude', 'skills'), 'proj-one', 'proj')
    const response = await snapshot({ repoPath: '/definitely/not/here' })
    expect(response.success, 'INBOX_IPC 页面给的路径应被忽略').toBe(true)
    const data = response.data
    expect(data.inbox.items.map((item) => item.name).sort()).toEqual(['lib-one', 'proj-one'])
    expect(data.projects.found.map((item) => item.name)).toEqual(['proj'])
    expect(data.ignored).toEqual([])
    expect(data.operations).toEqual([])
    expect(data.skills.find((skill) => skill.name === 'lib-one').gate['claude-code'].why).toBe('pending')
  })

  it('TC-011 INBOX_IPC 五个新动作都返回 {success, data:{outcome, snapshot}, error}', async () => {
    await writeSkill(path.join(project, '.claude', 'skills'), 'act', 'act body')
    await writeSkill(path.join(project, '.claude', 'skills'), 'skip', 'skip body')
    const first = (await snapshot()).data
    const copyOf = (name) => first.inbox.items.find((item) => item.name === name).copies[0]

    const collected = await execute({ action: 'collect', skillName: 'act', sourceId: copyOf('act').sourceId, repoPath: '/bogus' })
    expect(collected.success, 'INBOX_IPC collect').toBe(true)
    expect(collected.data.outcome).toBe('done')
    expect(collected.data.snapshot.operations.length).toBe(1)
    expect(collected.error).toBeNull()

    const ignored = await execute({ action: 'ignore', skillName: 'skip', sourceId: copyOf('skip').sourceId })
    expect(ignored.data.outcome).toBe('done')
    const ignoreId = ignored.data.snapshot.ignored[0].ignoreId
    const unignored = await execute({ action: 'unignore', ignoreId })
    expect(unignored.data.outcome).toBe('done')

    const operationId = collected.data.operationId
    const undone = await execute({ action: 'undo', operationId })
    expect(undone.data.outcome).toBe('done')
    const resumed = await execute({ action: 'resume', operationId })
    expect(resumed.success).toBe(true)
    expect(resumed.data.outcome).toBe('done')
    for (const response of [ignored, unignored, undone, resumed]) {
      expect(response.data.snapshot, 'INBOX_IPC 每个动作都带新快照').toBeTruthy()
      expect(response.error).toBeNull()
    }
  })

  it('TC-011 INBOX_IPC 同名两个写操作并发：第二个等第一个做完', async () => {
    await writeSkill(path.join(project, '.claude', 'skills'), 'race', 'race body')
    await writeSkill(path.join(env.homeDir, '.claude', 'skills', '..', '..', 'work', 'proj2', '.claude', 'skills'), 'race', 'race body two')
    await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [project]: {}, [path.join(env.homeDir, 'work', 'proj2')]: {} } }))
    const first = (await snapshot()).data
    const [a, b] = first.inbox.items.find((item) => item.name === 'race').copies
    const order = []
    let release
    const gate = new Promise((resolve) => { release = resolve })
    handlers = {}
    registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir: env.homeDir }, {
      ...deps,
      collectHook: async (stepId, phase) => {
        if (stepId === 'backup-source' && phase === 'apply-before' && order.length === 0) {
          order.push('collect-started')
          await gate
        }
      },
    })
    const collecting = execute({ action: 'collect', skillName: 'race', sourceId: a.sourceId }).then((result) => { order.push('collect-done'); return result })
    // 等第一个真的开始动手（负载高时找副本要多花点时间，不能用固定等待）
    for (let tries = 0; tries < 200 && order.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const ignoring = execute({ action: 'ignore', skillName: 'race', sourceId: b.sourceId }).then((result) => { order.push('ignore-done'); return result })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order, 'INBOX_IPC 同名第二个应等第一个').toEqual(['collect-started'])
    release()
    await Promise.all([collecting, ignoring])
    expect(order).toEqual(['collect-started', 'collect-done', 'ignore-done'])
  })

  it('TC-011 INBOX_IPC preload 原样转发，页面不再传 repoPath 和 projectRoots', async () => {
    const preload = await fs.readFile(path.join(ROOT, 'electron', 'preload.js'), 'utf8')
    expect(preload).toMatch(/executeSkillCommand:\s*\(params\)\s*=>\s*ipcRenderer\.invoke\('skill-control:execute',\s*params\)/)
    expect(preload).toMatch(/getSkillControlSnapshot:\s*\(params\)\s*=>\s*ipcRenderer\.invoke\('skill-control:get-snapshot',\s*params\)/)
    const hook = await fs.readFile(path.join(ROOT, 'src', 'hooks', 'useSkillControl.js'), 'utf8')
    expect(hook, 'INBOX_IPC useSkillControl 不再传 projectRoots').not.toMatch(/projectRoots/)
    expect(hook, 'INBOX_IPC useSkillControl 不再把 repoPath 发给主进程').not.toMatch(/executeSkillCommand\(\{\s*repoPath/)
    expect(hook).not.toMatch(/getSkillControlSnapshot\(\{\s*repoPath/)
  })
})
