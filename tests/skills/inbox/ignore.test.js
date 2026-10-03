/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：忽略与取消忽略
 *
 * 负责：
 * - TC-010：忽略项目里一份 → 从清单消失、文件和开关不动、记录按工具 + 项目路径 + 位置；同名别的份照旧；
 *   资产库删掉同名后仍不出现；项目搬家后新路径照常出现；取消忽略：项目里一样的那份回到清单，
 *   全局一样的那份不回清单（reason=same-as-library），原件已不在只删记录（reason=source-gone）
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/ignore.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeCodexApi, makeHome, readTree, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { getSkillControlSnapshot, executeSkillCommand } = require('../../../electron/services/skillControlService')

let env
let deps
let p1
let p2

beforeEach(async () => {
  env = await makeHome('ignore')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  p1 = path.join(env.homeDir, 'work', 'p1')
  p2 = path.join(env.homeDir, 'work', 'p2')
  await fs.mkdir(p1, { recursive: true })
  await fs.mkdir(p2, { recursive: true })
  await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [p1]: {}, [p2]: {} } }))
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
})
afterEach(async () => { await env.cleanup() })

const run = (params) => executeSkillCommand({ repoPath: env.repoPath, homeDir: env.homeDir, ...params }, deps)
const snapshotOf = () => getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, deps)
const itemOf = (snap, name) => snap.inbox.items.find((item) => item.name === name) || null
const userTree = async () => Object.fromEntries(Object.entries(await readTree(env.homeDir)).filter(([key]) => !key.startsWith('Library/')))

describe('忽略与取消忽略', () => {
  it('TC-010 IGNORE_STORE 忽略一份：从清单消失、文件不动、同名别的份照旧；资产库删同名不冒回；搬家后新路径出现', async () => {
    await writeSkill(path.join(p1, '.claude', 'skills'), 'shared', 'shared body')
    await writeSkill(path.join(p2, '.claude', 'skills'), 'shared', 'shared body')
    let snap = await snapshotOf()
    const p1Copy = itemOf(snap, 'shared').copies.find((copy) => copy.projectName === 'p1')
    const before = await userTree()
    const result = await run({ action: 'ignore', skillName: 'shared', sourceId: p1Copy.sourceId })
    expect(result.outcome).toBe('done')
    expect(await userTree(), 'IGNORE_STORE 忽略不动用户文件').toEqual(before)
    snap = await snapshotOf()
    expect(itemOf(snap, 'shared').copies.map((copy) => copy.projectName), 'IGNORE_STORE 只忽略那一份').toEqual(['p2'])
    const record = snap.ignored.find((entry) => entry.name === 'shared')
    expect(record).toMatchObject({ toolId: 'claude-code', scope: 'project', projectName: 'p1', displayPath: '~/work/p1/.claude/skills/shared' })
    expect(record.ignoreId).toBeTruthy()

    // 资产库里有过又删掉同名：忽略照样有效
    await writeSkill(env.repoPath, 'shared', 'shared body')
    await run({ action: 'delete', toolId: 'all', skillName: 'shared' })
    snap = await snapshotOf()
    expect(itemOf(snap, 'shared').copies.map((copy) => copy.projectName), 'IGNORE_STORE 资产库删同名不冒回').toEqual(['p2'])

    // 项目搬家：新路径按新来源出现
    const moved = path.join(env.homeDir, 'work', 'p1-moved')
    await fs.rename(p1, moved)
    await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [moved]: {}, [p2]: {} } }))
    snap = await snapshotOf()
    expect(itemOf(snap, 'shared').copies.map((copy) => copy.projectName).sort(), 'IGNORE_STORE 搬家后新路径出现').toEqual(['p1-moved', 'p2'])
  })

  it('TC-010 IGNORE_STORE 取消忽略：项目里一样的回清单；全局一样的不回并说明；原件不在只删记录', async () => {
    await writeSkill(env.repoPath, 'same-p', 'same body')
    await writeSkill(path.join(p1, '.claude', 'skills'), 'same-p', 'same body')
    await writeSkill(env.repoPath, 'same-g', 'g lib')
    const globalCopy = await writeSkill(path.join(env.homeDir, '.claude', 'skills'), 'same-g', 'g changed')
    await writeSkill(path.join(p1, '.claude', 'skills'), 'vanish', 'vanish body')
    let snap = await snapshotOf()
    for (const name of ['same-p', 'same-g', 'vanish']) {
      await run({ action: 'ignore', skillName: name, sourceId: itemOf(snap, name).copies[0].sourceId })
    }
    snap = await snapshotOf()
    const idOf = (name) => snap.ignored.find((entry) => entry.name === name).ignoreId

    let result = await run({ action: 'unignore', ignoreId: idOf('same-p') })
    expect(result.outcome).toBe('done')
    expect(result.reason ?? null, 'IGNORE_STORE 项目里一样的回清单').toBeNull()

    // 忽略期间全局那份改成和资产库一样
    await fs.writeFile(path.join(globalCopy, 'SKILL.md'), await fs.readFile(path.join(env.repoPath, 'same-g', 'SKILL.md')))
    result = await run({ action: 'unignore', ignoreId: idOf('same-g') })
    expect(result.reason, 'IGNORE_STORE 全局一样的不回清单').toBe('same-as-library')

    await fs.rm(path.join(p1, '.claude', 'skills', 'vanish'), { recursive: true, force: true })
    result = await run({ action: 'unignore', ignoreId: idOf('vanish') })
    expect(result.reason, 'IGNORE_STORE 原件不在只删记录').toBe('source-gone')

    snap = await snapshotOf()
    expect(snap.ignored).toEqual([])
    expect(itemOf(snap, 'same-p')?.copies.length).toBe(1)
    expect(itemOf(snap, 'same-g')).toBeNull()
    expect(itemOf(snap, 'vanish')).toBeNull()
  })
})
