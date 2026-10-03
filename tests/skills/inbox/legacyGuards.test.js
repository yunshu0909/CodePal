/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：既有行为的回归守卫
 *
 * 负责（都是保持现状，这次改动不能弄坏）：
 * - TC-020：开关写入与核对——Claude 从资产库启用后全局目录有指向资产库的链接、设置为开，停用后为关；
 *   Codex 停用、启用各写一次并按接口核对
 * - TC-021：删除连带——从资产库删除时资产库那份、Claude 与 Codex 里指向它的链接一起删，无关 Skill 不动
 * - TC-022：只读来源拒绝——Codex 系统自带的停用报 ORIGIN_READ_ONLY，没有写入、config.toml 没被创建
 * - TC-023：读快照不写——读快照不改 Claude 设置、不建 config.toml、不建 CodePal 数据目录
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/legacyGuards.test
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

beforeEach(async () => {
  env = await makeHome('guards')
  await fs.mkdir(path.join(env.homeDir, '.codex'), { recursive: true })
  deps = { codexSkillApi: createFakeCodexApi({ homeDir: env.homeDir }) }
})
afterEach(async () => { await env.cleanup() })

describe('既有行为守卫', () => {
  it('TC-020 Claude 启用→停用、Codex 停用→启用照旧写入并核对', async () => {
    const { homeDir, repoPath } = env
    await writeSkill(repoPath, 'tool-a', 'tool a')
    await writeClaudeSettings(homeDir, { theme: 'dark' })
    await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'tool-a', action: 'enable' }, deps)
    expect(await isLinkTo(path.join(homeDir, '.claude', 'skills', 'tool-a'), path.join(repoPath, 'tool-a'))).toBe(true)
    expect((await readClaudeSettings(homeDir)).skillOverrides['tool-a']).toBe('on')
    await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'tool-a', action: 'disable' }, deps)
    const settings = await readClaudeSettings(homeDir)
    expect(settings.skillOverrides['tool-a']).toBe('off')
    expect(settings.theme).toBe('dark')

    await link(path.join(repoPath, 'tool-a'), path.join(homeDir, '.agents', 'skills', 'tool-a'))
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'tool-a', action: 'disable' }, deps)
    await executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'tool-a', action: 'enable' }, deps)
    const writes = deps.codexSkillApi.calls.filter((call) => call.op === 'write')
    expect(writes.map((call) => call.enabled)).toEqual([false, true])
  })

  it('TC-021 从资产库删除：资产库与指向它的链接一起删，无关 Skill 不动', async () => {
    const { homeDir, repoPath } = env
    await writeSkill(repoPath, 'gone-soon', 'bye')
    await writeSkill(repoPath, 'keeper', 'stay')
    await link(path.join(repoPath, 'gone-soon'), path.join(homeDir, '.claude', 'skills', 'gone-soon'))
    await link(path.join(repoPath, 'gone-soon'), path.join(homeDir, '.agents', 'skills', 'gone-soon'))
    await link(path.join(repoPath, 'keeper'), path.join(homeDir, '.claude', 'skills', 'keeper'))
    await executeSkillCommand({ repoPath, homeDir, toolId: 'all', skillName: 'gone-soon', action: 'delete' }, deps)
    expect(await exists(path.join(repoPath, 'gone-soon'))).toBe(false)
    expect(await exists(path.join(homeDir, '.claude', 'skills', 'gone-soon'))).toBe(false)
    expect(await exists(path.join(homeDir, '.agents', 'skills', 'gone-soon'))).toBe(false)
    expect(await isLinkTo(path.join(homeDir, '.claude', 'skills', 'keeper'), path.join(repoPath, 'keeper'))).toBe(true)
  })

  it('TC-022 Codex 系统自带的停用报 ORIGIN_READ_ONLY，什么都没写', async () => {
    const { homeDir, repoPath } = env
    await writeSkill(path.join(homeDir, '.codex', 'skills', '.system'), 'imagegen', 'system')
    const code = await codeOf(executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'imagegen', action: 'disable' }, deps))
    expect(code).toBe('ORIGIN_READ_ONLY')
    expect(deps.codexSkillApi.calls.filter((call) => call.op === 'write')).toEqual([])
    expect(await exists(path.join(homeDir, '.codex', 'config.toml'))).toBe(false)
  })

  it('TC-023 读快照不改设置、不建 config.toml、不建 CodePal 数据目录', async () => {
    const { homeDir, repoPath } = env
    await writeSkill(repoPath, 'lib-one', 'lib')
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'outside', 'outside')
    await writeClaudeSettings(homeDir, { skillOverrides: { 'lib-one': 'off' } })
    const before = await readTree(path.join(homeDir, '.claude'))
    await getSkillControlSnapshot({ repoPath, homeDir, projectRoots: [] }, deps)
    expect(await readTree(path.join(homeDir, '.claude'))).toEqual(before)
    expect(await exists(path.join(homeDir, '.codex', 'config.toml'))).toBe(false)
    expect(await exists(env.dataDir)).toBe(false)
  })
})
