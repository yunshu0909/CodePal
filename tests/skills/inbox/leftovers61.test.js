/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）：#61 挪来的小修
 *
 * 负责：
 * - TC-016：第二层配置 repoPath 显式写成空字符串或 null 时退回那一层自己的位置（没写 repoPath 仍落回默认）；
 *   chokidar 依赖与 README 那一行去掉；只有只读来源、资产库也没有的 Codex Skill 启用报 ORIGIN_READ_ONLY 且没补关；
 *   toolId=claude-code 的删除会动到 Codex 目录时先补关；readManagedSettings 注释写返回 {data, unknown}
 * 所有写入只在临时家目录。
 *
 * @module tests/skills/inbox/leftovers61.test
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { codeOf, createFakeCodexApi, link, makeHome, writeSkill } from './helpers.js'

const require = createRequire(import.meta.url)
const { resolveSkillRepoPath } = require('../../../electron/services/skillRepoPath')
const { executeSkillCommand } = require('../../../electron/services/skillControlService')

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = (relative) => fs.readFile(path.join(ROOT, relative), 'utf8')

let env

beforeEach(async () => { env = await makeHome('left61') })
afterEach(async () => { await env.cleanup() })

describe('#61 挪来的小修', () => {
  it('TC-016 LEFTOVERS_61 第二层配置 repoPath 为空字符串或 null 时退回那一层自己的位置', async () => {
    const { homeDir, repoPath } = env
    const second = path.join(homeDir, 'Elsewhere', 'Lib')
    await fs.mkdir(second, { recursive: true })
    await fs.writeFile(path.join(repoPath, '.config.json'), JSON.stringify({ repoPath: second }))
    for (const value of ['', null]) {
      await fs.writeFile(path.join(second, '.config.json'), JSON.stringify({ repoPath: value }))
      expect(await resolveSkillRepoPath({ homeDir }), `LEFTOVERS_61 repoPath=${JSON.stringify(value)} 应退回那一层`).toBe(`${second}/`)
    }
    // 没写 repoPath 仍照旧落回默认位置
    await fs.writeFile(path.join(second, '.config.json'), JSON.stringify({ theme: 'x' }))
    expect(await resolveSkillRepoPath({ homeDir })).toBe('~/Documents/SkillManager/')
  })

  it('TC-016 LEFTOVERS_61 chokidar 依赖与 README 那一行去掉；readManagedSettings 注释写对', async () => {
    const pkg = JSON.parse(await read('package.json'))
    const lock = JSON.parse(await read('package-lock.json'))
    expect(pkg.dependencies?.chokidar, 'LEFTOVERS_61 package.json 不应再有 chokidar').toBeUndefined()
    expect(pkg.devDependencies?.chokidar).toBeUndefined()
    expect(lock.packages[''].dependencies?.chokidar, 'LEFTOVERS_61 lock 根包不应再有 chokidar').toBeUndefined()
    expect(await read('README.md'), 'LEFTOVERS_61 README 技术栈不应再有 chokidar').not.toMatch(/\|\s*chokidar\s*\|/)
    const settings = await read('electron/services/claudeSettingsService.js')
    const doc = settings.slice(settings.lastIndexOf('/**', settings.indexOf('async function readManagedSettings')), settings.indexOf('async function readManagedSettings'))
    expect(doc, 'LEFTOVERS_61 readManagedSettings 注释应写返回 {data, unknown}').toMatch(/@returns\s*\{Promise<\{\s*data:[^}]*unknown/)
  })

  it('TC-016 LEFTOVERS_61 只有只读来源的 Codex 启用先拒绝不补关；从 Claude 删除动到 Codex 目录先补关', async () => {
    const { homeDir, repoPath } = env
    await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true })
    await writeSkill(path.join(homeDir, '.codex', 'skills', '.system'), 'imagegen', 'system')
    let migrations = 0
    const deps = { codexSkillApi: createFakeCodexApi({ homeDir }), beforeCodexWriteFn: async () => { migrations += 1 } }
    const code = await codeOf(executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'imagegen', action: 'enable' }, deps))
    expect(code, 'LEFTOVERS_61 只读来源启用应拒绝').toBe('ORIGIN_READ_ONLY')
    expect(migrations, 'LEFTOVERS_61 拒绝前不应补关').toBe(0)

    await writeSkill(repoPath, 'both', 'both')
    await link(path.join(repoPath, 'both'), path.join(homeDir, '.claude', 'skills', 'both'))
    await link(path.join(repoPath, 'both'), path.join(homeDir, '.agents', 'skills', 'both'))
    await executeSkillCommand({ repoPath, homeDir, toolId: 'claude-code', skillName: 'both', action: 'delete' }, deps)
    expect(migrations, 'LEFTOVERS_61 删除动到 Codex 目录应先补关').toBe(1)
  })
})
