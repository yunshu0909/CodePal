/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：撤回
 *
 * 负责：
 * - TC-007：恢复到收进之前——新放进的删掉、换掉的放回、原来就有的不动；原件、链接、开关回到收进前；
 *   收进后新增的使用记录挪进备份不删；同名先撤后一次；资产库条目已删时只放回原件；撤回后 state=undone
 * - TC-008：撤不了的五种原因（原位置被占、资产库正文被改、动过的配置被改、资产库换了位置、备份不完整）
 *   什么都不动；只多了运行数据不算被改；这次新放进资产库而 Codex 后来也链到它 → 先确认，确认后一起拿掉
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/undo.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeCodexApi, exists, isLinkTo, link, makeHome, readClaudeSettings, readTree, writeClaudeSettings, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { getSkillControlSnapshot, executeSkillCommand } = require('../../../electron/services/skillControlService')

let env
let deps
let p1
let p2

beforeEach(async () => {
  env = await makeHome('undo')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  p1 = path.join(env.homeDir, 'work', 'p1')
  p2 = path.join(env.homeDir, 'work', 'p2')
  await fs.mkdir(p1, { recursive: true })
  await fs.mkdir(p2, { recursive: true })
  await fs.writeFile(path.join(env.homeDir, '.claude.json'), JSON.stringify({ projects: { [p1]: {}, [p2]: {} } }))
  await writeClaudeSettings(env.homeDir, { theme: 'dark' })
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
})
afterEach(async () => { await env.cleanup() })

const run = (params, repoPath = env.repoPath) => executeSkillCommand({ repoPath, homeDir: env.homeDir, ...params }, deps)
const snapshotOf = () => getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, deps)
async function copyIn(name, predicate = () => true) {
  const snap = await snapshotOf()
  return snap.inbox.items.find((item) => item.name === name).copies.find(predicate)
}
async function stateOf(operationId) {
  const snap = await snapshotOf()
  return snap.operations.find((op) => op.operationId === operationId)
}
async function collectFrom(name, predicate, extra = {}) {
  const copy = await copyIn(name, predicate)
  return run({ action: 'collect', skillName: name, sourceId: copy.sourceId, ...extra })
}
const claudeIn = (project) => path.join(project, '.claude', 'skills')
const overrideOf = async (name) => (await readClaudeSettings(env.homeDir)).skillOverrides?.[name]

describe('撤回恢复到收进之前', () => {
  it('TC-007 UNDO_RESTORE 资产库没有的：资产库删掉、原件放回、链接与开关回到收进前', async () => {
    const original = await writeSkill(claudeIn(p1), 'fresh', 'fresh body', { 'scripts/a.sh': 'echo a' })
    const originalTree = await readTree(original)
    const { operationId } = await collectFrom('fresh')
    const result = await run({ action: 'undo', operationId })
    expect(result.outcome, 'UNDO_RESTORE 撤回应成功').toBe('done')
    expect(await exists(path.join(env.repoPath, 'fresh')), 'UNDO_RESTORE 这次新放进的应删掉').toBe(false)
    expect(await readTree(original), 'UNDO_RESTORE 原件应逐字放回').toEqual(originalTree)
    expect(await exists(path.join(env.homeDir, '.claude', 'skills', 'fresh'))).toBe(false)
    expect(await overrideOf('fresh'), 'UNDO_RESTORE 开关回到收进前').toBeUndefined()
    expect((await readClaudeSettings(env.homeDir)).theme).toBe('dark')
    expect((await stateOf(operationId)).state).toBe('undone')
  })

  it('TC-007 UNDO_RESTORE 留资产库的不动资产库；换成这一份的放回旧版', async () => {
    await writeSkill(env.repoPath, 'kept', 'library v1')
    const keptTree = await readTree(path.join(env.repoPath, 'kept'))
    const keptSource = await writeSkill(claudeIn(p1), 'kept', 'project v2')
    const keptSourceTree = await readTree(keptSource)
    let op = await collectFrom('kept', () => true, { keep: 'library' })
    await run({ action: 'undo', operationId: op.operationId })
    expect(await readTree(path.join(env.repoPath, 'kept')), 'UNDO_RESTORE 原来就有的不动').toEqual(keptTree)
    expect(await readTree(keptSource)).toEqual(keptSourceTree)

    await writeSkill(env.repoPath, 'swap', 'library v1')
    const swapOld = await readTree(path.join(env.repoPath, 'swap'))
    const swapSource = await writeSkill(claudeIn(p1), 'swap', 'project v2')
    const swapSourceTree = await readTree(swapSource)
    op = await collectFrom('swap', () => true, { keep: 'source' })
    await run({ action: 'undo', operationId: op.operationId })
    expect(await readTree(path.join(env.repoPath, 'swap')), 'UNDO_RESTORE 换掉的旧版放回').toEqual(swapOld)
    expect(await readTree(swapSource)).toEqual(swapSourceTree)
  })

  it('TC-007 UNDO_RESTORE 全局来源：链接换回原来的文件夹；指向别处的链接换回原链接', async () => {
    const globalDir = await writeSkill(path.join(env.homeDir, '.claude', 'skills'), 'g-none', 'global body')
    const globalTree = await readTree(globalDir)
    let op = await collectFrom('g-none')
    await run({ action: 'undo', operationId: op.operationId })
    expect(await readTree(globalDir), 'UNDO_RESTORE 全局文件夹放回').toEqual(globalTree)

    const upstream = await writeSkill(path.join(env.homeDir, 'elsewhere'), 'g-link', 'upstream')
    const linkPath = await link(upstream, path.join(env.homeDir, '.claude', 'skills', 'g-link'))
    op = await collectFrom('g-link')
    await run({ action: 'undo', operationId: op.operationId })
    expect(await isLinkTo(linkPath, upstream), 'UNDO_RESTORE 原链接放回').toBe(true)
  })

  it('TC-007 UNDO_RESTORE 收进后换一个全新的服务实例：只靠磁盘上的记录与备份照样撤回', async () => {
    const original = await writeSkill(claudeIn(p1), 'reboot', 'reboot body')
    const originalTree = await readTree(original)
    const { operationId } = await collectFrom('reboot')
    // 清掉进程里主进程模块的全部状态（相当于重启 CodePal），重新加载
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}electron${path.sep}`)) delete require.cache[key]
    }
    const fresh = require('../../../electron/services/skillControlService')
    const snap = await fresh.getSkillControlSnapshot({ repoPath: env.repoPath, homeDir: env.homeDir }, deps)
    expect(snap.operations.find((op) => op.operationId === operationId)?.state, 'UNDO_RESTORE 重启后记录仍可撤回').toBe('undoable')
    const result = await fresh.executeSkillCommand({ repoPath: env.repoPath, homeDir: env.homeDir, action: 'undo', operationId }, deps)
    expect(result.outcome).toBe('done')
    expect(await readTree(original)).toEqual(originalTree)
    expect(await exists(path.join(env.repoPath, 'reboot'))).toBe(false)
  })

  it('TC-007 UNDO_RESTORE Claude 这一项原来没写或只手动调用：收进后为开，撤回后原样回来，无关设置不变', async () => {
    await writeClaudeSettings(env.homeDir, { theme: 'dark', skillOverrides: { manual: 'user-invocable-only', other: 'off' } })
    await writeSkill(claudeIn(p1), 'manual', 'manual body')
    await writeSkill(claudeIn(p1), 'unset', 'unset body')
    const manualOp = await collectFrom('manual')
    const unsetOp = await collectFrom('unset')
    expect(await overrideOf('manual')).toBe('on')
    expect(await overrideOf('unset')).toBe('on')
    await run({ action: 'undo', operationId: manualOp.operationId })
    await run({ action: 'undo', operationId: unsetOp.operationId })
    const settings = await readClaudeSettings(env.homeDir)
    expect(settings.skillOverrides.manual, 'UNDO_RESTORE 只手动调用原样回来').toBe('user-invocable-only')
    expect(Object.prototype.hasOwnProperty.call(settings.skillOverrides, 'unset'), 'UNDO_RESTORE 原来没写的撤回后仍没写').toBe(false)
    expect(settings.skillOverrides.other).toBe('off')
    expect(settings.theme).toBe('dark')
  })

  it('TC-007 UNDO_RESTORE 收进后新增的使用记录挪进备份不删', async () => {
    await writeSkill(claudeIn(p1), 'used', 'used body')
    const { operationId } = await collectFrom('used')
    await fs.mkdir(path.join(env.repoPath, 'used', '.codepal'), { recursive: true })
    await fs.writeFile(path.join(env.repoPath, 'used', '.codepal', 'runs.jsonl'), '{"run":1}\n')
    const result = await run({ action: 'undo', operationId })
    expect(result.outcome).toBe('done')
    const saved = await readTree(path.join(env.dataDir, 'backups', operationId))
    expect(Object.entries(saved).some(([key, value]) => key.endsWith('runs.jsonl') && value === '{"run":1}\n'), 'UNDO_RESTORE 使用记录应挪进备份').toBe(true)
  })

  it('TC-007 UNDO_RESTORE 同名先撤后一次；资产库条目已删只放回原件', async () => {
    const a = await writeSkill(claudeIn(p1), 'dup', 'dup body')
    await writeSkill(claudeIn(p2), 'dup', 'dup body')
    const first = await collectFrom('dup', (copy) => copy.projectName === 'p1')
    const second = await collectFrom('dup', (copy) => copy.projectName === 'p2')
    expect((await stateOf(first.operationId)).state, 'UNDO_RESTORE 前一次应等后一次').toBe('waiting')
    expect((await stateOf(second.operationId)).state).toBe('undoable')
    await run({ action: 'undo', operationId: second.operationId })
    expect((await stateOf(first.operationId)).state).toBe('undoable')

    const aTree = { 'SKILL.md': '---\nname: dup\ndescription: dup body\n---\n\ndup body\n' }
    await run({ action: 'delete', toolId: 'all', skillName: 'dup' })
    expect((await stateOf(first.operationId)).state, 'UNDO_RESTORE 资产库删了').toBe('library-deleted')
    const result = await run({ action: 'undo', operationId: first.operationId })
    expect(result.outcome).toBe('done')
    expect(await readTree(a), 'UNDO_RESTORE 资产库已删只放回原件').toEqual(aTree)
    expect(await exists(path.join(env.repoPath, 'dup'))).toBe(false)
  })
})

describe('撤不了与连带确认', () => {
  async function blockedReason(operationId, repoPath) {
    let error = null
    try { await run({ action: 'undo', operationId }, repoPath) } catch (caught) { error = caught }
    return error
  }

  it('TC-008 UNDO_GUARD 五种撤不了的原因，什么都不动；只多了运行数据不算被改', async () => {
    // 原位置被占
    const occupied = await writeSkill(claudeIn(p1), 'occ', 'occ body')
    let op = await collectFrom('occ')
    await writeSkill(claudeIn(p1), 'occ', 'someone put a new one here')
    let before = await readTree(env.homeDir)
    let error = await blockedReason(op.operationId)
    expect(error?.code, 'UNDO_GUARD 原位置被占').toBe('UNDO_BLOCKED')
    expect(error?.reason).toBe('source-occupied')
    expect((await stateOf(op.operationId)).state).toBe('blocked')
    expect(await readTree(env.homeDir)).toEqual(before)
    await fs.rm(occupied, { recursive: true, force: true })

    // 资产库正文被改；只多了运行数据不算
    await writeSkill(claudeIn(p1), 'edited', 'edited body')
    op = await collectFrom('edited')
    await fs.mkdir(path.join(env.repoPath, 'edited', 'evolution'), { recursive: true })
    await fs.writeFile(path.join(env.repoPath, 'edited', 'evolution', 'note.md'), 'grown')
    expect((await stateOf(op.operationId)).state, 'UNDO_GUARD 运行数据不挡撤回').toBe('undoable')
    await fs.writeFile(path.join(env.repoPath, 'edited', 'SKILL.md'), 'edited later')
    error = await blockedReason(op.operationId)
    expect(error?.reason, 'UNDO_GUARD 资产库正文被改').toBe('library-changed')

    // 动过的配置被改
    await writeSkill(claudeIn(p1), 'cfg', 'cfg body')
    op = await collectFrom('cfg')
    const settings = await readClaudeSettings(env.homeDir)
    settings.skillOverrides.cfg = 'off'
    await writeClaudeSettings(env.homeDir, settings)
    error = await blockedReason(op.operationId)
    expect(error?.reason, 'UNDO_GUARD 配置被改').toBe('config-changed')

    // 资产库换了位置
    await writeSkill(claudeIn(p1), 'moved', 'moved body')
    op = await collectFrom('moved')
    const otherRepo = path.join(env.homeDir, 'OtherLibrary')
    await fs.mkdir(otherRepo, { recursive: true })
    error = await blockedReason(op.operationId, otherRepo)
    expect(error?.reason, 'UNDO_GUARD 资产库换了位置').toBe('library-moved')

    // 备份不完整
    await writeSkill(claudeIn(p1), 'broken', 'broken body', { 'b.md': 'b' })
    op = await collectFrom('broken')
    await fs.rm(path.join(env.dataDir, 'backups', op.operationId, 'source', 'b.md'))
    before = await readTree(env.repoPath)
    error = await blockedReason(op.operationId)
    expect(error?.reason, 'UNDO_GUARD 备份不完整').toBe('backup-incomplete')
    expect(await readTree(env.repoPath)).toEqual(before)
  })

  it('TC-008 UNDO_GUARD 全局来源收进后链接被换掉（换成文件夹、换成指向别处的链接、Codex 规范位置被换）：不撤、什么都不动', async () => {
    const claudeRoot = path.join(env.homeDir, '.claude', 'skills')
    const cases = [
      ['g-folder', async (slot) => { await fs.unlink(slot); await writeSkill(claudeRoot, 'g-folder', 'someone else') }, 'source-occupied'],
      ['g-other-link', async (slot) => { await fs.unlink(slot); await link(await writeSkill(path.join(env.homeDir, 'other'), 'g-other-link', 'other'), slot) }, 'source-occupied'],
    ]
    for (const [name, mutate, reason] of cases) {
      await writeSkill(claudeRoot, name, `${name} body`)
      const { operationId } = await collectFrom(name)
      await mutate(path.join(claudeRoot, name))
      const before = await readTree(env.homeDir)
      const error = await blockedReason(operationId)
      expect(error?.code, `UNDO_GUARD ${name} 应不撤`).toBe('UNDO_BLOCKED')
      expect(error?.reason).toBe(reason)
      expect(await readTree(env.homeDir), `UNDO_GUARD ${name} 什么都不动`).toEqual(before)
    }
    // Codex：原件在兼容目录，链接建在 ~/.agents/skills；之后规范位置被换成文件夹
    await writeSkill(path.join(env.homeDir, '.codex', 'skills'), 'cx-moved', 'cx body')
    const { operationId } = await collectFrom('cx-moved')
    const official = path.join(env.homeDir, '.agents', 'skills', 'cx-moved')
    await fs.unlink(official)
    await writeSkill(path.join(env.homeDir, '.agents', 'skills'), 'cx-moved', 'replaced')
    const before = await readTree(env.homeDir)
    const error = await blockedReason(operationId)
    expect(error?.reason, 'UNDO_GUARD Codex 规范位置被换').toBe('slot-changed')
    expect(await readTree(env.homeDir)).toEqual(before)
  })

  it('TC-008 UNDO_GUARD 新放进资产库而 Codex 后来也链到它：先确认，确认后一起拿掉', async () => {
    const original = await writeSkill(claudeIn(p1), 'shared', 'shared body')
    const originalTree = await readTree(original)
    const { operationId } = await collectFrom('shared')
    await run({ action: 'enable', toolId: 'codex', skillName: 'shared' })
    const codexLink = path.join(env.homeDir, '.agents', 'skills', 'shared')
    expect(await isLinkTo(codexLink, path.join(env.repoPath, 'shared'))).toBe(true)

    const before = await readTree(env.homeDir)
    const first = await run({ action: 'undo', operationId })
    expect(first.outcome, 'UNDO_GUARD 要先确认').toBe('needs-confirm')
    expect(first.needsConfirm.toolIds).toEqual(['codex'])
    expect(await readTree(env.homeDir), 'UNDO_GUARD 没确认前什么都不动').toEqual(before)

    const confirmed = await run({ action: 'undo', operationId, confirmed: true })
    expect(confirmed.outcome).toBe('done')
    expect(await exists(path.join(env.repoPath, 'shared'))).toBe(false)
    expect(await exists(codexLink), 'UNDO_GUARD Codex 的链接一起拿掉').toBe(false)
    expect(await readTree(original)).toEqual(originalTree)
  })
})
