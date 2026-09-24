/**
 * Codex 配置写入网关 + 足迹清单（架构优化 B2-6，roadmap 路线 5）
 *
 * 负责：
 * - Skills、Plugins、会话状态、Plugin CLI 对 ~/.codex/config.toml 的修改都进同一把锁（Codex 配置负责人）
 * - Plugins 开关：提交前复验，外部改动 → 冲突；改完只允许变目标字段
 * - 会话状态：配置坏了拒绝写；只留一份滚动备份，不再每次攒一个带时间戳的 .bak
 * - 足迹清单：CodePal 装进别的工具的东西（会话状态钩子等）装时登记、卸时注销
 *
 * 所有写入只发生在 mkdtemp 创建的临时 HOME。
 *
 * @module tests/safety/writeGateway.test
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const owner = require('../../electron/services/codexConfigOwner')
const footprint = require('../../electron/services/footprintRegistry')
const { setCodexPluginEnabled, executePluginCommand } = require('../../electron/services/pluginControlService')
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
  const home = await mkdtemp(path.join(os.tmpdir(), 'codepal-gateway-'))
  await mkdir(path.join(home, '.codex'), { recursive: true })
  return home
}

describe('B2-6 所有 Codex 配置写入进同一把锁', () => {
  it('G-1 Plugins 开关与 Skill 开关同时发生，两个改动都保留', async () => {
    const home = await tempHome()
    const skill = path.join(home, '.agents', 'skills', 'a')
    await mkdir(skill, { recursive: true })
    await writeFile(path.join(skill, 'SKILL.md'), '# a\n')
    const configPath = path.join(home, '.codex', 'config.toml')
    await writeFile(configPath, `[[skills.config]]\npath = "${skill}"\nenabled = true\n\n[plugins."docs@official"]\nenabled = true\n`)
    await Promise.all([
      setCodexPluginEnabled(configPath, 'docs@official', false),
      applyCodexCommand({ homeDir: home, skillName: 'a', action: 'disable', source: { absolutePath: skill } }),
    ])
    const text = await readFile(configPath, 'utf8')
    expect(text).toMatch(/\[plugins\."docs@official"\]\nenabled = false/)
    expect(text).toMatch(/path = ".*\/a"\nenabled = false/)
  })

  it('G-2 Plugins 开关提交前被外部改动 → 冲突，保留外部版本', async () => {
    const home = await tempHome()
    const configPath = path.join(home, '.codex', 'config.toml')
    await writeFile(configPath, '[plugins."docs@official"]\nenabled = true\n')
    const external = 'model = "external"\n'
    await expect(setCodexPluginEnabled(configPath, 'docs@official', false, { beforeConfigCommit: () => writeFile(configPath, external) }))
      .rejects.toMatchObject({ code: 'CODEX_CONFIG_CONFLICT' })
    expect(await readFile(configPath, 'utf8')).toBe(external)
  })

  it('G-3 Codex Plugin CLI（安装 / 卸载）要等拿到配置锁才执行', async () => {
    const home = await tempHome()
    const order = []
    let release
    const holding = owner.withConfigLock(() => new Promise((resolve) => { release = () => { order.push('lock-released'); resolve() } }))
    const runCommand = vi.fn(async () => { order.push('cli'); return { code: 0, stdout: '{}', stderr: '' } })
    const pending = executePluginCommand({ homeDir: home, toolId: 'codex', pluginId: 'docs@official', action: 'install' }, { runCommand }).catch(() => {})
    await new Promise((r) => setTimeout(r, 30))
    expect(runCommand).not.toHaveBeenCalled()
    release()
    await holding
    await pending
    // 装完会再调几次 CLI 刷新插件状态（既有行为）；关键是第一次调用一定在锁释放之后
    expect(order.slice(0, 2)).toEqual(['lock-released', 'cli'])
  })
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
    const plugin = read('electron/services/pluginControlService.js')
    const session = read('electron/services/sessionStatusService.js')
    expect(plugin).toMatch(/require\('\.\/codexConfigOwner'\)/)
    expect(plugin).not.toMatch(/codexConfigWriteQueue/)
    expect(session).toMatch(/require\('\.\/codexConfigOwner'\)/)
    expect(session).not.toMatch(/atomicWriteText\(CODEX_CONFIG_PATH/)
  })
})
