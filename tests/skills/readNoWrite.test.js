/**
 * Skills 只留一套引擎（specs/v2.1.9-Skills只留一套引擎）：读取不写配置
 *
 * 负责：
 * - TC-004：读快照不再顺手补关 Codex 旧停用写法；补关挪到 Codex 的写操作里，排在来源检查通过之后、真正写入之前；
 *   被拒绝的操作（来源找不到、只读来源、带来源的启用、要删的不在资产库、要收的已在资产库或原件不在）不补关；
 *   页面上的删除（toolId 为 all）也算动到 Codex，同样先补关，配置与文件逐字不变；Claude 的写操作不补关；补关失败恢复备份、不挡写操作
 * - 只用注入的替身和 mkdtemp 临时家目录，不碰真实家目录
 *
 * @module tests/skills/readNoWrite.test
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { registerSkillControlHandlers } = require('../../electron/handlers/registerSkillControlHandlers')

let homeDir
let repoPath
let configPath
let original
let order

async function writeSkill(root, name) {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`)
  return dir
}

// Codex 官方接口替身：列表按写入记录给开关状态，写入只记在内存；可让它先改 config.toml 再失败
function createFakeCodexApi({ failWrite = false } = {}) {
  const fsSync = require('node:fs')
  const disabled = new Set()
  const listRoot = (root, scope) => {
    let entries = []
    try { entries = fsSync.readdirSync(root, { withFileTypes: true }) } catch { return [] }
    return entries.filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => path.join(root, entry.name, 'SKILL.md'))
      .filter((skillMd) => fsSync.existsSync(skillMd))
      .map((skillMd) => fsSync.realpathSync(skillMd))
      .map((real) => ({ name: path.basename(path.dirname(real)), path: real, scope, pluginId: null, enabled: !disabled.has(real) }))
  }
  return {
    async list() {
      return [...listRoot(path.join(homeDir, '.agents', 'skills'), 'user'), ...listRoot(path.join(homeDir, '.codex', 'skills'), 'user')]
    },
    async write({ skillMdPath, enabled }) {
      order.push('codex-write')
      if (failWrite) {
        await fs.appendFile(configPath, '\n[[skills.config]]\npath = "half-written"\nenabled = false\n')
        throw Object.assign(new Error('CODEX_API_FAILED'), { code: 'CODEX_API_FAILED' })
      }
      const real = fsSync.realpathSync(skillMdPath)
      if (enabled) disabled.delete(real)
      else disabled.add(real)
      return { effectiveEnabled: enabled }
    },
  }
}

function register(deps) {
  const handlers = {}
  registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir }, deps)
  return handlers
}

beforeEach(async () => {
  order = []
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-read-no-write-'))
  repoPath = path.join(homeDir, 'Documents', 'SkillManager')
  await fs.mkdir(repoPath, { recursive: true })
  const legacyDir = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'old-off')
  await writeSkill(path.join(homeDir, '.agents', 'skills'), 'foo')
  await writeSkill(path.join(homeDir, '.codex', 'skills', '.system'), 'imagegen')
  await writeSkill(path.join(homeDir, '.claude', 'skills'), 'bar')
  await writeSkill(repoPath, 'bye')
  await writeSkill(repoPath, 'bye-all')
  await writeSkill(repoPath, 'both')
  await writeSkill(path.join(homeDir, '.agents', 'skills'), 'both')
  configPath = path.join(homeDir, '.codex', 'config.toml')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  // 旧写法：关的是文件夹路径（Codex 不认），Codex 实际开着 → 有一条待补关
  original = `model = "x"\n\n[[skills.config]]\npath = "${legacyDir}"\nenabled = false\n`
  await fs.writeFile(configPath, original)
})

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true })
})

const codeOf = (result) => (result.success ? null : result.error)

describe('Skills 读取不写配置', () => {
  it('TC-004 READ_NO_WRITE 读快照不补关；被拒绝的操作不补关；Codex 写入前先补关；Claude 写操作不补关', async () => {
    const realMigrate = require('../../electron/services/skillAdapters/codexSkillAdapter').migrateLegacyCodexDisables
    const migrate = vi.fn(async (...args) => { order.push('migrate'); return realMigrate(...args) })
    const deps = { skipPluginDiscovery: true, codexSkillApi: createFakeCodexApi(), migrateLegacyCodexDisablesFn: migrate }
    const handlers = register(deps)

    const centralBefore = (await fs.readdir(repoPath)).sort()
    const snap = await handlers['skill-control:get-snapshot']({}, { repoPath, projectRoots: [] })
    expect(snap.success).toBe(true)
    expect(migrate.mock.calls.length, 'READ_NO_WRITE 读快照时不该补关').toBe(0)
    expect(await fs.readFile(configPath, 'utf8'), 'READ_NO_WRITE 读快照改了 config.toml').toBe(original)

    const systemId = snap.data.skills.find((skill) => skill.name === 'imagegen').origins[0].sourceId
    const fooId = snap.data.skills.find((skill) => skill.name === 'foo').origins.find((origin) => origin.toolId === 'codex').sourceId
    const rejected = [
      { skillName: 'foo', action: 'adopt', sourceId: 'no-such-source', expected: 'SOURCE_NOT_FOUND' },
      { skillName: 'imagegen', action: 'disable', sourceId: systemId, expected: 'ORIGIN_READ_ONLY' },
      { skillName: 'imagegen', action: 'disable', expected: 'ORIGIN_READ_ONLY' },
      { skillName: 'foo', action: 'enable', sourceId: fooId, expected: 'SOURCE_ACTION_UNSUPPORTED' },
      // 要删的不在资产库（从 Codex 删、从页面删都一样）、要收的已在资产库或原件不在
      { skillName: 'nope', action: 'delete', expected: 'SKILL_NOT_FOUND' },
      { skillName: 'nope', action: 'delete', toolId: 'all', expected: 'SKILL_NOT_FOUND' },
      { skillName: 'both', action: 'adopt', expected: 'SKILL_ALREADY_MANAGED' },
      { skillName: 'ghost', action: 'adopt', expected: 'EXTERNAL_SKILL_NOT_FOUND' },
    ]
    for (const { expected, ...command } of rejected) {
      const result = await handlers['skill-control:execute']({}, { repoPath, toolId: 'codex', ...command })
      expect(codeOf(result), `READ_NO_WRITE ${command.skillName} ${command.action}`).toBe(expected)
    }
    expect(migrate.mock.calls.length, 'READ_NO_WRITE 被拒绝的操作不该补关').toBe(0)
    expect(order).toEqual([])
    expect(await fs.readFile(configPath, 'utf8'), 'READ_NO_WRITE 被拒绝的操作改了 config.toml').toBe(original)
    expect((await fs.readdir(repoPath)).sort()).toEqual(centralBefore)

    const claude = await handlers['skill-control:execute']({}, { repoPath, toolId: 'claude-code', skillName: 'bar', action: 'adopt' })
    expect(claude.success).toBe(true)
    expect(migrate.mock.calls.length, 'READ_NO_WRITE Claude 写操作不该补关').toBe(0)

    const codex = await handlers['skill-control:execute']({}, { repoPath, toolId: 'codex', skillName: 'foo', action: 'disable' })
    expect(codex.success).toBe(true)
    expect(order.slice(0, 2), 'READ_NO_WRITE Codex 写入前应先补关').toEqual(['migrate', 'codex-write'])

    // Codex 的启用、收进、从 Codex 删除也都先补关（补关已做过就不再写），操作照常
    // 页面上的删除传的是 toolId: 'all'（会连带删 ~/.codex、~/.agents 里的那份），同样先补关
    for (const [skillName, action, toolId] of [['foo', 'enable', 'codex'], ['foo', 'adopt', 'codex'], ['bye', 'delete', 'codex'], ['bye-all', 'delete', 'all']]) {
      const calls = migrate.mock.calls.length
      const done = await handlers['skill-control:execute']({}, { repoPath, toolId, skillName, action })
      expect(done.success, `READ_NO_WRITE Codex ${action}`).toBe(true)
      expect(migrate.mock.calls.length, `READ_NO_WRITE Codex ${action} 前应先补关`).toBe(calls + 1)
    }
    await expect(fs.access(path.join(repoPath, 'foo', 'SKILL.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(repoPath, 'bye'))).rejects.toThrow()
    await expect(fs.access(path.join(repoPath, 'bye-all'))).rejects.toThrow()
  })

  it('TC-004 READ_NO_WRITE Codex 写入前补关失败：config.toml 逐字恢复，写操作照常执行', async () => {
    const executeSkillCommandFn = vi.fn(async (_params, deps) => {
      // 替身照真实服务的约定：来源检查通过后、写入前调用补关钩子
      await deps.beforeCodexWriteFn?.()
      return { success: true }
    })
    const handlers = register({ codexSkillApi: createFakeCodexApi({ failWrite: true }), executeSkillCommandFn, getSkillControlSnapshotFn: vi.fn(async () => ({ skills: [] })) })
    const result = await handlers['skill-control:execute']({}, { repoPath, skillName: 'foo', toolId: 'codex', action: 'disable' })
    expect(result.success, 'READ_NO_WRITE 补关失败挡住了写操作').toBe(true)
    expect(executeSkillCommandFn).toHaveBeenCalledTimes(1)
    expect(order, 'READ_NO_WRITE 应当尝试过补关').toEqual(['codex-write'])
    expect(await fs.readFile(configPath, 'utf8'), 'READ_NO_WRITE 补关失败后 config.toml 没恢复').toBe(original)
  })

  it('TC-004 READ_NO_WRITE 从 Codex 删除时补关失败：config.toml 逐字恢复，删除照常完成', async () => {
    const handlers = register({ skipPluginDiscovery: true, codexSkillApi: createFakeCodexApi({ failWrite: true }) })
    const result = await handlers['skill-control:execute']({}, { repoPath, toolId: 'codex', skillName: 'bye', action: 'delete' })
    expect(result.success, 'READ_NO_WRITE 补关失败挡住了删除').toBe(true)
    expect(order, 'READ_NO_WRITE 删除前应当尝试过补关').toEqual(['codex-write'])
    expect(await fs.readFile(configPath, 'utf8'), 'READ_NO_WRITE 补关失败后 config.toml 没恢复').toBe(original)
    await expect(fs.access(path.join(repoPath, 'bye'))).rejects.toThrow()
  })
})
