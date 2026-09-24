/**
 * Codex Skill 开关配置读写 — 行为测试（架构优化第一批 Task 2）
 *
 * 负责：
 * - 读：按 TOML 语义读 [[skills.config]]，不被相邻表的 enabled 干扰
 * - 写：只改目标 Skill 的 enabled，其余字节原样（注释 / CRLF / 引号 / 其他表）
 * - 拒绝：不支持的写法、非法 TOML、提交前被外部改动 → 文件不变
 * - 启用：预检不过不部署；写配置失败撤回本次新部署的目录
 *
 * 所有写入只发生在 mkdtemp 创建的临时 HOME。
 *
 * @module tests/safety/codexSkillConfig.test
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const TOML = require('@iarna/toml')
const { parseSkillConfig, discoverCodexSkills, applyCodexCommand } = require('../../electron/services/skillAdapters/codexSkillAdapter')

let sandbox
let homeDir
let repoPath
let configPath

async function writeSkill(root, name) {
  const skillPath = path.join(root, name)
  await fs.mkdir(skillPath, { recursive: true })
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`)
  return skillPath
}

async function writeConfig(text) {
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, text)
}

const readConfig = () => fs.readFile(configPath, 'utf8')
const disable = (skillPath, deps) => applyCodexCommand({ homeDir, skillName: path.basename(skillPath), action: 'disable', source: { absolutePath: skillPath } }, deps)

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-codex-toml-'))
  homeDir = path.join(sandbox, 'home')
  repoPath = path.join(sandbox, 'repo')
  configPath = path.join(homeDir, '.codex', 'config.toml')
  await fs.mkdir(repoPath, { recursive: true })
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe('Task 2 · 读', () => {
  it('TC-1 Skill 块后紧跟带 enabled 的表时，读到的是 Skill 自己的开关', () => {
    const records = parseSkillConfig('[[skills.config]]\npath = "/fake/a"\n\n[mcp_servers.x]\ncommand = "x"\nenabled = false\n')
    expect(records).toEqual([{ path: '/fake/a', enabled: true }])
  })

  it('TC-7a 非法 TOML：discover 报配置错误，不崩', async () => {
    await writeConfig('[[skills.config]]\npath = "/fake/a\n')
    const result = await discoverCodexSkills({ homeDir }, { skipPluginDiscovery: true })
    expect(result.errors.some((item) => item.origin === 'config')).toBe(true)
  })
})

describe('Task 2 · 写只改目标', () => {
  it('TC-2 停用时不改相邻表的 enabled', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const tail = '\n[mcp_servers.x]\ncommand = "x"\nenabled = false\n'
    await writeConfig(`[[skills.config]]\npath = "${skill}"\nenabled = true\n${tail}`)
    await disable(skill)
    const text = await readConfig()
    const doc = TOML.parse(text)
    expect(doc.skills.config[0].enabled).toBe(false)
    expect(doc.mcp_servers.x.enabled).toBe(false)
    expect(text.endsWith(tail)).toBe(true)
  })

  it('TC-3 Skill 块没有 enabled 时，新行插在 Skill 块内', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    await writeConfig(`[[skills.config]]\npath = "${skill}"\n\n[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "x"\n`)
    await disable(skill)
    const doc = TOML.parse(await readConfig())
    expect(doc.skills.config[0].enabled).toBe(false)
    expect(doc.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'x' })
  })

  it('TC-4 注释、CRLF、紧凑赋值、单引号都原样保留，只有一行变化', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const lines = [
      '# user note',
      "label='hand written'",
      '[features]  # keep this',
      'hooks=false # choice',
      '',
      '[[skills.config]]',
      `path = '${skill}'   # my skill`,
      'enabled=true # on',
      '',
    ]
    await writeConfig(lines.join('\r\n'))
    await disable(skill)
    const after = (await readConfig()).split('\r\n')
    expect(after.length).toBe(lines.length)
    const changed = after.map((line, index) => (line === lines[index] ? null : index)).filter((index) => index !== null)
    expect(changed).toEqual([7])
    expect(after[7]).toBe('enabled=false # on')
  })

  it('TC-5 多行字符串和带引号的键里的相似字样不干扰定位', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const head = 'note = """\n[[skills.config]]\nenabled = true\n"""\n"enabled" = "top"\n\n'
    const tail = '\n[other]\ntext = """\nenabled = true\n"""\n'
    await writeConfig(`${head}[[skills.config]]\npath = "${skill}"\n${tail}`)
    await disable(skill)
    const text = await readConfig()
    const doc = TOML.parse(text)
    expect(doc.skills.config[0].enabled).toBe(false)
    expect(doc.note).toBe('[[skills.config]]\nenabled = true\n')
    expect(doc.enabled).toBe('top')
    expect(doc.other.text).toBe('enabled = true\n')
    expect(text.startsWith(head)).toBe(true)
    expect(text.endsWith(tail)).toBe(true)
  })

  it('TC-9 追加新条目时，原内容逐字节作为前缀保留', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const original = '# user note\nmodel = "x"\n\n[features]\nhooks = true\n'
    await writeConfig(original)
    await disable(skill)
    const text = await readConfig()
    expect(text.startsWith(original)).toBe(true)
    expect(TOML.parse(text).skills.config).toEqual([{ path: skill, enabled: false }])
  })
})

describe('Task 2 · 拒绝时文件不变', () => {
  it('TC-6 内联定义的 skills.config 不支持安全编辑', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const original = `skills.config = [{ path = "${skill}", enabled = true }]\n`
    await writeConfig(original)
    await expect(disable(skill)).rejects.toMatchObject({ code: 'CODEX_CONFIG_UNSUPPORTED' })
    expect(await readConfig()).toBe(original)
  })

  it('TC-7b 非法 TOML 拒绝写入', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const original = '[[skills.config]]\npath = "/fake/a\n'
    await writeConfig(original)
    await expect(disable(skill)).rejects.toMatchObject({ code: 'CODEX_CONFIG_INVALID' })
    expect(await readConfig()).toBe(original)
  })

  it('TC-8 已是目标值时不写文件、不留备份', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    await writeConfig(`[[skills.config]]\npath = "${skill}"\nenabled = false\n`)
    const before = await fs.stat(configPath)
    await disable(skill)
    const after = await fs.stat(configPath)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    await expect(fs.access(`${configPath}.codepal.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('TC-10 提交前被外部改动 → 冲突，保留外部版本', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    await writeConfig(`[[skills.config]]\npath = "${skill}"\nenabled = true\n`)
    const external = '# edited elsewhere\nmodel = "y"\n'
    await expect(disable(skill, { beforeConfigCommit: () => fs.writeFile(configPath, external) }))
      .rejects.toMatchObject({ code: 'CODEX_CONFIG_CONFLICT' })
    expect(await readConfig()).toBe(external)
  })

  it('TC-11 写入前备份原文件，并保留原权限', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const original = `[[skills.config]]\npath = "${skill}"\nenabled = true\n`
    await writeConfig(original)
    await fs.chmod(configPath, 0o644)
    await disable(skill)
    expect(await fs.readFile(`${configPath}.codepal.bak`, 'utf8')).toBe(original)
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o644)
  })
})

describe('Task 2 · 启用', () => {
  it('TC-12 预检不通过时不部署目录', async () => {
    await writeSkill(repoPath, 'portable')
    await writeConfig('skills.config = []\n')
    await expect(applyCodexCommand({ repoPath, homeDir, skillName: 'portable', action: 'enable' }))
      .rejects.toMatchObject({ code: 'CODEX_CONFIG_UNSUPPORTED' })
    await expect(fs.access(path.join(homeDir, '.agents', 'skills', 'portable'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('TC-13 写配置冲突时撤回本次新部署的目录', async () => {
    await writeSkill(repoPath, 'portable')
    await writeConfig('model = "x"\n')
    await expect(applyCodexCommand(
      { repoPath, homeDir, skillName: 'portable', action: 'enable' },
      { beforeConfigCommit: () => fs.writeFile(configPath, 'model = "changed"\n') },
    )).rejects.toMatchObject({ code: 'CODEX_CONFIG_CONFLICT' })
    await expect(fs.access(path.join(homeDir, '.agents', 'skills', 'portable'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// ── 代码门审核（Codex NOT_ACK）后补的用例：R-1〜R-9 对应审核 findings 1〜9，R-10 为自查补充 ──
const { getSkillControlSnapshot } = require('../../electron/services/skillControlService')

describe('Task 2 · 审核修复', () => {
  const leftovers = async () => (await fs.readdir(path.dirname(configPath))).filter((name) => name.includes('.codepal-') && name.endsWith('.tmp'))

  it('R-1 替换前最后一刻被外部改动 → 冲突，保留外部版本，不留临时文件', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    await writeConfig(`[[skills.config]]\npath = "${skill}"\nenabled = true\n`)
    const external = 'model = "late"\n'
    await expect(disable(skill, { beforeConfigRename: () => fs.writeFile(configPath, external) }))
      .rejects.toMatchObject({ code: 'CODEX_CONFIG_CONFLICT' })
    expect(await readConfig()).toBe(external)
    expect(await leftovers()).toEqual([])
  })

  it('R-2 替换失败 → 配置不变，不留临时文件', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const original = `[[skills.config]]\npath = "${skill}"\nenabled = true\n`
    await writeConfig(original)
    const renameFn = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    await expect(disable(skill, { renameFn })).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readConfig()).toBe(original)
    expect(await leftovers()).toEqual([])
  })

  it('R-4 启用：原有目录 + 配置冲突 → 原目录内容完好', async () => {
    await writeSkill(repoPath, 'portable')
    const userDir = path.join(homeDir, '.agents', 'skills', 'portable')
    await fs.mkdir(userDir, { recursive: true })
    await fs.writeFile(path.join(userDir, 'SKILL.md'), 'user own')
    await writeConfig('model = "x"\n')
    await expect(applyCodexCommand(
      { repoPath, homeDir, skillName: 'portable', action: 'enable' },
      { beforeConfigCommit: () => fs.writeFile(configPath, 'model = "changed"\n') },
    )).rejects.toMatchObject({ code: 'CODEX_CONFIG_CONFLICT' })
    expect(await fs.readFile(path.join(userDir, 'SKILL.md'), 'utf8')).toBe('user own')
  })

  it('R-5 启用：部署失败 → 配置恢复成原文', async () => {
    const original = '# keep\nmodel = "x"\n'
    await writeConfig(original)
    await expect(applyCodexCommand({ repoPath, homeDir, skillName: 'missing', action: 'enable' }))
      .rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    expect(await readConfig()).toBe(original)
  })

  it('R-6 备份文件是软链接时不写穿到链接目标', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    await writeConfig(`[[skills.config]]\npath = "${skill}"\nenabled = true\n`)
    const sentinel = path.join(sandbox, 'sentinel.txt')
    await fs.writeFile(sentinel, 'do not touch')
    await fs.symlink(sentinel, `${configPath}.codepal.bak`)
    await disable(skill)
    expect(await fs.readFile(sentinel, 'utf8')).toBe('do not touch')
    expect((await fs.lstat(`${configPath}.codepal.bak`)).isSymbolicLink()).toBe(false)
  })

  it('R-7 TOML 1.0 写法（四引号 / 五单引号 / 混合数组）可读可写', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const head = `a = """abc""""\nb = '''abc'''''\nc = ["s", { enabled = true }]\n\n`
    await writeConfig(`${head}[[skills.config]]\npath = "${skill}"\n`)
    expect(parseSkillConfig(await readConfig())).toEqual([{ path: skill, enabled: true }])
    await disable(skill)
    const text = await readConfig()
    expect(text.startsWith(head)).toBe(true)
    expect(parseSkillConfig(text)).toEqual([{ path: skill, enabled: false }])
  })

  it('R-8 空文件也备份，并保留原权限', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    await writeConfig('')
    await fs.chmod(configPath, 0o644)
    await disable(skill)
    expect(await fs.readFile(`${configPath}.codepal.bak`, 'utf8')).toBe('')
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o644)
  })

  it('R-9 配置读不出时，Codex 的开关状态标为不可用，而不是默认启用', async () => {
    await writeSkill(repoPath, 'portable')
    const snapshot = await getSkillControlSnapshot(
      { repoPath, homeDir, projectRoots: [] },
      {
        codexAdapter: { discover: async () => ({ toolId: 'codex', sources: [{ name: 'portable', origin: 'user', mutable: true, absolutePath: '/x' }], errors: [{ origin: 'config', code: 'READ_FAILED' }] }) },
        claudeAdapter: { discover: async () => ({ toolId: 'claude-code', sources: [], errors: [] }) },
      },
    )
    const skill = snapshot.skills.find((item) => item.name === 'portable')
    expect(skill.tools.codex).toMatchObject({ enabled: null, state: 'unavailable', mutable: false })
  })

  it('R-10 config.toml 本身是软链接（dotfiles）→ 保留链接，改的是链接目标', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const real = path.join(sandbox, 'dotfiles', 'codex.toml')
    await fs.mkdir(path.dirname(real), { recursive: true })
    await fs.writeFile(real, `[[skills.config]]\npath = "${skill}"\nenabled = true\n`)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.symlink(real, configPath)
    await disable(skill)
    expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true)
    expect(parseSkillConfig(await fs.readFile(real, 'utf8'))).toEqual([{ path: skill, enabled: false }])
  })
})

// ── 复审（Codex 第 2 轮 NOT_ACK）后补的用例：R-11〜R-17 对应 F1〜F8；原 R-3（回读失败即恢复）随机制删除 ──
describe('Task 2 · 复审修复', () => {
  const enable = (skillName, deps) => applyCodexCommand({ repoPath, homeDir, skillName, action: 'enable' }, deps)
  const failDeploy = async () => { throw Object.assign(new Error('DEPLOY_BOOM'), { code: 'DEPLOY_BOOM' }) }

  it('R-11 撤回前文件被别人换成同内容的新文件 → 不覆盖别人的版本，报部分完成', async () => {
    await writeConfig('model = "x"\n')
    let externalIno
    const afterConfigCommit = async () => {
      const text = await readConfig()
      await fs.rm(configPath)
      await fs.writeFile(configPath, text, { mode: 0o644 })
      externalIno = (await fs.stat(configPath)).ino
    }
    // 第 3 轮复审 N1：没撤回成（文件已是别人的）也要报部分完成，不能让页面说「已保留原状态」
    await expect(enable('portable', { afterConfigCommit, deployFn: failDeploy })).rejects.toMatchObject({ code: 'CODEX_ENABLE_PARTIAL' })
    const stat = await fs.stat(configPath)
    expect(stat.ino).toBe(externalIno)
    expect(stat.mode & 0o777).toBe(0o644)
  })

  it('R-12 撤回本身失败 → 报「部分完成」，不冒充已保留原状态', async () => {
    await writeConfig('model = "x"\n')
    const restoreRenameFn = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    await expect(enable('portable', { deployFn: failDeploy, restoreRenameFn })).rejects.toMatchObject({ code: 'CODEX_ENABLE_PARTIAL' })
  })

  it('R-13 两个启用并发：失败的那个不会撤销成功的那个', async () => {
    await writeSkill(repoPath, 'portable')
    await writeConfig('model = "x"\n')
    let releaseA
    const gateA = new Promise((resolve) => { releaseA = resolve })
    const a = enable('portable', { deployFn: async () => { await gateA; throw Object.assign(new Error('DEPLOY_BOOM'), { code: 'DEPLOY_BOOM' }) } })
    const b = enable('portable')
    releaseA()
    await expect(a).rejects.toMatchObject({ code: 'DEPLOY_BOOM' })
    await b
    expect(parseSkillConfig(await readConfig())).toEqual([{ path: path.join(homeDir, '.agents', 'skills', 'portable'), enabled: true }])
  })

  it('R-14 操作中软链接被改指向 → 冲突，两边文件都不动', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const body = `[[skills.config]]\npath = "${skill}"\nenabled = true\n`
    const a = path.join(sandbox, 'A.toml')
    const b = path.join(sandbox, 'B.toml')
    await fs.writeFile(a, body)
    await fs.writeFile(b, body)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.symlink(a, configPath)
    const beforeConfigCommit = async () => { await fs.rm(configPath); await fs.symlink(b, configPath) }
    await expect(disable(skill, { beforeConfigCommit })).rejects.toMatchObject({ code: 'CODEX_CONFIG_CONFLICT' })
    expect(await fs.readFile(a, 'utf8')).toBe(body)
    expect(await fs.readFile(b, 'utf8')).toBe(body)
  })

  it('R-15 悬空软链接 → 拒绝，链接原样保留', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.symlink(path.join(sandbox, 'missing.toml'), configPath)
    await expect(disable(skill)).rejects.toMatchObject({ code: 'CODEX_CONFIG_UNSUPPORTED' })
    expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true)
  })

  it('R-16 64 位大整数可读可写，原文保留', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    const head = 'x = 9007199254740993\ny = -9223372036854775808\n\n'
    await writeConfig(`${head}[[skills.config]]\npath = "${skill}"\nenabled = true\n`)
    expect(parseSkillConfig(await readConfig())).toEqual([{ path: skill, enabled: true }])
    await disable(skill)
    const text = await readConfig()
    expect(text.startsWith(head)).toBe(true)
    expect(parseSkillConfig(text)).toEqual([{ path: skill, enabled: false }])
  })

  it('R-17 配置替换失败时旧备份保留', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    await writeConfig(`[[skills.config]]\npath = "${skill}"\nenabled = true\n`)
    await fs.writeFile(`${configPath}.codepal.bak`, 'previous backup')
    const renameFn = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    await expect(disable(skill, { renameFn })).rejects.toMatchObject({ code: 'EACCES' })
    expect(await fs.readFile(`${configPath}.codepal.bak`, 'utf8')).toBe('previous backup')
  })
})

// ── 第 3 轮复审（NOT_ACK：N1〜N3）后补的用例 ──
describe('Task 2 · 第 3 轮复审修复', () => {
  const enable = (skillName, deps) => applyCodexCommand({ repoPath, homeDir, skillName, action: 'enable' }, deps)
  const failDeploy = async () => { throw Object.assign(new Error('DEPLOY_BOOM'), { code: 'DEPLOY_BOOM' }) }

  it('R-18 部署期间别人又改了配置，部署失败 → 报部分完成，别人的内容不动', async () => {
    await writeConfig('model = "x"\n')
    const external = 'model = "saved elsewhere"\n'
    const afterConfigCommit = () => fs.writeFile(configPath, external)
    await expect(enable('portable', { afterConfigCommit, deployFn: failDeploy })).rejects.toMatchObject({ code: 'CODEX_ENABLE_PARTIAL' })
    expect(await readConfig()).toBe(external)
  })

  it('R-19 启用失败时旧备份保留', async () => {
    const original = 'model = "x"\n'
    await writeConfig(original)
    await fs.writeFile(`${configPath}.codepal.bak`, 'previous backup')
    await expect(enable('portable', { deployFn: failDeploy })).rejects.toMatchObject({ code: 'DEPLOY_BOOM' })
    expect(await readConfig()).toBe(original)
    expect(await fs.readFile(`${configPath}.codepal.bak`, 'utf8')).toBe('previous backup')
  })

  it('R-20 备份换不上时不留临时文件', async () => {
    const skill = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'a')
    await writeConfig(`[[skills.config]]\npath = "${skill}"\nenabled = true\n`)
    const backupRenameFn = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    await disable(skill, { backupRenameFn })
    expect(parseSkillConfig(await readConfig())).toEqual([{ path: skill, enabled: false }])
    const left = (await fs.readdir(path.dirname(configPath))).filter((name) => name.endsWith('.tmp'))
    expect(left).toEqual([])
  })
})
