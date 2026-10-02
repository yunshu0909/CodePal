/**
 * Codex Skill 开关走官方接口（specs/skills-redesign-dev TC-005–008、TC-034、TC-035、TC-037）
 *
 * 负责：
 * - 写只经 skills/config/write、参数是 SKILL.md 绝对路径；写完用 skills/list 核对
 * - 核对不一致写回原状态；写回不成或读不出报 STATE_UNKNOWN
 * - 旧写法（文件夹路径）的「关」补关：备份、全成功才算、失败恢复
 * - 全部在 mkdtemp 临时 HOME 里跑，Codex 接口用文件内的替身 createFakeCodexApi
 *
 * @module tests/skills/codexSkillApi.test
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

// ---------- Codex 官方接口替身 ----------
// 照 Codex 0.155 实测到的规则判断开关（2026-09-29 临时 CODEX_HOME 实测，见 specs/skills-redesign-dev2/1-plan.md）：
// 只认 path 指向 SKILL.md（解析软链接后比对）或 name 的 [[skills.config]]，指向文件夹的记录不认；
// write 照 Codex（toml_edit）只动相关几行：关 = 追加一条解析后的 SKILL.md 路径记录，开 = 删掉指向同一 SKILL.md 的记录；
// 可注入故障：listFails / writeFails / writeIgnored / failWriteAt / failListAt / listFailsAfterWrite / notFound。
// 各测试文件各带一份（计划只声明测试文件本身，不另建共用文件）。
const fakeFs = require('node:fs')
const FAKE_TOML = require('@iarna/toml')

function fakeRealpath(filePath) {
  try {
    return fakeFs.realpathSync(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

function fakeReadEntries(configPath) {
  let text = ''
  try {
    text = fakeFs.readFileSync(configPath, 'utf8')
  } catch {
    return []
  }
  const doc = FAKE_TOML.parse(text)
  return Array.isArray(doc?.skills?.config) ? doc.skills.config : []
}

function fakeListRoot(root, scope) {
  let entries = []
  try {
    entries = fakeFs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => path.join(root, entry.name, 'SKILL.md'))
    .filter((skillMd) => fakeFs.existsSync(skillMd))
    .map((skillMd) => ({ name: path.basename(path.dirname(skillMd)), path: fakeRealpath(skillMd), scope, pluginId: null }))
}

/**
 * @param {object} options
 * @param {string} options.homeDir - 临时 HOME
 * @returns {{list: Function, write: Function, calls: Array, faults: object}}
 */
function createFakeCodexApi({ homeDir }) {
  const configPath = path.join(homeDir, '.codex', 'config.toml')
  const calls = []
  const faults = { listFails: 0, writeFails: 0, writeIgnored: 0, failWriteAt: null, failListAt: null, listFailsAfterWrite: false, notFound: false }
  let writeCount = 0
  let listCount = 0

  function isDisabled(skill, entries) {
    return entries.some((entry) => entry.enabled === false && (
      (typeof entry.name === 'string' && entry.name === skill.name)
      || (typeof entry.path === 'string' && entry.path.endsWith('SKILL.md') && fakeRealpath(entry.path) === skill.path)
    ))
  }

  return {
    calls,
    faults,
    async list() {
      calls.push({ method: 'skills/list' })
      listCount += 1
      if (faults.notFound) throw Object.assign(new Error('CODEX_NOT_FOUND'), { code: 'CODEX_NOT_FOUND' })
      if (faults.failListAt === listCount) throw Object.assign(new Error('CODEX_API_FAILED'), { code: 'CODEX_API_FAILED' })
      if (faults.listFailsAfterWrite && writeCount > 0) throw Object.assign(new Error('CODEX_API_FAILED'), { code: 'CODEX_API_FAILED' })
      if (faults.listFails > 0) {
        faults.listFails -= 1
        throw Object.assign(new Error('CODEX_API_FAILED'), { code: 'CODEX_API_FAILED' })
      }
      const entries = fakeReadEntries(configPath)
      const skills = [
        ...fakeListRoot(path.join(homeDir, '.agents', 'skills'), 'user'),
        ...fakeListRoot(path.join(homeDir, '.codex', 'skills'), 'user'),
        ...fakeListRoot(path.join(homeDir, '.codex', 'skills', '.system'), 'system'),
      ]
      return skills.map((skill) => ({ ...skill, enabled: !isDisabled(skill, entries) }))
    },
    async write({ skillMdPath, enabled }) {
      calls.push({ method: 'skills/config/write', path: skillMdPath, enabled })
      writeCount += 1
      if (faults.notFound) throw Object.assign(new Error('CODEX_NOT_FOUND'), { code: 'CODEX_NOT_FOUND' })
      if (faults.failWriteAt === writeCount || faults.writeFails > 0) {
        if (faults.writeFails > 0) faults.writeFails -= 1
        throw Object.assign(new Error('CODEX_API_FAILED'), { code: 'CODEX_API_FAILED' })
      }
      if (faults.writeIgnored > 0) {
        faults.writeIgnored -= 1
        return { effectiveEnabled: enabled }
      }
      // 照 Codex（toml_edit）的做法只动相关的那几行：关 = 末尾追加一条，开 = 删掉指向同一 SKILL.md 的记录
      const target = fakeRealpath(skillMdPath)
      let text = ''
      try {
        text = fakeFs.readFileSync(configPath, 'utf8')
      } catch {}
      const blocks = text.split(/(?=^\[\[skills\.config\]\]\s*$)/m)
      const kept = blocks.map((block) => {
        if (!block.startsWith('[[skills.config]]')) return block
        // 一条记录到下一个表头为止，后面别的表原样保留
        const firstBreak = block.indexOf('\n')
        const nextHeader = firstBreak < 0 ? -1 : block.slice(firstBreak + 1).search(/^\[/m)
        const end = nextHeader < 0 ? block.length : firstBreak + 1 + nextHeader
        const entry = block.slice(0, end)
        const match = entry.match(/^path\s*=\s*"([^"]*)"/m)
        return match && fakeRealpath(match[1]) === target ? block.slice(end) : block
      })
      let next = kept.join('')
      if (!enabled) next += `${next && !next.endsWith('\n') ? '\n' : ''}\n[[skills.config]]\npath = "${target}"\nenabled = false\n`
      fakeFs.mkdirSync(path.dirname(configPath), { recursive: true })
      fakeFs.writeFileSync(configPath, next)
      return { effectiveEnabled: enabled }
    },
  }
}
// ---------- 替身结束 ----------

const codexAdapter = require('../../electron/services/skillAdapters/codexSkillAdapter')
const service = require('../../electron/services/skillControlService')

let sandbox
let homeDir
let repoPath
let api

async function writeSkill(root, name, body = name) {
  const skillPath = path.join(root, name)
  await fs.mkdir(skillPath, { recursive: true })
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n# ${body}\n`)
  return skillPath
}

async function deployLink(name) {
  const target = path.join(homeDir, '.agents', 'skills', name)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.symlink(path.join(repoPath, name), target, 'dir')
  return target
}

const configPath = () => path.join(homeDir, '.codex', 'config.toml')
const readConfig = () => fs.readFile(configPath(), 'utf8').catch(() => '')
const deps = () => ({ codexSkillApi: api, skipPluginDiscovery: true })
const codexState = async (name) => {
  const snapshot = await service.getSkillControlSnapshot({ repoPath, homeDir }, deps())
  return snapshot.skills.find((skill) => skill.name === name)?.tools?.codex
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-codex-api-'))
  homeDir = path.join(sandbox, 'home')
  repoPath = path.join(sandbox, 'catalog')
  await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true })
  await fs.mkdir(repoPath, { recursive: true })
  api = createFakeCodexApi({ homeDir })
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe('Codex 开关走官方接口', () => {
  it('TC-005 CODEX_OFFICIAL_WRITE 停用 / 启用只经 skills/config/write，参数是 SKILL.md 绝对路径，写完用 skills/list 核对', async () => {
    await writeSkill(repoPath, 'alpha')
    await deployLink('alpha')
    await fs.writeFile(configPath(), '# 用户自己的注释\nmodel = "gpt"\n')

    await service.executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'alpha', action: 'disable' }, deps())
    const writes = api.calls.filter((call) => call.method === 'skills/config/write')
    expect(writes).toHaveLength(1)
    expect(path.isAbsolute(writes[0].path)).toBe(true)
    expect(path.basename(writes[0].path)).toBe('SKILL.md')
    expect(writes[0].enabled).toBe(false)
    // 写之后必须再读一次核对
    const lastWrite = api.calls.lastIndexOf(writes[0])
    expect(api.calls.slice(lastWrite + 1).some((call) => call.method === 'skills/list')).toBe(true)
    expect((await codexState('alpha')).enabled).toBe(false)
    expect(await readConfig()).toContain('# 用户自己的注释\nmodel = "gpt"\n')

    await service.executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'alpha', action: 'enable' }, deps())
    const enableWrite = api.calls.filter((call) => call.method === 'skills/config/write').at(-1)
    expect(enableWrite).toMatchObject({ enabled: true })
    expect(path.basename(enableWrite.path)).toBe('SKILL.md')
    expect((await codexState('alpha')).enabled).toBe(true)
  })

  it('TC-006 NOT_EFFECTIVE_CODEX 接口说成功但核对仍是原状态：写回原状态并再核对，返回 NOT_EFFECTIVE，config.toml 不变', async () => {
    await writeSkill(repoPath, 'alpha')
    await deployLink('alpha')
    await fs.writeFile(configPath(), 'model = "gpt"\n')
    const before = await readConfig()
    api.faults.writeIgnored = 1

    await expect(service.executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'alpha', action: 'disable' }, deps()))
      .rejects.toMatchObject({ code: 'NOT_EFFECTIVE' })
    const writes = api.calls.filter((call) => call.method === 'skills/config/write')
    expect(writes.map((call) => call.enabled)).toEqual([false, true])
    expect(await readConfig()).toBe(before)
    expect((await codexState('alpha')).enabled).toBe(true)
  })

  it('TC-034 STATE_UNKNOWN_CODEX 写回也失败，或写后读不出：返回 STATE_UNKNOWN；之后读得出按实际显示，读不出标为读不出', async () => {
    await writeSkill(repoPath, 'alpha')
    await deployLink('alpha')

    // 情况一：核对不一致，写回又失败
    api.faults.writeIgnored = 1
    api.faults.failWriteAt = 2
    await expect(service.executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'alpha', action: 'disable' }, deps()))
      .rejects.toMatchObject({ code: 'STATE_UNKNOWN' })
    expect((await codexState('alpha')).enabled).toBe(true)

    // 情况二：写入前读得出、写入后 skills/list 读不出，之后的快照也读不出
    api = createFakeCodexApi({ homeDir })
    api.faults.listFailsAfterWrite = true
    await expect(service.executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'alpha', action: 'disable' }, deps()))
      .rejects.toMatchObject({ code: 'STATE_UNKNOWN' })
    const state = await codexState('alpha')
    expect(state.state).toBe('unavailable')
    expect(state.enabled).toBeNull()
  })

  it('TC-007 CODEX_UNAVAILABLE 没装 Codex / 接口起不来：快照标出两种不可用；写入直接失败，不改任何文件', async () => {
    await writeSkill(repoPath, 'alpha')
    await deployLink('alpha')

    api.faults.notFound = true
    let snapshot = await service.getSkillControlSnapshot({ repoPath, homeDir }, deps())
    expect(snapshot.errors).toContainEqual(expect.objectContaining({ toolId: 'codex', code: 'CODEX_NOT_FOUND' }))
    expect(snapshot.skills.find((skill) => skill.name === 'alpha').tools.codex.state).toBe('unavailable')
    await expect(service.executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'alpha', action: 'disable' }, deps()))
      .rejects.toMatchObject({ code: 'CODEX_NOT_FOUND' })
    expect(fsSync.existsSync(configPath())).toBe(false)

    // 这个家目录下没用过 Codex（没有 ~/.codex）：真实接口不起进程，直接当没找到
    const { listCodexSkills } = require('../../electron/services/codexSkillApi')
    await fs.rm(path.join(homeDir, '.codex'), { recursive: true, force: true })
    await expect(listCodexSkills({ homeDir })).rejects.toMatchObject({ code: 'CODEX_NOT_FOUND' })
    await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true })

    api = createFakeCodexApi({ homeDir })
    api.faults.listFails = 99
    snapshot = await service.getSkillControlSnapshot({ repoPath, homeDir }, deps())
    expect(snapshot.errors).toContainEqual(expect.objectContaining({ toolId: 'codex', code: 'CODEX_API_FAILED' }))
    expect(snapshot.skills.find((skill) => skill.name === 'alpha').tools.codex.state).toBe('unavailable')
  })

  it('TC-037 ENABLE_ROLLBACK 启用时官方接口失败：撤掉这次新部署的那份，原来就在的不动', async () => {
    await writeSkill(repoPath, 'gamma')
    api.faults.writeFails = 1
    await expect(service.executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'gamma', action: 'enable' }, deps()))
      .rejects.toMatchObject({ code: 'CODEX_API_FAILED' })
    expect(fsSync.existsSync(path.join(homeDir, '.agents', 'skills', 'gamma'))).toBe(false)

    const existing = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'gamma', 'own copy')
    const existingText = await fs.readFile(path.join(existing, 'SKILL.md'), 'utf8')
    api.faults.writeFails = 1
    await expect(service.executeSkillCommand({ repoPath, homeDir, toolId: 'codex', skillName: 'gamma', action: 'enable' }, deps()))
      .rejects.toMatchObject({ code: 'CODEX_API_FAILED' })
    expect(await fs.readFile(path.join(existing, 'SKILL.md'), 'utf8')).toBe(existingText)
  })
})

describe('旧写法补关', () => {
  const legacyConfig = (paths) => `# 保留我\nmodel = "gpt"\n\n[mcp_servers.x]\ncommand = "x"\n${paths.map((p) => `\n[[skills.config]]\npath = "${p}"\nenabled = false\n`).join('')}`

  it('TC-008 LEGACY_MIGRATION 旧写法关、Codex 实际开着的，补关（SKILL.md 路径）并先备份；已有新写法或已关的不动；无关内容逐字不变；第二次不再改', async () => {
    await writeSkill(repoPath, 'lark-base')
    await writeSkill(repoPath, 'beta')
    await writeSkill(repoPath, 'reopened')
    const larkLink = await deployLink('lark-base')
    const betaLink = await deployLink('beta')
    const reopenedLink = await deployLink('reopened')
    const original = legacyConfig([larkLink, betaLink, reopenedLink])
      + `\n[[skills.config]]\npath = "${path.join(repoPath, 'beta', 'SKILL.md')}"\nenabled = false\n`
    await fs.writeFile(configPath(), original)
    // reopened：Codex 里后来又打开过 = 已有新写法记录（启用在 Codex 里是删除记录，这里用一条 enabled=true 的 SKILL.md 记录代表）
    await fs.appendFile(configPath(), `\n[[skills.config]]\npath = "${path.join(reopenedLink, 'SKILL.md')}"\nenabled = true\n`)
    const withReopened = await readConfig()

    const result = await codexAdapter.migrateLegacyCodexDisables({ homeDir }, deps())
    expect(result).toMatchObject({ status: 'migrated', migrated: 1 })
    const writes = api.calls.filter((call) => call.method === 'skills/config/write')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ enabled: false })
    expect(path.basename(writes[0].path)).toBe('SKILL.md')
    expect(writes[0].path.includes('lark-base')).toBe(true)
    expect((await readConfig()).startsWith(withReopened)).toBe(true)
    const backups = (await fs.readdir(path.join(homeDir, '.codex'))).filter((name) => name.includes('codepal-legacy-skill'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(homeDir, '.codex', backups[0]), 'utf8')).toBe(withReopened)
    expect((await codexState('lark-base')).enabled).toBe(false)

    const again = await codexAdapter.migrateLegacyCodexDisables({ homeDir }, deps())
    expect(again).toMatchObject({ status: 'none', migrated: 0 })
    expect(api.calls.filter((call) => call.method === 'skills/config/write')).toHaveLength(1)
  })

  // v2.1.9 起读就是读（specs/v2.1.9-Skills只留一套引擎 TC-004）：补关从读快照挪到 Codex 写操作里
  it('TC-008 LEGACY_MIGRATION 读快照不补关、如实显示开着；下一次动 Codex 时先补关', async () => {
    const { registerSkillControlHandlers } = require('../../electron/handlers/registerSkillControlHandlers')
    await writeSkill(repoPath, 'lark-base')
    await writeSkill(repoPath, 'other')
    const link = await deployLink('lark-base')
    const original = legacyConfig([link])
    await fs.writeFile(configPath(), original)
    const handlers = {}
    registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir }, deps())
    const result = await handlers['skill-control:get-snapshot'](null, { repoPath })
    expect(result.success).toBe(true)
    expect(result.data.skills.find((skill) => skill.name === 'lark-base').tools.codex.enabled).toBe(true)
    expect(await readConfig()).toBe(original)

    const write = await handlers['skill-control:execute'](null, { repoPath, toolId: 'codex', skillName: 'other', action: 'enable' })
    expect(write.success).toBe(true)
    expect(write.snapshot.skills.find((skill) => skill.name === 'lark-base').tools.codex.enabled).toBe(false)
  })

  it('TC-035 LEGACY_ROLLBACK 备份写不出一条都不写；中途失败或核对仍开着就恢复备份（逐字节一致）；快照照常；下次重试', async () => {
    await writeSkill(repoPath, 'one')
    await writeSkill(repoPath, 'two')
    const oneLink = await deployLink('one')
    const twoLink = await deployLink('two')
    const original = legacyConfig([oneLink, twoLink])
    await fs.writeFile(configPath(), original)

    // 备份失败
    const backupFails = { ...deps(), copyFileFn: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    let result = await codexAdapter.migrateLegacyCodexDisables({ homeDir }, backupFails)
    expect(result.status).toBe('failed')
    expect(api.calls.filter((call) => call.method === 'skills/config/write')).toHaveLength(0)
    expect(await readConfig()).toBe(original)

    // 第 2 条写入失败
    api.faults.failWriteAt = 2
    result = await codexAdapter.migrateLegacyCodexDisables({ homeDir }, deps())
    expect(result.status).toBe('failed')
    expect(await readConfig()).toBe(original)

    // 写完核对仍开着
    api = createFakeCodexApi({ homeDir })
    api.faults.writeIgnored = 1
    result = await codexAdapter.migrateLegacyCodexDisables({ homeDir }, deps())
    expect(result.status).toBe('failed')
    expect(await readConfig()).toBe(original)
    const snapshot = await service.getSkillControlSnapshot({ repoPath, homeDir }, deps())
    expect(snapshot.skills.find((skill) => skill.name === 'one').tools.codex.enabled).toBe(true)

    // 下次重试成功
    api = createFakeCodexApi({ homeDir })
    result = await codexAdapter.migrateLegacyCodexDisables({ homeDir }, deps())
    expect(result).toMatchObject({ status: 'migrated', migrated: 2 })
  })
})
