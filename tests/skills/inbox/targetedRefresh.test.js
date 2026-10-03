/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：单个操作只核对动到的那一个
 *
 * 负责：
 * - TC-012：资产库 40 个 Skill 时停用 Claude 里一个：Codex 接口一次都没调，别的 Skill 的文件一个都没读，
 *   返回快照里其他 Skill 与上次一致、这一个已更新；Codex 停用一个：接口只有写入前后的核对（list、write、list）；
 *   只动 Claude 的收进、忽略、撤回也不调 Codex；删除会动到 Codex 时只调受影响的工具，且都只重读这个名字；
 *   重新读取仍全量读
 * 读文件经 deps.readFileFn 记录；所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/targetedRefresh.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeCodexApi, link, makeHome, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { registerSkillControlHandlers } = require('../../../electron/handlers/registerSkillControlHandlers')

let env
let handlers
let codexApi
let reads
let project

const NAMES = Array.from({ length: 40 }, (_, index) => `skill-${String(index).padStart(2, '0')}`)

beforeEach(async () => {
  env = await makeHome('targeted')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  project = path.join(env.homeDir, 'work', 'proj')
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [project]: {} } }))
  for (const name of NAMES) {
    await writeSkill(env.repoPath, name, `${name} body`, { 'refs/notes.md': `${name} notes` })
    await link(path.join(env.repoPath, name), path.join(env.homeDir, '.claude', 'skills', name))
  }
  await link(path.join(env.repoPath, 'skill-08'), path.join(env.homeDir, '.agents', 'skills', 'skill-08'))
  await link(path.join(env.repoPath, 'skill-09'), path.join(env.homeDir, '.agents', 'skills', 'skill-09'))
  codexApi = createFakeCodexApi({ homeDir: env.homeDir })
  reads = []
  const readFileFn = (target, ...rest) => { reads.push(String(target)); return fs.readFile(target, ...rest) }
  handlers = {}
  registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir: env.homeDir }, { codexSkillApi: codexApi, readFileFn })
})
afterEach(async () => { await env.cleanup() })

const snapshot = () => handlers['skill-control:get-snapshot']({}, {})
const execute = (params) => handlers['skill-control:execute']({}, params)
const reset = () => { reads.length = 0; codexApi.calls.length = 0 }
/** 读到的文件里，属于别的 Skill（skill-XX 但不是这个名字）的 */
const foreignReads = (name) => reads.filter((file) => {
  const hit = /skill-\d\d/.exec(file)
  return hit && hit[0] !== name
})
const othersOf = (snap, name) => JSON.stringify(snap.skills.filter((skill) => skill.name !== name))

describe('只核对动到的那一个', () => {
  it('TC-012 TARGETED_REFRESH 停用 Claude 里一个：不调 Codex、不读别的 Skill、别的不变', async () => {
    const before = (await snapshot()).data
    reset()
    const response = await execute({ action: 'disable', toolId: 'claude-code', skillName: 'skill-07' })
    expect(response.success).toBe(true)
    expect(codexApi.calls, 'TARGETED_REFRESH 只动 Claude 不应调 Codex').toEqual([])
    expect(foreignReads('skill-07'), 'TARGETED_REFRESH 不应读别的 Skill 的文件').toEqual([])
    const after = response.snapshot
    expect(othersOf(after, 'skill-07'), 'TARGETED_REFRESH 其他 Skill 应与上次一致').toBe(othersOf(before, 'skill-07'))
    expect(after.skills.find((skill) => skill.name === 'skill-07').tools['claude-code'].enabled).toBe(false)
  })

  it('TC-012 TARGETED_REFRESH Codex 停用一个：接口只有写入前后的核对', async () => {
    await snapshot()
    reset()
    const response = await execute({ action: 'disable', toolId: 'codex', skillName: 'skill-08' })
    expect(response.success).toBe(true)
    expect(codexApi.calls.map((call) => call.op), 'TARGETED_REFRESH Codex 只核对写入前后').toEqual(['list', 'write', 'list'])
    expect(foreignReads('skill-08')).toEqual([])
    expect(response.snapshot.skills.find((skill) => skill.name === 'skill-08').tools.codex.enabled).toBe(false)
  })

  it('TC-012 TARGETED_REFRESH 只动 Claude 的收进、忽略、撤回不调 Codex，只重读这个名字', async () => {
    await writeSkill(path.join(project, '.claude', 'skills'), 'skill-50', 'project new')
    await writeSkill(path.join(project, '.claude', 'skills'), 'skill-51', 'project other')
    const first = (await snapshot()).data
    const copyOf = (name) => first.inbox.items.find((item) => item.name === name).copies[0]
    reset()
    const collected = await execute({ action: 'collect', skillName: 'skill-50', sourceId: copyOf('skill-50').sourceId })
    expect(collected.data.outcome).toBe('done')
    expect(codexApi.calls, 'TARGETED_REFRESH 收进到 Claude 不调 Codex').toEqual([])
    expect(foreignReads('skill-50')).toEqual([])
    reset()
    await execute({ action: 'ignore', skillName: 'skill-51', sourceId: copyOf('skill-51').sourceId })
    expect(codexApi.calls).toEqual([])
    expect(foreignReads('skill-51')).toEqual([])
    reset()
    await execute({ action: 'undo', operationId: collected.data.operationId })
    expect(codexApi.calls, 'TARGETED_REFRESH 撤回不连带 Codex 时不调 Codex').toEqual([])
    expect(foreignReads('skill-50')).toEqual([])
  })

  it('TC-012 TARGETED_REFRESH 删除会动到 Codex 时只调受影响的工具、只读这个名字；重新读取全量读', async () => {
    await snapshot()
    reset()
    const response = await execute({ action: 'delete', toolId: 'all', skillName: 'skill-09' })
    expect(response.success).toBe(true)
    expect(codexApi.calls.every((call) => call.op === 'list'), 'TARGETED_REFRESH 删除不写 Codex 配置').toBe(true)
    expect(foreignReads('skill-09'), 'TARGETED_REFRESH 删除只读这个名字').toEqual([])
    expect(response.snapshot.skills.some((skill) => skill.name === 'skill-09')).toBe(false)
    reset()
    await snapshot()
    expect(foreignReads('skill-09').length, 'TARGETED_REFRESH 重新读取应全量读').toBeGreaterThan(0)
  })
})
