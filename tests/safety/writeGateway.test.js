/**
 * Codex 配置写入网关 + 足迹清单（架构优化 B2-6，roadmap 路线 5）
 *
 * 负责：
 * - Skills、会话状态对 ~/.codex/config.toml 的修改都进同一把锁（Codex 配置负责人）；提交前复验，外部改动 → 冲突
 * - 会话状态：配置坏了拒绝写；只留一份滚动备份，不再每次攒一个带时间戳的 .bak
 * - 足迹清单：CodePal 装进别的工具的东西（会话状态钩子等）装时登记、卸时注销
 *
 * 所有写入只发生在 mkdtemp 创建的临时 HOME。
 *
 * @module tests/safety/writeGateway.test
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { tempDir } from '../helpers/tempDir.js'

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

const owner = require('../../electron/services/codexConfigOwner')
const footprint = require('../../electron/services/footprintRegistry')
const { applyCodexCommand } = require('../../electron/services/skillAdapters/codexSkillAdapter')

const originalHome = process.env.HOME
const noTrust = async () => ({ trusted: 0, alreadyTrusted: 0 })
function loadSessionStatus(home) {
  process.env.HOME = home
  for (const id of Object.keys(require.cache)) {
    if (/electron[\\/]services[\\/](sessionStatusService|claudeSettingsService)\.js$/.test(id)) delete require.cache[id]
  }
  return require('../../electron/services/sessionStatusService')
}
function memoryStore() {
  const data = new Map()
  return { get: (k) => data.get(k), set: (k, v) => data.set(k, v) }
}
afterEach(() => {
  process.env.HOME = originalHome
  for (const id of Object.keys(require.cache)) {
    if (/electron[\\/]services[\\/](sessionStatusService|claudeSettingsService)\.js$/.test(id)) delete require.cache[id]
  }
})

async function tempHome() {
  const home = tempDir('codepal-gateway-')
  await mkdir(path.join(home, '.codex'), { recursive: true })
  return home
}

describe('B2-6 所有 Codex 配置写入进同一把锁', () => {
  it('TC-050 CONFIG_LOCK G-1 Skill 开关与会话状态写入同时发生，两个改动都保留（Skill 经 Codex 官方接口写，写入仍在同一把锁里）', async () => {
    const home = await tempHome()
    await mkdir(path.join(home, '.claude'), { recursive: true })
    const skill = path.join(home, '.agents', 'skills', 'a')
    await mkdir(skill, { recursive: true })
    await writeFile(path.join(skill, 'SKILL.md'), '# a\n')
    const configPath = path.join(home, '.codex', 'config.toml')
    await writeFile(configPath, `[[skills.config]]\npath = "${skill}"\nenabled = true\n`)
    const svc = loadSessionStatus(home)
    await Promise.all([
      svc.installSessionStatus({ trustHooks: noTrust }),
      applyCodexCommand({ homeDir: home, skillName: 'a', action: 'disable', source: { absolutePath: skill } }, { codexSkillApi: createFakeCodexApi({ homeDir: home }) }),
    ])
    const text = await readFile(configPath, 'utf8')
    // Codex 只认 SKILL.md 路径：新写的是指向 SKILL.md 的一条（旧的文件夹路径记录原样留着）
    expect(text).toMatch(/path = ".*\/a\/SKILL\.md"\nenabled = false/)
    expect(text).toMatch(/\[\[hooks\./)
  })

  // 原 G-2（Skill 开关提交前被外部改动 → 冲突）随「CodePal 自己改 config.toml 文字」的写法退役：
  // Skill 开关改由 Codex 官方接口写入并按 skills/list 核对，不再有 CodePal 的提交前复验这一步
})

describe('B2-6 会话状态经网关写 Codex 配置', () => {
  it('G-4 装一次、卸一次：只留一份滚动备份，不再攒带时间戳的 .bak', async () => {
    const home = await tempHome()
    await mkdir(path.join(home, '.claude'), { recursive: true })
    await writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n')
    const svc = loadSessionStatus(home)
    await svc.installSessionStatus({ trustHooks: noTrust })
    await svc.uninstallSessionStatus()
    const baks = (await readdir(path.join(home, '.codex'))).filter((f) => f.endsWith('.bak'))
    expect(baks).toEqual(['config.toml.codepal.bak'])
  })

  it('G-5 Codex 配置本身已损坏 → 不写，文件原样', async () => {
    const home = await tempHome()
    await mkdir(path.join(home, '.claude'), { recursive: true })
    const broken = 'model = "gpt-5\n[features\n'
    await writeFile(path.join(home, '.codex', 'config.toml'), broken)
    const svc = loadSessionStatus(home)
    const result = await svc.installSessionStatus({ trustHooks: noTrust })
    expect(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe(broken)
    // Claude 那边装上了算部分成功（success 仍为 true），但 Codex 必须如实列进失败项
    expect(result.failures.map((f) => f.tool)).toContain('codex')
    expect(result.failures.map((f) => f.tool)).not.toContain('codex-trust')
  })
})

describe('B2-6 足迹清单', () => {
  it('G-6 装会话状态时登记、卸时注销', async () => {
    const home = await tempHome()
    await mkdir(path.join(home, '.claude'), { recursive: true })
    await writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n')
    footprint.configureFootprint(memoryStore())
    const svc = loadSessionStatus(home)
    await svc.installSessionStatus({ trustHooks: noTrust })
    const ids = footprint.listFootprint().map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining(['session-status:codex-hooks', 'session-status:claude-hooks', 'session-status:scripts']))
    await svc.uninstallSessionStatus()
    expect(footprint.listFootprint().map((item) => item.id)).not.toContain('session-status:codex-hooks')
    await rm(home, { recursive: true, force: true })
  })

  it('G-7 写 Codex 配置的模块都经配置负责人，不再各写各的', () => {
    const read = (rel) => readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf-8')
    const skillAdapter = read('electron/services/skillAdapters/codexSkillAdapter.js')
    const session = read('electron/services/sessionStatusService.js')
    expect(skillAdapter).toMatch(/require\('\.\.\/codexConfigOwner'\)/)
    expect(skillAdapter).not.toMatch(/codexConfigWriteQueue/)
    expect(session).toMatch(/require\('\.\/codexConfigOwner'\)/)
    expect(session).not.toMatch(/atomicWriteText\(CODEX_CONFIG_PATH/)
  })
})
