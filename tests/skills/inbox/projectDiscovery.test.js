/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：找项目
 *
 * 负责：
 * - TC-001：从 ~/.claude.json 的 projects 与 Codex 会话第一行的 cwd 找用过的项目；家目录、临时目录、
 *   没有 skills 的、已删掉的不出现；读不了的写原因；scanned 是去重后看过的目录数；只读会话第一行
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/projectDiscovery.test
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { makeHome, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
// 在用例里才加载：模块还不存在时（先写测试阶段）只让用例失败，输出里照样带用例名
const discoverProjects = (...args) => require('../../../electron/modules/skills/projectDiscovery').discoverProjects(...args)
const buildInbox = (...args) => require('../../../electron/modules/skills/inboxScan').buildInbox(...args)

let env
let outside
let locked

beforeEach(async () => {
  env = await makeHome('projects')
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-inbox-outside-'))
})

afterEach(async () => {
  if (locked) await fs.chmod(locked, 0o755).catch(() => {})
  locked = null
  await env.cleanup()
  await fs.rm(outside, { recursive: true, force: true })
})

async function writeSession(homeDir, file, lines) {
  const target = path.join(homeDir, '.codex', 'sessions', '2026', '10', '03', file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'))
}

describe('找项目', () => {
  it('TC-001 PROJECT_DISCOVERY 只留真有 skills 目录的项目，家目录、临时目录、空目录、已删掉的不出现，读不了的写原因', async () => {
    const { homeDir } = env
    const work = path.join(homeDir, 'Documents', 'work')
    const alpha = path.join(work, 'alpha')
    const beta = path.join(work, 'beta')
    const empty = path.join(work, 'empty')
    const gone = path.join(work, 'gone')
    const gamma = path.join(work, 'gamma')
    const locky = path.join(work, 'locky')
    const second = path.join(work, 'second-line-only')
    await writeSkill(path.join(alpha, '.claude', 'skills'), 'alpha-skill')
    await writeSkill(path.join(beta, '.agents', 'skills'), 'beta-skill')
    await fs.mkdir(empty, { recursive: true })
    await writeSkill(path.join(gamma, '.codex', 'skills'), 'gamma-skill')
    await writeSkill(path.join(locky, '.claude', 'skills'), 'locky-skill')
    await writeSkill(path.join(second, '.claude', 'skills'), 'second-skill')
    // 家目录外的临时目录：就算有 skills 也不算项目
    await writeSkill(path.join(outside, '.claude', 'skills'), 'scratch-skill')
    // 家目录本身也有 .claude/skills（全局目录），不能当成项目
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'global-skill')

    await fs.writeFile(path.join(homeDir, '.claude.json'), JSON.stringify({
      projects: { [alpha]: {}, [beta]: {}, [empty]: {}, [gone]: {}, [homeDir]: {}, [locky]: {} },
    }))
    await writeSession(homeDir, 'rollout-a.jsonl', [
      { type: 'session_meta', payload: { cwd: gamma } },
      { type: 'response_item', payload: { cwd: second } },
    ])
    await writeSession(homeDir, 'rollout-b.jsonl', [{ type: 'session_meta', payload: { cwd: outside } }])
    await writeSession(homeDir, 'rollout-c.jsonl', [{ type: 'session_meta', payload: { cwd: alpha } }])
    await writeSession(homeDir, 'rollout-d.jsonl', ['not json at all'])

    locked = path.join(locky, '.claude', 'skills')
    await fs.chmod(locked, 0o000)

    const found = await discoverProjects({ homeDir }, {})
    const byName = Object.fromEntries(found.projects.map((project) => [project.name, project]))
    expect(Object.keys(byName).sort(), 'PROJECT_DISCOVERY 找到的项目不对').toEqual(['alpha', 'beta', 'gamma', 'locky'])
    expect(found.scanned, 'PROJECT_DISCOVERY scanned 应是去重后看过的目录数').toBe(8)
    expect(byName.alpha.displayPath).toBe('~/Documents/work/alpha')
    expect(byName.alpha.roots.map((root) => root.toolId)).toEqual(['claude-code'])
    expect(byName.beta.roots.map((root) => root.toolId)).toEqual(['codex'])
    expect(byName.gamma.roots.map((root) => root.toolId)).toEqual(['codex'])
    expect(byName.locky.error, 'PROJECT_DISCOVERY 读不了的要写原因').toBe('PERMISSION_DENIED')
    expect(byName.alpha.error ?? null).toBeNull()

    const inbox = await buildInbox({ homeDir, repoPath: env.repoPath, projects: found, ignores: [] }, {})
    const counts = Object.fromEntries(inbox.projects.found.map((project) => [project.name, project.copies]))
    expect(counts, 'PROJECT_DISCOVERY 每个项目要带份数').toEqual({ alpha: 1, beta: 1, gamma: 1, locky: 0 })
    expect(inbox.projects.scanned).toBe(8)
    expect(inbox.projects.found.find((project) => project.name === 'locky').error).toBe('PERMISSION_DENIED')
  })
})
