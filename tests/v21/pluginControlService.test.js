/**
 * v2.1 Plugin 控制中心服务测试
 *
 * 命令全部由 fake runner 接管，配置写入 mkdtemp 临时目录。
 *
 * @module tests/v21/pluginControlService
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import TOML from '@iarna/toml'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let getPluginControlSnapshot
let executePluginCommand
let setCodexPluginEnabled

beforeAll(async () => {
  const modulePath = '../../electron/services/pluginControlService.js'
  try {
    const module = await import(/* @vite-ignore */ modulePath)
    ;({ getPluginControlSnapshot, executePluginCommand, setCodexPluginEnabled } = module.default || module)
  } catch (error) {
    throw new Error(`not implemented: ${error.message}`)
  }
})

function result(value) {
  return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 }
}

describe('v2.1 Plugin control service', () => {
  let sandbox
  let homeDir

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-v21-'))
    homeDir = path.join(sandbox, 'home')
    await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true })
  })

  afterEach(async () => fs.rm(sandbox, { recursive: true, force: true }))

  it('SC-101 normalizes Codex object and Claude array without exposing local paths', async () => {
    const runCommand = vi.fn(async (binary) => binary === 'codex'
      ? result({ installed: [{ pluginId: 'docs@official', name: 'docs', marketplaceName: 'official', version: '1.2.3', installed: true, enabled: true, source: { source: 'local', path: '/secret/cache/docs' }, authPolicy: 'ON_USE', skills: ['write'] }], available: [] })
      : result([{ pluginId: 'review@team', name: 'review', marketplaceName: 'team', version: '2.0.0', enabled: false, scope: 'user', installPath: '/secret/claude/review', commands: ['review'], mcpServers: ['git'] }]))

    const snapshot = await getPluginControlSnapshot({ homeDir }, { runCommand })
    expect(snapshot.partial).toBe(false)
    expect(snapshot.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'docs@official', toolId: 'codex', installed: true, capabilities: expect.objectContaining({ skills: 1 }) }),
      expect.objectContaining({ id: 'review@team', toolId: 'claude-code', enabled: false, capabilities: expect.objectContaining({ commands: 1, mcp: 1 }) }),
    ]))
    expect(JSON.stringify(snapshot)).not.toContain('/secret/')
  })

  it('SC-102 keeps one provider usable when the other CLI fails', async () => {
    const runCommand = vi.fn(async (binary) => {
      if (binary === 'codex') throw Object.assign(new Error('contains /Users/name and token'), { code: 'ENOENT' })
      return result([])
    })
    const snapshot = await getPluginControlSnapshot({ homeDir }, { runCommand })
    expect(snapshot.partial).toBe(true)
    expect(snapshot.tools.codex.available).toBe(false)
    expect(snapshot.tools['claude-code'].available).toBe(true)
    expect(snapshot.errors).toContainEqual({ toolId: 'codex', code: 'CLI_NOT_AVAILABLE' })
    expect(JSON.stringify(snapshot)).not.toContain('/Users/name')
    expect(JSON.stringify(snapshot)).not.toContain('token')
  })

  it('SC-101 treats Claude object.available entries as not installed', async () => {
    const runCommand = vi.fn(async (binary) => binary === 'codex'
      ? result({ installed: [], available: [] })
      : result({ installed: [], available: [{ pluginId: 'future@team', name: 'future', marketplaceName: 'team' }] }))
    const snapshot = await getPluginControlSnapshot({ homeDir }, { runCommand })
    expect(snapshot.plugins).toContainEqual(expect.objectContaining({ id: 'future@team', installed: false, enabled: false }))
  })

  it('SC-103 preserves unknown TOML while toggling a native Codex plugin table', async () => {
    const configPath = path.join(homeDir, '.codex', 'config.toml')
    await fs.writeFile(configPath, [
      'model = "gpt-5"',
      '',
      '[plugins."docs@official"]',
      'source = "marketplace"',
      'enabled = true # keep comment',
      '',
      '[plugins."other@market"]',
      'enabled = true',
      '',
    ].join('\n'))
    await setCodexPluginEnabled(configPath, 'docs@official', false)
    await setCodexPluginEnabled(configPath, 'docs@official', true)
    const text = await fs.readFile(configPath, 'utf8')
    const parsed = TOML.parse(text)
    expect(text).toContain('model = "gpt-5"')
    expect(text).toContain('source = "marketplace"')
    expect(text.match(/\[plugins\."docs@official"\]/g)).toHaveLength(1)
    expect(text).toContain('enabled = true # keep comment')
    expect(parsed.plugins['docs@official'].enabled).toBe(true)
    expect(parsed.plugins['other@market'].enabled).toBe(true)
  })

  it('SC-103 serializes concurrent Codex config writes without losing either plugin', async () => {
    const configPath = path.join(homeDir, '.codex', 'config.toml')
    await fs.writeFile(configPath, 'model = "gpt-5"\n')
    await Promise.all([
      setCodexPluginEnabled(configPath, 'first@official', false),
      setCodexPluginEnabled(configPath, 'second@official', true),
    ])
    const text = await fs.readFile(configPath, 'utf8')
    const parsed = TOML.parse(text)
    expect(parsed.plugins['first@official'].enabled).toBe(false)
    expect(parsed.plugins['second@official'].enabled).toBe(true)
  })

  it('SC-104 uses fixed Codex add/remove commands then rereads native state', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(result({ ok: true }))
      .mockResolvedValueOnce(result({ installed: [], available: [] }))
      .mockResolvedValueOnce(result([]))
    const response = await executePluginCommand({ homeDir, toolId: 'codex', pluginId: 'docs@official', action: 'install' }, { runCommand })
    expect(runCommand).toHaveBeenNthCalledWith(1, 'codex', ['plugin', 'add', 'docs@official', '--json'], expect.objectContaining({ shell: false }))
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(response.snapshot).toBeTruthy()
    expect(response.verified).toBe(true)
  })

  it('SC-105 maps the complete Claude lifecycle to whitelisted argv', async () => {
    for (const [action, expected] of [
      ['install', ['plugin', 'install', 'review@team', '--scope', 'user', '--yes']],
      ['enable', ['plugin', 'enable', 'review@team', '--scope', 'user']],
      ['disable', ['plugin', 'disable', 'review@team', '--scope', 'user']],
      ['update', ['plugin', 'update', 'review@team', '--scope', 'user', '--yes']],
      ['uninstall', ['plugin', 'uninstall', 'review@team', '--scope', 'user', '--yes']],
    ]) {
      const runCommand = vi.fn()
        .mockResolvedValueOnce(result({ ok: true }))
        .mockResolvedValueOnce(result({ installed: [], available: [] }))
        .mockResolvedValueOnce(result([]))
      await executePluginCommand({ homeDir, toolId: 'claude-code', pluginId: 'review@team', action, scope: 'user' }, { runCommand })
      expect(runCommand).toHaveBeenNthCalledWith(1, 'claude', expected, expect.objectContaining({ shell: false }))
    }
  })

  it('SC-107 rejects invalid ids, actions and scopes before invoking a process', async () => {
    const runCommand = vi.fn()
    await expect(executePluginCommand({ homeDir, toolId: 'codex', pluginId: '../escape', action: 'install' }, { runCommand })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_ID' })
    await expect(executePluginCommand({ homeDir, toolId: 'claude-code', pluginId: 'ok@market', action: 'run-anything' }, { runCommand })).rejects.toMatchObject({ code: 'ACTION_NOT_SUPPORTED' })
    await expect(executePluginCommand({ homeDir, toolId: 'claude-code', pluginId: 'ok@market', action: 'install', scope: 'root' }, { runCommand })).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('SC-106 maps protected CLI failures to a stable redacted error code', async () => {
    const runCommand = vi.fn(async () => {
      const error = Object.assign(new Error('command failed in /Users/private'), { stderr: 'plugin is managed by administrator policy' })
      throw error
    })
    await expect(executePluginCommand({ homeDir, toolId: 'codex', pluginId: 'managed@official', action: 'uninstall' }, { runCommand }))
      .rejects.toMatchObject({ code: 'PLUGIN_MANAGED_OR_PROTECTED', message: 'PLUGIN_MANAGED_OR_PROTECTED' })
  })
})
