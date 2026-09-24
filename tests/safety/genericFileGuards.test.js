/**
 * 通用文件入口止损 — 行为测试（架构优化第一批 Task 3）
 *
 * 负责：
 * - 配置读写只认 .config.json；损坏的配置读取不改名、写入不覆盖
 * - 复制只允许 Skill 文件夹 → 同名文件夹；删除只允许已知 Skill 目录下的直接子项
 * - 渲染层 store 键白名单；ensure-dir 拒绝相对路径
 * - main.js 的通用 IPC 都经过这些检查（源码结构断言，主进程入口无法在单测里真实启动）
 *
 * 所有写入只发生在 mkdtemp 创建的临时目录。
 *
 * @module tests/safety/genericFileGuards.test
 */

import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const guards = require('../../electron/services/genericFileGuards')

let sandbox
let homeDir

async function writeSkill(root, name) {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `# ${name}\n`)
  return dir
}

beforeEach(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-guards-')))
  homeDir = path.join(sandbox, 'home')
  await fs.mkdir(homeDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe('配置读写', () => {
  it('TC-1 只能写 .config.json；settings.json / config.toml 被拒', async () => {
    const ok = path.join(sandbox, 'repo', '.config.json')
    await expect(guards.assertConfigWritable(ok)).resolves.toBeUndefined()
    for (const bad of [path.join(homeDir, '.claude', 'settings.json'), path.join(homeDir, '.codex', 'config.toml'), 'relative/.config.json']) {
      await expect(guards.assertConfigWritable(bad)).rejects.toMatchObject({ code: 'CONFIG_PATH_NOT_ALLOWED' })
    }
  })

  it('TC-2 原配置已损坏 → 拒绝覆盖', async () => {
    const file = path.join(sandbox, '.config.json')
    await fs.writeFile(file, '{ broken')
    await expect(guards.assertConfigWritable(file)).rejects.toMatchObject({ code: 'CONFIG_CORRUPTED' })
    expect(await fs.readFile(file, 'utf8')).toBe('{ broken')
  })

  it('TC-3 读取损坏配置 → 返回失败，原文件原地不动，不产生改名备份', async () => {
    const file = path.join(sandbox, '.config.json')
    await fs.writeFile(file, '{ broken')
    await expect(guards.readConfigFile(file)).resolves.toEqual({ exists: true, data: null, error: 'CONFIG_CORRUPTED' })
    expect(await fs.readdir(sandbox)).toEqual(['.config.json', 'home'])
  })

  it('TC-4 只能读 .config.json', async () => {
    await expect(guards.readConfigFile(path.join(homeDir, '.claude', 'settings.json'))).rejects.toMatchObject({ code: 'CONFIG_PATH_NOT_ALLOWED' })
  })
})

describe('复制', () => {
  it('TC-5 Skill 文件夹 → 同名文件夹可以；其余拒绝', async () => {
    const source = await writeSkill(path.join(homeDir, '.claude', 'skills'), 'demo')
    // 放行时返回规范化后的路径，执行必须用它们
    await expect(guards.assertSkillCopy(source, path.join(sandbox, 'repo', 'demo'))).resolves.toEqual({ source, target: path.join(sandbox, 'repo', 'demo') })
    await expect(guards.assertSkillCopy(source, path.join(homeDir, '.claude', 'settings.json'))).rejects.toMatchObject({ code: 'COPY_NOT_ALLOWED' })
    await expect(guards.assertSkillCopy(source, path.join(source, 'nested', 'demo'))).rejects.toMatchObject({ code: 'COPY_NOT_ALLOWED' })
    const notSkill = path.join(sandbox, 'plain')
    await fs.mkdir(notSkill)
    await expect(guards.assertSkillCopy(notSkill, path.join(sandbox, 'repo', 'plain'))).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
  })
})

describe('删除', () => {
  it('TC-6 真删：Skill 目录、.agents/skills 下目录删掉；软链接只删链接，链接目标完好', async () => {
    const a = await writeSkill(path.join(homeDir, '.claude', 'skills'), 'a')
    const b = await writeSkill(path.join(homeDir, '.agents', 'skills'), 'b')
    const target = await writeSkill(path.join(sandbox, 'repo'), 'c')
    const link = path.join(homeDir, '.claude', 'skills', 'c')
    await fs.symlink(target, link)
    for (const p of [a, b, link]) await guards.deleteSkillPath(p, homeDir)
    for (const p of [a, b, link]) await expect(fs.lstat(p)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('# c\n')
  })

  it('TC-6b 拒绝：根目录本身、非 Skill 目录、经软链接父目录跳出白名单', async () => {
    const root = path.join(homeDir, '.claude', 'skills')
    await fs.mkdir(root, { recursive: true })
    await expect(guards.assertSkillDelete(root, homeDir)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    const plain = path.join(root, 'plain')
    await fs.mkdir(plain)
    await expect(guards.assertSkillDelete(plain, homeDir)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    const outside = path.join(sandbox, 'outside')
    await writeSkill(outside, 'victim')
    await fs.symlink(outside, path.join(root, 'escape'))
    await expect(guards.deleteSkillPath(path.join(root, 'escape', 'victim'), homeDir)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    expect(await fs.readFile(path.join(outside, 'victim', 'SKILL.md'), 'utf8')).toBe('# victim\n')
  })

  it('R-1 路径带尾斜杠 / 经链接的 .. 也只删链接，不删链接目标里的内容', async () => {
    const root = path.join(homeDir, '.claude', 'skills')
    const outside = await writeSkill(path.join(sandbox, 'outside'), 'demo')
    await fs.mkdir(root, { recursive: true })
    await fs.symlink(outside, path.join(root, 'demo'))
    await guards.deleteSkillPath(`${path.join(root, 'demo')}/`, homeDir)
    expect(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe('# demo\n')
    await expect(fs.lstat(path.join(root, 'demo'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeSkill(path.join(sandbox, 'outside'), 'victim')
    await fs.symlink(outside, path.join(root, 'link'))
    // link/../victim 规范化成 root/victim：该路径不存在 → 什么都不删（绝不会顺着链接删到外面）
    await expect(guards.deleteSkillPath(path.join(root, 'link', '..', 'victim'), homeDir)).resolves.toBeUndefined()
    expect(await fs.readFile(path.join(sandbox, 'outside', 'victim', 'SKILL.md'), 'utf8')).toBe('# victim\n')
  })
})

describe('复制：审核修复', () => {
  it('R-2 经软链接上级也挡得住「目标是源的上级」', async () => {
    const real = path.join(sandbox, 'real')
    const nestedSkill = await writeSkill(path.join(real, 'demo', 'nested'), 'demo')
    await fs.writeFile(path.join(real, 'demo', 'keep.txt'), 'keep')
    await fs.symlink(real, path.join(sandbox, 'alias'))
    await expect(guards.copySkillFolder(nestedSkill, path.join(sandbox, 'alias', 'demo'))).rejects.toMatchObject({ code: 'COPY_NOT_ALLOWED' })
    expect(await fs.readFile(path.join(real, 'demo', 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('R-3 目标是已存在的非 Skill 目录（如 ~/.claude、~/Documents）→ 拒绝，原文件不动', async () => {
    const staging = path.join(sandbox, 'staging', '.claude')
    await fs.mkdir(staging, { recursive: true })
    await fs.writeFile(path.join(staging, 'SKILL.md'), '# x\n')
    await fs.writeFile(path.join(staging, 'settings.json'), '{"evil":true}')
    const realClaude = path.join(homeDir, '.claude')
    await fs.mkdir(realClaude, { recursive: true })
    await fs.writeFile(path.join(realClaude, 'settings.json'), '{"keep":true}')
    await expect(guards.copySkillFolder(staging, realClaude)).rejects.toMatchObject({ code: 'COPY_NOT_ALLOWED' })
    expect(await fs.readFile(path.join(realClaude, 'settings.json'), 'utf8')).toBe('{"keep":true}')
    const source = await writeSkill(path.join(sandbox, 'src'), 'Documents')
    await fs.mkdir(path.join(homeDir, 'Documents', 'private'), { recursive: true })
    await expect(guards.copySkillFolder(source, path.join(homeDir, 'Documents'))).rejects.toMatchObject({ code: 'COPY_NOT_ALLOWED' })
  })

  it('R-4 真复制：工具目录 → 仓库同名，覆盖已有 Skill 目录', async () => {
    const source = await writeSkill(path.join(homeDir, '.claude', 'skills'), 'demo')
    const target = await writeSkill(path.join(sandbox, 'my repo'), 'demo')
    await fs.writeFile(path.join(source, 'SKILL.md'), '# new\n')
    await guards.copySkillFolder(source, target, { force: true })
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('# new\n')
  })
})

describe('store 与 ensure-dir', () => {
  it('TC-7 store 只开放用量目标两个键', () => {
    expect(guards.isRendererStoreKey('usageGoal')).toBe(true)
    expect(guards.isRendererStoreKey('usageGoalDismissed')).toBe(true)
    for (const key of ['plan', 'codepal-active-module', 'docBrowser', '', null]) expect(guards.isRendererStoreKey(key)).toBe(false)
  })
})

describe('main.js 接线', () => {
  const main = readFileSync(path.resolve(__dirname, '..', '..', 'electron', 'main.js'), 'utf-8')
  const handler = (channel) => {
    const start = main.indexOf(`ipcMain.handle('${channel}'`)
    expect(start).toBeGreaterThan(-1)
    return main.slice(start, main.indexOf('\n})', start))
  }

  it('TC-1/2 write-config 先过 assertConfigWritable', () => expect(handler('write-config')).toMatch(/assertConfigWritable\(/))
  it('TC-3/4 read-config 用 readConfigFile，且不再改名', () => {
    expect(handler('read-config')).toMatch(/readConfigFile\(/)
    expect(main).not.toMatch(/backupCorruptedConfig/)
  })
  it('TC-5 copy-skill 走 copySkillFolder（校验与复制同一路径）', () => {
    expect(handler('copy-skill')).toMatch(/copySkillFolder\(/)
    expect(handler('copy-skill')).not.toMatch(/fs\.cp\(/)
  })
  it('TC-6 delete-skill 走 deleteSkillPath（校验与删除同一路径）', () => {
    expect(handler('delete-skill')).toMatch(/deleteSkillPath\(/)
    expect(handler('delete-skill')).not.toMatch(/fs\.rm\(/)
  })
  it('TC-7 get/set/delete-store 检查键白名单', () => {
    for (const ch of ['get-store', 'set-store', 'delete-store']) expect(handler(ch)).toMatch(/isRendererStoreKey\(/)
  })
  it('TC-9 ensure-dir 拒绝相对路径', () => expect(handler('ensure-dir')).toMatch(/path\.isAbsolute\(/))
  it('TC-8 导航守卫拿到应用入口路径', () => expect(main).toMatch(/appEntryPath/))
})

describe('取消推送的删除入口（registerSkillHandlers）', () => {
  it('TC-10 页面传来的 skillName 为 .. 时不能删到工具目录的上级', async () => {
    const root = path.join(homeDir, '.claude', 'skills')
    await fs.mkdir(root, { recursive: true })
    await expect(guards.assertSkillDelete(path.join(root, '..'), homeDir)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    const handlers = readFileSync(path.resolve(__dirname, '..', '..', 'electron', 'handlers', 'registerSkillHandlers.js'), 'utf-8')
    expect(handlers).toMatch(/await deleteSkillPath\(skillPath\)/)
    expect(handlers).not.toMatch(/isPathInAllowedDirs|fs\.rm\(skillPath/)
  })
})

// ── 第 2 轮复审（NOT_ACK：大小写比较 / 点开头误拒 / 嵌套仓库删不掉）后补的用例 ──
describe('Task 3 · 第 2 轮复审修复', () => {
  it('R-6 以点开头的合法 Skill（.private）可以导入、推送、删除', async () => {
    const source = await writeSkill(path.join(homeDir, '.claude', 'skills'), '.private')
    const target = path.join(sandbox, 'repo', '.private')
    await guards.copySkillFolder(source, target)
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('# .private\n')
    await guards.deleteSkillPath(source, homeDir)
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('R-7 嵌套在默认仓库下的自定义仓库（SkillManager/team）里的 Skill 可以删', async () => {
    const skill = await writeSkill(path.join(homeDir, 'Documents', 'SkillManager', 'team'), 'demo')
    await guards.deleteSkillPath(skill, homeDir)
    await expect(fs.lstat(skill)).rejects.toMatchObject({ code: 'ENOENT' })
    // 仓库目录本身（不是 Skill）仍然不能删
    await expect(guards.deleteSkillPath(path.join(homeDir, 'Documents', 'SkillManager', 'team'), homeDir)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
  })

  it('R-8 模块不再用「转小写」判断目录是否相同（改用文件身份）', () => {
    const src = readFileSync(path.resolve(__dirname, '..', '..', 'electron', 'services', 'genericFileGuards.js'), 'utf-8')
    expect(src).not.toMatch(/toLowerCase\(\)/)
    expect(src).toMatch(/\.ino/)
  })
})
