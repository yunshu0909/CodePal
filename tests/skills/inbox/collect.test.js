/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：收进
 *
 * 负责：
 * - TC-004：资产库没有的——第一次收进时建资产库；全局目录换成指向资产库的链接、项目原件移走、备份逐字相同；
 *   来源工具里打开（Claude 设置为开，其他设置不变；Codex 接口写启用）；收进记录可撤回、记了每一步前后；
 *   Codex 旧目录的原件也移走，链接统一建在 ~/.agents/skills
 * - TC-005：一样的、不一样（留资产库的 / 换成这一份）、不给 keep、确认框打开后内容变了、指向别处的链接、
 *   全局一样的独立文件夹换成链接
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/collect.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { codeOf, createFakeCodexApi, exists, isLinkTo, link, makeHome, readClaudeSettings, readTree, writeClaudeSettings, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { getSkillControlSnapshot, executeSkillCommand } = require('../../../electron/services/skillControlService')

let env
let deps
let project

async function setup({ createRepo = true } = {}) {
  env = await makeHome('collect', { createRepo })
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  project = path.join(env.homeDir, 'work', 'proj')
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [project]: {} } }))
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
}

afterEach(async () => { await env?.cleanup() })

const snapshotOf = () => getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, deps)
async function copyOf(name, predicate = () => true) {
  const snap = await snapshotOf()
  const item = snap.inbox.items.find((entry) => entry.name === name)
  return { item, copy: item?.copies.find(predicate), snap }
}
const collect = (params) => executeSkillCommand({ repoPath: env.repoPath, homeDir: env.homeDir, action: 'collect', ...params }, deps)
const backupsOf = async (operationId) => path.join(env.dataDir, 'backups', operationId)

describe('收进资产库没有的', () => {
  beforeEach(async () => { await setup({ createRepo: false }) })

  it('TC-004 COLLECT_NEW 第一次收进建资产库，项目原件移走进备份，Claude 打开，记录可撤回', async () => {
    const { homeDir, repoPath } = env
    const original = await writeSkill(path.join(project, '.claude', 'skills'), 'proj-new', 'project new', { 'scripts/go.sh': 'echo go' })
    const originalTree = await readTree(original)
    await writeClaudeSettings(homeDir, { theme: 'dark', skillOverrides: { other: 'off' } })
    expect(await exists(repoPath)).toBe(false)

    const { copy } = await copyOf('proj-new')
    const result = await collect({ skillName: 'proj-new', sourceId: copy.sourceId })
    expect(result.outcome, 'COLLECT_NEW 收进应成功').toBe('done')
    expect(result.operationId).toBeTruthy()

    expect(await readTree(path.join(repoPath, 'proj-new')), 'COLLECT_NEW 资产库里应是这一份').toEqual(originalTree)
    expect(await isLinkTo(path.join(homeDir, '.claude', 'skills', 'proj-new'), path.join(repoPath, 'proj-new')), 'COLLECT_NEW Claude 全局应是指向资产库的链接').toBe(true)
    expect(await exists(original), 'COLLECT_NEW 项目原件应移走').toBe(false)
    expect(await readTree(path.join(await backupsOf(result.operationId), 'source')), 'COLLECT_NEW 备份应逐字相同').toEqual(originalTree)
    const settings = await readClaudeSettings(homeDir)
    expect(settings.skillOverrides['proj-new'], 'COLLECT_NEW Claude 应打开').toBe('on')
    expect(settings.skillOverrides.other).toBe('off')
    expect(settings.theme).toBe('dark')

    const snap = await snapshotOf()
    const op = snap.operations.find((entry) => entry.operationId === result.operationId)
    expect(op?.state, 'COLLECT_NEW 收进记录应可撤回').toBe('undoable')
    expect(op.from).toMatchObject({ toolId: 'claude-code', scope: 'project', projectName: 'proj' })
    expect(snap.inbox.items.find((item) => item.name === 'proj-new') ?? null).toBeNull()

    const journal = JSON.parse(await fs.readFile(path.join(env.dataDir, 'ops', `${result.operationId}.json`), 'utf8'))
    expect(journal.steps.length).toBeGreaterThan(0)
    for (const step of journal.steps) {
      expect(step, 'COLLECT_NEW 每一步要记做之前和做之后').toHaveProperty('before')
      expect(step).toHaveProperty('after')
    }
  })

  it('TC-004 COLLECT_NEW Codex 旧目录收进：链接建在 ~/.agents/skills，旧目录原件进备份，接口写启用', async () => {
    const { homeDir, repoPath } = env
    const legacy = await writeSkill(path.join(homeDir, '.codex', 'skills'), 'legacy-new', 'legacy new')
    const legacyTree = await readTree(legacy)
    const { copy } = await copyOf('legacy-new')
    const result = await collect({ skillName: 'legacy-new', sourceId: copy.sourceId })
    expect(result.outcome).toBe('done')
    const official = path.join(homeDir, '.agents', 'skills', 'legacy-new')
    expect(await isLinkTo(official, path.join(repoPath, 'legacy-new')), 'COLLECT_NEW Codex 链接应在 ~/.agents/skills').toBe(true)
    expect(await exists(legacy), 'COLLECT_NEW 旧目录原件应移走').toBe(false)
    expect(await readTree(path.join(await backupsOf(result.operationId), 'source'))).toEqual(legacyTree)
    const writes = deps.codexSkillApi.calls.filter((call) => call.op === 'write')
    expect(writes.at(-1)?.enabled, 'COLLECT_NEW Codex 应写启用').toBe(true)
  })
})

describe('收进一样和不一样的', () => {
  beforeEach(async () => { await setup() })

  it('TC-005 COLLECT_VERSION 项目里一样的：资产库不变，原件进备份，打开工具', async () => {
    const { homeDir, repoPath } = env
    await writeSkill(repoPath, 'same-p', 'same body')
    const libraryTree = await readTree(path.join(repoPath, 'same-p'))
    const original = await writeSkill(path.join(project, '.claude', 'skills'), 'same-p', 'same body')
    const { copy } = await copyOf('same-p')
    expect(copy.relation).toBe('same')
    const result = await collect({ skillName: 'same-p', sourceId: copy.sourceId })
    expect(result.outcome).toBe('done')
    expect(await readTree(path.join(repoPath, 'same-p')), 'COLLECT_VERSION 一样的不改资产库').toEqual(libraryTree)
    expect(await exists(original)).toBe(false)
    expect(await isLinkTo(path.join(homeDir, '.claude', 'skills', 'same-p'), path.join(repoPath, 'same-p'))).toBe(true)
  })

  it('TC-005 COLLECT_VERSION 不一样：留资产库的不改资产库；换成这一份替换并备份旧版，已链接的 Codex 随之变', async () => {
    const { homeDir, repoPath } = env
    await writeSkill(repoPath, 'diff-k', 'library v1')
    const keepTree = await readTree(path.join(repoPath, 'diff-k'))
    await writeSkill(path.join(project, '.claude', 'skills'), 'diff-k', 'project v2')
    let found = await copyOf('diff-k')
    let result = await collect({ skillName: 'diff-k', sourceId: found.copy.sourceId, keep: 'library' })
    expect(result.outcome).toBe('done')
    expect(await readTree(path.join(repoPath, 'diff-k')), 'COLLECT_VERSION 留资产库的不改资产库').toEqual(keepTree)

    await writeSkill(repoPath, 'diff-s', 'library v1')
    const oldTree = await readTree(path.join(repoPath, 'diff-s'))
    const source = await writeSkill(path.join(project, '.claude', 'skills'), 'diff-s', 'project v2', { 'extra.md': 'new' })
    const sourceTree = await readTree(source)
    await link(path.join(repoPath, 'diff-s'), path.join(homeDir, '.agents', 'skills', 'diff-s'))
    found = await copyOf('diff-s')
    result = await collect({ skillName: 'diff-s', sourceId: found.copy.sourceId, keep: 'source' })
    expect(result.outcome).toBe('done')
    expect(await readTree(path.join(repoPath, 'diff-s')), 'COLLECT_VERSION 换成这一份').toEqual(sourceTree)
    expect(await readTree(path.join(await backupsOf(result.operationId), 'library-before')), 'COLLECT_VERSION 旧版进备份').toEqual(oldTree)
    const viaCodex = await fs.readFile(path.join(homeDir, '.agents', 'skills', 'diff-s', 'SKILL.md'), 'utf8')
    expect(viaCodex, 'COLLECT_VERSION 已链接资产库的 Codex 随之变').toContain('project v2')
  })

  it('TC-005 COLLECT_VERSION 不给 keep 报 KEEP_REQUIRED；内容变了报 CONTENT_CHANGED，都什么都没动', async () => {
    const { homeDir, repoPath } = env
    await writeSkill(repoPath, 'diff-x', 'library v1')
    const source = await writeSkill(path.join(project, '.claude', 'skills'), 'diff-x', 'project v2')
    const { copy, item } = await copyOf('diff-x')
    const before = await readTree(homeDir)
    expect(await codeOf(collect({ skillName: 'diff-x', sourceId: copy.sourceId })), 'COLLECT_VERSION 不一样必须选').toBe('KEEP_REQUIRED')
    expect(await readTree(homeDir)).toEqual(before)

    const expectDigests = { sourceDigest: copy.digest, libraryDigest: item.libraryDigest }
    await fs.writeFile(path.join(source, 'SKILL.md'), 'changed after dialog opened')
    const changed = await readTree(homeDir)
    let error = null
    try {
      await collect({ skillName: 'diff-x', sourceId: copy.sourceId, keep: 'source', expect: expectDigests })
    } catch (caught) { error = caught }
    expect(error?.code, 'COLLECT_VERSION 确认框打开后内容变了').toBe('CONTENT_CHANGED')
    expect(error?.outcome).toBe('not-run')
    expect(await readTree(homeDir)).toEqual(changed)
  })

  it('TC-005 COLLECT_VERSION 连续收进后剩下的份按新的资产库重新比较；撤回后再比较回来', async () => {
    const { homeDir, repoPath } = env
    const p2 = path.join(homeDir, 'work', 'proj2')
    await fs.writeFile(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: { [project]: {}, [p2]: {} } }))
    await writeSkill(path.join(project, '.claude', 'skills'), 'seq', 'version one')
    await writeSkill(path.join(p2, '.claude', 'skills'), 'seq', 'version two')
    const globalCopy = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'seq', 'version one')
    const globalTree = await readTree(globalCopy)
    let found = await copyOf('seq', (copy) => copy.projectName === 'proj')
    expect(found.item.relation).toBe('none')
    expect(found.item.copies.length).toBe(3)
    expect(found.item.peers).toBe('diff')
    const result = await collect({ skillName: 'seq', sourceId: found.copy.sourceId })
    expect(result.outcome).toBe('done')

    const snap = await snapshotOf()
    const item = snap.inbox.items.find((entry) => entry.name === 'seq')
    expect(item.relation, 'COLLECT_VERSION 收进一份后剩下的重新比较').toBe('diff')
    expect(item.copies.map((copy) => [copy.projectName, copy.relation]), 'COLLECT_VERSION 全局一样的那份退出清单').toEqual([['proj2', 'diff']])
    // 下一次确认框用的是现在的资产库：资产库摘要已更新，Claude 已链到资产库（换成这一份会连带它）
    expect(item.libraryDigest, 'COLLECT_VERSION 下一次确认框用最新的资产库摘要').toBeTruthy()
    expect(item.libraryDigest).not.toBe(found.item.libraryDigest)
    expect(item.linkedTools, 'COLLECT_VERSION 受影响的工具按现在的链接列').toContain('claude-code')
    expect(snap.skills.find((skill) => skill.name === 'seq').gate?.codex?.why, 'COLLECT_VERSION 退出清单的全局份按占位给换成链接').toBe('same')
    expect(await readTree(globalCopy), 'COLLECT_VERSION 退出清单的全局原件原样留着').toEqual(globalTree)

    await executeSkillCommand({ repoPath, homeDir, action: 'undo', operationId: result.operationId }, deps)
    found = await copyOf('seq')
    expect(found.item.relation).toBe('none')
    expect(found.item.copies.length, 'COLLECT_VERSION 撤回后再比较回来').toBe(3)
  })

  it('TC-005 COLLECT_VERSION 指向别处的链接只换链接，原件不动；全局一样的独立文件夹换成链接', async () => {
    const { homeDir, repoPath } = env
    const upstream = await writeSkill(path.join(homeDir, 'elsewhere'), 'ext-l', 'upstream body')
    const upstreamTree = await readTree(upstream)
    await link(upstream, path.join(homeDir, '.claude', 'skills', 'ext-l'))
    let found = await copyOf('ext-l')
    let result = await collect({ skillName: 'ext-l', sourceId: found.copy.sourceId })
    expect(result.outcome).toBe('done')
    expect(await readTree(path.join(repoPath, 'ext-l'))).toEqual(upstreamTree)
    expect(await isLinkTo(path.join(homeDir, '.claude', 'skills', 'ext-l'), path.join(repoPath, 'ext-l')), 'COLLECT_VERSION 链接换成指向资产库').toBe(true)
    expect(await readTree(upstream), 'COLLECT_VERSION 链接原来指向的文件夹不动').toEqual(upstreamTree)

    await writeSkill(repoPath, 'twin', 'twin body')
    const libraryTree = await readTree(path.join(repoPath, 'twin'))
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'twin', 'twin body')
    const snap = await snapshotOf()
    const gate = snap.skills.find((skill) => skill.name === 'twin').gate['claude-code']
    expect(gate.why).toBe('same')
    result = await collect({ skillName: 'twin', sourceId: gate.sourceId })
    expect(result.outcome).toBe('done')
    expect(await isLinkTo(path.join(homeDir, '.claude', 'skills', 'twin'), path.join(repoPath, 'twin')), 'COLLECT_VERSION 一样的独立文件夹换成链接').toBe(true)
    expect(await readTree(path.join(repoPath, 'twin'))).toEqual(libraryTree)
  })
})
