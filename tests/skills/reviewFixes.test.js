/**
 * 代码审核（lite.G1 第 1 轮）指出的问题的回归测试（specs/skills-redesign-dev2 TC-051、052、054、055）
 *
 * 负责：
 * - 「两份」只在 Codex 的两个个人目录之间算，同步来的、旧命令同名不算
 * - 装载汇总按来源分桶：claude.ai 同步只数 synced，旧命令不算进 Skill 装载与 tokens
 * - config.toml 不是合法 TOML 时补关直接放弃：一条不写、文件不变，读快照照常
 * - Codex 没列出的那一份：开关直接失败（NOT_IN_CODEX），什么都不写
 * - 全部在 mkdtemp 临时 HOME；Codex 一侧用注入的接口或空适配器，不起真实 Codex
 *
 * @module tests/skills/reviewFixes.test
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire as createLastViewRequire } from 'node:module'

const { whenLastViewIdle } = createLastViewRequire(import.meta.url)('../../electron/modules/skills/lastViewStore')

const require = createRequire(import.meta.url)
const service = require('../../electron/services/skillControlService')
const codex = require('../../electron/services/skillAdapters/codexSkillAdapter')
const { registerSkillControlHandlers } = require('../../electron/handlers/registerSkillControlHandlers')

let sandbox
let homeDir
let repoPath

async function writeSkill(root, name, description = name) {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`)
  return dir
}

// 只看 Claude 一侧时，Codex 用一个什么都没有的适配器，不起真实 Codex
const noCodex = { codexAdapter: { discover: async () => ({ toolId: 'codex', sources: [], errors: [] }) }, skipPluginDiscovery: true }
const byName = (snap, name) => snap.skills.find((skill) => skill.name === name)

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-review-fixes-'))
  homeDir = path.join(sandbox, 'home')
  repoPath = path.join(sandbox, 'catalog')
  await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true })
  await fs.mkdir(repoPath, { recursive: true })
})

afterEach(async () => {
  // #101 读快照后会在后台存一份「上次的」：等它写完再删临时目录
  await whenLastViewIdle()
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe('审核修复：快照口径', () => {
  it('TC-051 DUPLICATE_SCOPE Claude 个人与 claude.ai 同步同名、内容不同：不算两份', async () => {
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'pptx', 'mine')
    await writeSkill(path.join(homeDir, '.claude', 'skills', 'synced', 'acct'), 'pptx', 'synced one')
    const snap = await service.getSkillControlSnapshot({ repoPath, homeDir }, noCodex)
    expect(byName(snap, 'pptx').tools['claude-code'].duplicate).toBe(false)
  })

  it('TC-052 LOAD_BY_ORIGIN 旧命令不算进 claude.ai 同步，也不算进 Skill 装载与 tokens', async () => {
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'mine', 'a'.repeat(10))
    await writeSkill(path.join(homeDir, '.claude', 'skills', 'synced', 'acct'), 'pptx', 'b'.repeat(20))
    await fs.mkdir(path.join(homeDir, '.claude', 'commands'), { recursive: true })
    await fs.writeFile(path.join(homeDir, '.claude', 'commands', 'old-command.md'), '# old command\n')
    const snap = await service.getSkillControlSnapshot({ repoPath, homeDir }, noCodex)
    expect(byName(snap, 'old-command')).toBeTruthy()
    expect(snap.tools['claude-code'].load).toMatchObject({ personal: 1, synced: 1, total: 2 })
    // mine: 名字 4 + 说明 10；pptx: 名字 4 + 说明 20
    expect(snap.tools['claude-code'].load.tokens).toBe(Math.round(38 / 3.5))
  })
})

describe('审核修复：Codex', () => {
  it('TC-054 LEGACY_INVALID_TOML config.toml 不是合法 TOML：补关一条不写、文件不变，读快照照常', async () => {
    const configPath = path.join(homeDir, '.codex', 'config.toml')
    const broken = '[[skills.config]\npath = "/x"\nenabled = false\n'
    await fs.writeFile(configPath, broken)
    const api = { list: vi.fn(async () => []), write: vi.fn(async () => ({ effectiveEnabled: false })) }

    const result = await codex.migrateLegacyCodexDisables({ homeDir }, { codexSkillApi: api })
    expect(result.status).toBe('failed')
    expect(api.write).not.toHaveBeenCalled()
    expect(await fs.readFile(configPath, 'utf8')).toBe(broken)

    const handlers = {}
    registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir }, { codexSkillApi: api, skipPluginDiscovery: true })
    const snapshot = await handlers['skill-control:get-snapshot'](null, { repoPath })
    expect(snapshot.success).toBe(true)
    expect(await fs.readFile(configPath, 'utf8')).toBe(broken)
  })

  it('TC-055 NOT_IN_CODEX Codex 没列出的那一份：开关直接失败，什么都不写', async () => {
    const skillDir = await writeSkill(path.join(homeDir, '.codex', 'skills'), 'shadowed')
    const api = { list: vi.fn(async () => []), write: vi.fn(async () => ({ effectiveEnabled: false })) }
    await expect(codex.applyCodexCommand({ homeDir, repoPath, skillName: 'shadowed', action: 'disable', source: { absolutePath: skillDir } }, { codexSkillApi: api }))
      .rejects.toMatchObject({ code: 'NOT_IN_CODEX' })
    expect(api.write).not.toHaveBeenCalled()
  })
})
