/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：要处理清单
 *
 * 负责：
 * - TC-002：全局目录里资产库没有的、不一样的，项目里的每一份进清单；一样的全局份、指向资产库的链接、
 *   系统自带、claude.ai 同步、忽略过的不进；运行数据不参与比较；差异文件 SKILL.md 第一、脚本其次；
 *   同名都不在资产库时比较彼此；Codex 项目里 SKILL.md 不同的标适配提醒；排序
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/inboxScan.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { link, makeHome, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
// 在用例里才加载：模块还不存在时（先写测试阶段）只让用例失败，输出里照样带用例名
const discoverProjects = (...args) => require('../../../electron/modules/skills/projectDiscovery').discoverProjects(...args)
const buildInbox = (...args) => require('../../../electron/modules/skills/inboxScan').buildInbox(...args)

let env

beforeEach(async () => { env = await makeHome('scan') })
afterEach(async () => { await env.cleanup() })

describe('要处理清单', () => {
  it('TC-002 INBOX_SCAN 进清单的、不进的、关系与差异、彼此比较、适配提醒、排序', async () => {
    const { homeDir, repoPath } = env
    const claudeGlobal = path.join(homeDir, '.claude', 'skills')
    const agents = path.join(homeDir, '.agents', 'skills')
    const legacy = path.join(homeDir, '.codex', 'skills')
    const p1 = path.join(homeDir, 'work', 'p1')
    const p2 = path.join(homeDir, 'work', 'p2')

    // 资产库
    await writeSkill(repoPath, 'same-g', 'same body')
    await writeSkill(repoPath, 'diff-g', 'library body', { 'scripts/run.sh': 'echo lib', 'ref/a.md': 'ref a' })
    await writeSkill(repoPath, 'linked', 'linked body')
    await writeSkill(repoPath, 'runtime-only', 'rt body')

    // 全局 Claude
    await writeSkill(claudeGlobal, 'same-g', 'same body')
    await writeSkill(claudeGlobal, 'diff-g', 'changed body', { 'scripts/run.sh': 'echo changed', 'notes.md': 'extra' })
    await link(path.join(repoPath, 'linked'), path.join(claudeGlobal, 'linked'))
    await writeSkill(claudeGlobal, 'runtime-only', 'rt body', {
      '.DS_Store': 'x', '__pycache__/m.cpython-312.pyc': 'bytecode', 'tool.pyc': 'bc',
      '.codepal/skill-runs.jsonl': '{}', 'evolution/notes.md': 'grown', 'log.jsonl': '{}',
    })
    await writeSkill(claudeGlobal, 'only-g', 'only here')
    await writeSkill(path.join(claudeGlobal, 'synced', 'acct'), 'synced-one', 'from claude.ai')

    // 全局 Codex
    await writeSkill(agents, 'agents-none', 'agents')
    await writeSkill(legacy, 'legacy-none', 'legacy')
    await writeSkill(path.join(legacy, '.system'), 'sys', 'system')

    // 项目
    await writeSkill(path.join(p1, '.claude', 'skills'), 'same-g', 'same body')
    await writeSkill(path.join(p1, '.claude', 'skills'), 'proj-twin', 'twin body')
    await writeSkill(path.join(p1, '.claude', 'skills'), 'peer-diff', 'peer one')
    await writeSkill(path.join(p1, '.claude', 'skills'), 'ignored-one', 'ignore me')
    await writeSkill(path.join(p2, '.agents', 'skills'), 'proj-twin', 'twin body')
    await writeSkill(path.join(p2, '.agents', 'skills'), 'peer-diff', 'peer two')
    await writeSkill(path.join(p2, '.agents', 'skills'), 'diff-g', 'codex adapted body', { 'scripts/run.sh': 'echo lib', 'ref/a.md': 'ref a' })

    await fs.writeFile(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: { [p1]: {}, [p2]: {} } }))
    const projects = await discoverProjects({ homeDir }, {})
    const ignores = [{ toolId: 'claude-code', absolutePath: path.join(p1, '.claude', 'skills', 'ignored-one') }]
    const inbox = await buildInbox({ homeDir, repoPath, projects, ignores }, {})

    const names = inbox.items.map((item) => item.name)
    expect(names, 'INBOX_SCAN 清单与排序不对').toEqual(['diff-g', 'same-g', 'agents-none', 'legacy-none', 'only-g', 'peer-diff', 'proj-twin'])
    const byName = Object.fromEntries(inbox.items.map((item) => [item.name, item]))

    expect(byName['diff-g'].relation).toBe('diff')
    expect(byName['same-g'].relation).toBe('same')
    expect(byName['only-g'].relation).toBe('none')

    const globalDiff = byName['diff-g'].copies.find((copy) => copy.scope === 'global')
    expect(globalDiff.toolId).toBe('claude-code')
    expect(globalDiff.displayPath).toBe('~/.claude/skills/diff-g')
    expect(globalDiff.sourceId).toMatch(/^src_[0-9a-f]{16}$/)
    expect(globalDiff.relation).toBe('diff')
    expect(globalDiff.diff.added, 'INBOX_SCAN 多出的文件').toEqual(['notes.md'])
    expect(globalDiff.diff.removed, 'INBOX_SCAN 少了的文件').toEqual(['ref/a.md'])
    expect(globalDiff.diff.changed, 'INBOX_SCAN 改了的文件要 SKILL.md 第一、脚本其次').toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(globalDiff.adaptedHint).toBe(false)

    const codexDiff = byName['diff-g'].copies.find((copy) => copy.scope === 'project')
    expect(codexDiff.toolId).toBe('codex')
    expect(codexDiff.projectName).toBe('p2')
    expect(codexDiff.diff.changed).toEqual(['SKILL.md'])
    expect(codexDiff.adaptedHint, 'INBOX_SCAN Codex 项目里 SKILL.md 不同要标适配提醒').toBe(true)

    // 项目里和资产库一样的照样进清单（A5），全局一样的不进
    expect(byName['same-g'].copies.map((copy) => copy.scope)).toEqual(['project'])
    expect(byName['same-g'].copies[0].relation).toBe('same')

    expect(byName['agents-none'].copies[0]).toMatchObject({ toolId: 'codex', scope: 'global', displayPath: '~/.agents/skills/agents-none' })
    expect(byName['legacy-none'].copies[0]).toMatchObject({ toolId: 'codex', scope: 'global', displayPath: '~/.codex/skills/legacy-none' })

    expect(byName['proj-twin'].peers, 'INBOX_SCAN 同名都不在资产库的两份内容一样').toBe('same')
    expect(byName['peer-diff'].peers, 'INBOX_SCAN 同名都不在资产库的两份内容不一样').toBe('diff')
    expect(byName['only-g'].peers ?? null).toBeNull()

    // 每份都不带绝对路径
    for (const item of inbox.items) {
      for (const copy of item.copies) {
        expect(JSON.stringify(copy)).not.toContain(homeDir)
      }
    }
  })
})
