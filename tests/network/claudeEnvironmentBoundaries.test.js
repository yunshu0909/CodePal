// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { inspectEnvironment } = require('../../electron/modules/claudeEnvironment/inspect')
const { registerClaudeEnvironmentHandlers } = require('../../electron/modules/claudeEnvironment/ipc')
const folders = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true }))) })

describe('只读安装与接口边界', () => {
  it('仅从可信家目录定位，元数据异常保守处理，不执行启动器', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-env-fixture-'))
    folders.push(home)
    const root = path.join(home, 'Library/Application Support/Claude-US')
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(path.join(home, '.local/bin'), { recursive: true })
    await fs.writeFile(path.join(root, 'installation.json'), JSON.stringify({ http_proxy_port: 17897, dns_port: 17853, expected_exit_ip: '203.0.113.24', expected_country: 'US', api_key: 'fake_secret_do_not_return' }))
    await fs.writeFile(path.join(root, 'network.sb'), '(version 1)\n(allow default)\n(deny network*)')
    await fs.writeFile(path.join(root, 'launcher.py'), '# sandbox-exec\nraise Exception("must not execute")')
    await fs.symlink(path.join(root, 'launcher.py'), path.join(home, '.local/bin/claude'))
    const data = await inspectEnvironment({ homeDir: home, platform: 'darwin' })
    expect(data.available).toBe(true)
    expect(data.entryManaged).toBe(true)
    expect(JSON.stringify(data)).not.toContain('fake_secret_do_not_return')
    await fs.writeFile(path.join(root, 'installation.json'), '{broken')
    expect((await inspectEnvironment({ homeDir: home, platform: 'darwin' })).reason).toBe('configuration')
    expect((await inspectEnvironment({ homeDir: home, platform: 'win32' })).reason).toBe('unsupported')
  })

  it('IPC 不把渲染层的文件路径或命令交给采集器', async () => {
    const handlers = new Map()
    const service = { readState: vi.fn(async () => ({})), sampleOnce: vi.fn(async () => ({})), setMonitoring: vi.fn(async () => ({})), setForeground: vi.fn(), subscribe: () => () => {}, dispose: vi.fn() }
    const module = registerClaudeEnvironmentHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, getWindow: () => null, service })
    const payload = { root: '/tmp/arbitrary', command: '/bin/sh' }
    await handlers.get('claude-environment:read')({}, payload)
    await handlers.get('claude-environment:probe')({}, payload)
    expect(service.readState).toHaveBeenCalledWith()
    expect(service.sampleOnce).toHaveBeenCalledWith()
    await module.dispose()
  })

  it('DNS TXT 解码保留 ns 与 ecs 的区别，并拒绝截断或不匹配的包', () => {
    const file = path.resolve('electron/modules/claudeEnvironment/network_probe.py')
    const script = `import importlib.util,struct\ns=importlib.util.spec_from_file_location('probe',${JSON.stringify(file)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ndef record(parts):\n b=b''.join(bytes([len(p)])+p.encode() for p in parts)\n return b'\\x00'+struct.pack('!HHIH',16,1,60,len(b))+b\np=struct.pack('!6H',42,0x8180,0,2,0,0)+record(['ns','8.8.8.8'])+record(['ecs','203.0.113.0/24'])\nassert m.txt_records(p,42)==[['ns','8.8.8.8'],['ecs','203.0.113.0/24']]\nfor data,ident in [(p[:20],42),(p,43)]:\n try: m.txt_records(data,ident)\n except (ValueError,IndexError,struct.error): pass\n else: raise Exception('invalid packet accepted')\nprint('DNS protocol cases passed')\n`
    const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('DNS protocol cases passed')
  })
})
