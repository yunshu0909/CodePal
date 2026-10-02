/**
 * Skills 只留一套引擎（specs/v2.1.9-Skills只留一套引擎）：资产库路径由主进程给
 *
 * 负责：
 * - TC-003：主进程照旧逻辑读 ~/Documents/SkillManager/.config.json 的 repoPath；
 *   `skill-control:get-repo-path` 返回它；新页面经它拿路径，不再经过旧 store
 * - 只在 mkdtemp 建的临时家目录里读写
 *
 * @module tests/skills/skillRepoPath.test
 */

import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

function loadService() {
  try {
    return require('../../electron/services/skillRepoPath')
  } catch {
    return null
  }
}

let homeDir

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-repo-path-'))
})

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true })
})

async function writeConfig(dir, data) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, '.config.json'), JSON.stringify(data))
}

describe('资产库路径由主进程给', () => {
  it('TC-003 REPO_PATH_MAIN 没配置用默认；锚点写了别处就跟过去；IPC 返回它；页面不再经过旧 store', async () => {
    const service = loadService()
    expect(service, 'REPO_PATH_MAIN 缺少 electron/services/skillRepoPath.js').toBeTruthy()
    const { resolveSkillRepoPath } = service

    expect(await resolveSkillRepoPath({ homeDir }), 'REPO_PATH_MAIN 没有配置文件时用默认位置').toBe('~/Documents/SkillManager/')
    // 读取不创建任何东西：没有配置时读完家目录还是空的
    expect(await fs.readdir(homeDir), 'REPO_PATH_MAIN 读取时创建了文件').toEqual([])

    // 旧版改位置时新位置和锚点各写一份带 repoPath 的配置：读到的就是新位置（补末尾斜杠）
    const anchor = path.join(homeDir, 'Documents', 'SkillManager')
    const moved = path.join(homeDir, 'elsewhere', 'Skills')
    await writeConfig(anchor, { repoPath: moved })
    await writeConfig(moved, { repoPath: moved })
    expect(await resolveSkillRepoPath({ homeDir }), 'REPO_PATH_MAIN 锚点写了别处').toBe(`${moved}/`)

    // 新位置的配置又指向别处：以它为准；读取不改配置、不建目录
    const final = path.join(homeDir, 'final')
    await writeConfig(moved, { repoPath: final })
    expect(await resolveSkillRepoPath({ homeDir })).toBe(`${final}/`)
    expect(JSON.parse(await fs.readFile(path.join(moved, '.config.json'), 'utf8')), 'REPO_PATH_MAIN 读取改了第二层配置').toEqual({ repoPath: final })
    await expect(fs.access(final), 'REPO_PATH_MAIN 读取时建了目录').rejects.toThrow()

    // 旧版每处配置都用默认配置打底：新位置的配置没写 repoPath、不存在、坏了、读不出，都落回默认位置
    await writeConfig(moved, { version: '0.4' })
    expect(await resolveSkillRepoPath({ homeDir }), 'REPO_PATH_MAIN 第二层没写 repoPath').toBe('~/Documents/SkillManager/')
    await fs.rm(path.join(moved, '.config.json'))
    expect(await resolveSkillRepoPath({ homeDir }), 'REPO_PATH_MAIN 第二层不存在').toBe('~/Documents/SkillManager/')
    await expect(fs.access(path.join(moved, '.config.json')), 'REPO_PATH_MAIN 读取时创建了配置').rejects.toThrow()
    await fs.writeFile(path.join(moved, '.config.json'), '{ broken')
    expect(await resolveSkillRepoPath({ homeDir }), 'REPO_PATH_MAIN 第二层坏配置').toBe('~/Documents/SkillManager/')
    expect(await fs.readFile(path.join(moved, '.config.json'), 'utf8'), 'REPO_PATH_MAIN 读取时修复了坏配置').toBe('{ broken')
    await fs.rm(path.join(moved, '.config.json'))
    await fs.mkdir(path.join(moved, '.config.json'))
    expect(await resolveSkillRepoPath({ homeDir }), 'REPO_PATH_MAIN 第二层读不出').toBe('~/Documents/SkillManager/')
    await fs.rm(path.join(moved, '.config.json'), { recursive: true })

    // 锚点坏了、读不出：同样落回默认位置，坏配置不被修复
    await fs.writeFile(path.join(anchor, '.config.json'), '{ not json')
    expect(await resolveSkillRepoPath({ homeDir })).toBe('~/Documents/SkillManager/')
    expect(await fs.readFile(path.join(anchor, '.config.json'), 'utf8'), 'REPO_PATH_MAIN 读取时修复了坏配置').toBe('{ not json')
    await fs.rm(path.join(anchor, '.config.json'))
    await fs.mkdir(path.join(anchor, '.config.json'))
    expect(await resolveSkillRepoPath({ homeDir }), 'REPO_PATH_MAIN 锚点读不出').toBe('~/Documents/SkillManager/')
    await fs.rm(path.join(anchor, '.config.json'), { recursive: true })

    const handlers = {}
    const { registerSkillControlHandlers } = require('../../electron/handlers/registerSkillControlHandlers')
    registerSkillControlHandlers({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } }, homeDir })
    expect(typeof handlers['skill-control:get-repo-path'], 'REPO_PATH_MAIN 缺少 skill-control:get-repo-path').toBe('function')
    await writeConfig(anchor, { repoPath: moved })
    await writeConfig(moved, { repoPath: moved })
    const anchorBefore = await fs.readFile(path.join(anchor, '.config.json'))
    expect(await handlers['skill-control:get-repo-path']({})).toEqual({ success: true, data: `${moved}/`, error: null })
    // 经页面入口读取后：锚点配置逐字不变
    expect((await fs.readFile(path.join(anchor, '.config.json'))).equals(anchorBefore), 'REPO_PATH_MAIN 读取改了锚点配置').toBe(true)

    const preload = readFileSync(path.join(root, 'electron', 'preload.js'), 'utf-8')
    expect(preload, 'REPO_PATH_MAIN preload 缺少 getSkillRepoPath').toMatch(/^\s{2}getSkillRepoPath\s*:.*'skill-control:get-repo-path'/m)
    const hook = readFileSync(path.join(root, 'src', 'hooks', 'useSkillControl.js'), 'utf-8')
    expect(hook, 'REPO_PATH_MAIN 页面仍经过旧 store').not.toMatch(/store\/data/)
    expect(hook).toMatch(/store\/skillRepoPath/)
  })
})
