/**
 * v2.2 Harness 生命周期服务测试
 *
 * 命令全部由 fake runner 接管，托管目录落在 mkdtemp 沙箱，不触碰真实安装。
 *
 * @module tests/v22/harnessLifecycleService
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let service

beforeAll(async () => {
  const modulePath = '../../electron/services/harnessLifecycleService.js'
  try {
    const module = await import(/* @vite-ignore */ modulePath)
    service = module.default || module
  } catch (error) {
    throw new Error(`not implemented: ${error.message}`)
  }
})

/** 造一个只响应显式命令的假执行器；未配置的命令一律失败。 */
function makeRunner(table = {}) {
  return vi.fn(async (binary, args) => {
    const key = `${path.basename(binary)} ${args.join(' ')}`
    for (const [pattern, value] of Object.entries(table)) {
      if (key.includes(pattern)) {
        if (value instanceof Error) throw value
        return { stdout: value, stderr: '', exitCode: 0 }
      }
    }
    const error = new Error(`unexpected command: ${key}`)
    error.code = 'ENOENT'
    throw error
  })
}

/** 写一个托管安装的 package.json，让 readManagedVersion 能读到版本。 */
async function seedManagedInstall(runtimeDir, version) {
  const pkgDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  await fs.mkdir(path.join(pkgDir, 'lib'), { recursive: true })
  await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  await fs.writeFile(path.join(pkgDir, 'lib', 'bin.js'), '// entry\n')
}

const NODE_OK = 'v24.11.1'
const NPM_OK = { stdout: '10.0.0\n', stderr: '', exitCode: 0 }

describe('v2.2 Harness lifecycle service', () => {
  let sandbox
  let homeDir
  let runtimeDir
  let userDataDir
  let nodeDir

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-v22-'))
    homeDir = path.join(sandbox, 'home')
    runtimeDir = path.join(homeDir, 'Documents', 'SkillManager', 'runtimes', 'dsh')
    userDataDir = path.join(sandbox, 'userData')
    nodeDir = path.join(sandbox, 'bin')
    await fs.mkdir(homeDir, { recursive: true })
    await fs.mkdir(userDataDir, { recursive: true })
    await fs.mkdir(nodeDir, { recursive: true })
    // resolveNodeRuntime 要求 node 与 npm 同目录并存
    await fs.writeFile(path.join(nodeDir, 'node'), '#!/bin/sh\n')
    await fs.writeFile(path.join(nodeDir, 'npm'), '#!/bin/sh\n')
  })

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  /**
   * 组装一份能跑通探测链的依赖包。
   *
   * 默认把「全机进程表」和「launchd 服务」都封成空：测试绝不该读运行测试那台机器
   * 的真实进程，否则结果依赖环境（本机就真有 dsh 在跑）。
   */
  function depsFor(table = {}, extra = {}) {
    return {
      runCommand: makeRunner({
        'node --version': `${NODE_OK}\n`,
        'npm --version': NPM_OK,
        'ps -Ao pid=,command=': '',
        ...table,
      }),
      homeDir,
      userDataDir,
      nodeBinFromProcess: path.join(nodeDir, 'node'),
      detectManagedServiceFn: async () => null,
      ...extra,
    }
  }

  describe('版本比较（决定「可升级」对不对）', () => {
    it('SC-201 orders prerelease correctly', () => {
      expect(service.compareVersions('0.1.5-rc.2', '0.1.5-rc.1')).toBeGreaterThan(0)
      expect(service.compareVersions('0.1.5-rc.1', '0.1.5-rc.2')).toBeLessThan(0)
      expect(service.compareVersions('0.1.5-rc.2', '0.1.5-rc.2')).toBe(0)
    })

    it('SC-202 ranks a release above its prerelease', () => {
      expect(service.compareVersions('0.1.5', '0.1.5-rc.2')).toBeGreaterThan(0)
      expect(service.compareVersions('0.1.5-rc.2', '0.1.5')).toBeLessThan(0)
      expect(service.compareVersions('0.1.5-rc.10', '0.1.5-rc.9')).toBeGreaterThan(0)
      expect(service.compareVersions('0.1.6-alpha.1', '0.1.5')).toBeGreaterThan(0)
    })

    it('SC-203 treats unparseable input as older instead of equal', () => {
      expect(service.compareVersions('not-a-version', '0.1.5')).toBeLessThan(0)
      expect(service.compareVersions('0.1.5', 'not-a-version')).toBeGreaterThan(0)
    })
  })

  describe('Node 版本门槛', () => {
    it('SC-204 accepts only the supported ranges', () => {
      expect(service.nodeSupported(service.parseNodeVersion('v26.0.0'))).toBe(true)
      expect(service.nodeSupported(service.parseNodeVersion('v24.0.0'))).toBe(true)
      expect(service.nodeSupported(service.parseNodeVersion('v22.19.0'))).toBe(true)
      expect(service.nodeSupported(service.parseNodeVersion('v22.18.0'))).toBe(false)
      expect(service.nodeSupported(service.parseNodeVersion('v20.11.0'))).toBe(false)
      expect(service.nodeSupported(null)).toBe(false)
    })
  })

  describe('就绪输出解析', () => {
    it('SC-205 extracts the URL from the official readiness line', () => {
      const line = 'dsh web: http://127.0.0.1:51423/?token=abc123\n'
      expect(service.parseReadyUrl(line)).toBe('http://127.0.0.1:51423/?token=abc123')
      expect(service.parseReadyUrl('dsh web: opening the default browser')).toBe(null)
      expect(service.parseReadyUrl('')).toBe(null)
    })

    it('SC-206 finds the URL when the line is split across chunks', () => {
      expect(service.parseReadyUrl('booting...\ndsh web: http://127.0.0.1:9')).toBe('http://127.0.0.1:9')
    })
  })

  describe('探测与形态判定', () => {
    it('SC-207 reports nothing installed on a clean machine', async () => {
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor())
      expect(snapshot.install.kind).toBe('none')
      expect(snapshot.install.canUpgrade).toBe(false)
      expect(snapshot.install.canUninstall).toBe(false)
      expect(snapshot.runtime.running).toBe(false)
      expect(snapshot.runtime.mode).toBe('none')
      expect(snapshot.supervisor.kind).toBe('none')
      expect(snapshot.node.supported).toBe(true)
    })

    it('SC-208 recognises a managed install and allows managing it', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor())
      expect(snapshot.install.kind).toBe('managed')
      expect(snapshot.install.version).toBe('0.1.5-rc.2')
      expect(snapshot.install.canUpgrade).toBe(true)
      expect(snapshot.install.canUninstall).toBe(true)
    })

    it('SC-209 recognises a source checkout and can manage it (update + remove supervision)', async () => {
      const sourceDir = path.join(sandbox, 'checkout')
      await fs.mkdir(path.join(sourceDir, 'apps', 'cli'), { recursive: true })
      await fs.mkdir(path.join(sourceDir, '.git'), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }),
      )
      const snapshot = await service.getHarnessSnapshot({ homeDir, sourceDir }, depsFor())
      expect(snapshot.install.kind).toBe('source')
      expect(snapshot.install.sourceVersion).toBe('0.1.5-rc.2')
      expect(snapshot.source.isRepo).toBe(true)
      // npm 那套升级不适用（它走仓库），但 git 更新与摘启动项都可用
      expect(snapshot.install.canUpgrade).toBe(false)
      expect(snapshot.install.canUpdate).toBe(true)
      expect(snapshot.install.canUninstall).toBe(true)
      // 源码形态下不问 npm 通道
      expect(snapshot.registry.skipped).toBe(true)
    })

    it('SC-210 ignores a checkout whose CLI package is not dsh', async () => {
      const sourceDir = path.join(sandbox, 'other')
      await fs.mkdir(path.join(sourceDir, 'apps', 'cli'), { recursive: true })
      await fs.writeFile(path.join(sourceDir, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'some-other-cli' }))
      const snapshot = await service.getHarnessSnapshot({ homeDir, sourceDir }, depsFor())
      expect(snapshot.install.kind).toBe('none')
    })

    it('SC-210b finds a running source checkout from the process table', () => {
      const ps = [
        '  111 /opt/homebrew/bin/node --import tsx/esm apps/cli/src/bin.ts web',
        '  222 node /Users/demo/deepseek-harness/apps/cli/src/bin.ts web',
        '  333 /Users/demo/other/apps/cli/lib/bin.js web',
        '  444 /usr/bin/some unrelated process',
      ].join('\n')
      const entries = service.extractCheckoutRoots(ps)
      // 相对路径形态要带 pid（靠 cwd 补全），绝对路径直接给根
      expect(entries).toEqual([
        { pid: 111, root: null },
        { pid: 222, root: '/Users/demo/deepseek-harness' },
        { pid: 333, root: '/Users/demo/other' },
      ])
    })

    it('SC-210c resolves a relative checkout path through the process cwd', async () => {
      const sourceDir = path.join(sandbox, 'checkout')
      await fs.mkdir(path.join(sourceDir, 'apps', 'cli'), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }),
      )
      // launchd 场景：ps 里只有相对路径，必须用 lsof 拿到 cwd 才能定位
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({
        'ps -Ao pid=,command=': `  95932 /opt/homebrew/bin/node --import tsx/esm apps/cli/src/bin.ts web\n`,
        'lsof -a -p 95932 -d cwd -Fn': `p95932\nfcwd\nn${sourceDir}\n`,
      }, { readdir: async () => [] }))
      expect(snapshot.install.kind).toBe('source')
      expect(snapshot.install.sourceVersion).toBe('0.1.5-rc.2')
      expect(snapshot.install.sourceDir).toBe(sourceDir)
      expect(snapshot.install.canUpgrade).toBe(false)
    })

    it('SC-210d detects the checkout without any env var, so a source install is never shown as missing', async () => {
      const sourceDir = path.join(sandbox, 'checkout')
      await fs.mkdir(path.join(sourceDir, 'apps', 'cli'), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }),
      )
      // 不传 sourceDir：只能靠 ps 认出来（绝对路径形态）
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({
        'ps -Ao pid=,command=': `  1 /opt/homebrew/bin/node --import tsx/esm ${sourceDir}/apps/cli/src/bin.ts web\n`,
      }, { readdir: async () => [] }))
      expect(snapshot.install.kind).toBe('source')
      expect(snapshot.install.sourceVersion).toBe('0.1.5-rc.2')
      expect(snapshot.install.sourceDir).toBe(sourceDir)
      expect(snapshot.install.canUpgrade).toBe(false)
    })

    it('SC-210e keeps a stopped launchd source checkout installed by deriving it from the plist entry', async () => {
      const sourceDir = path.join(sandbox, 'checkout')
      await fs.mkdir(path.join(sourceDir, 'apps', 'cli'), { recursive: true })
      await fs.mkdir(path.join(sourceDir, '.git'), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }),
      )
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({}, {
        detectManagedServiceFn: async () => ({
          label: 'com.dsh.web',
          plistPath: path.join(homeDir, 'Library', 'LaunchAgents', 'com.dsh.web.plist'),
          entry: path.join(sourceDir, 'apps', 'cli', 'src', 'bin.ts'),
          workingDirectory: sourceDir,
          keepAlive: true,
          running: false,
          loaded: false,
          pid: null,
          logPath: path.join(homeDir, '.dsh', 'dsh-web.log'),
        }),
      }))

      expect(snapshot.install.kind).toBe('source')
      expect(snapshot.install.sourceVersion).toBe('0.1.5-rc.2')
      expect(snapshot.install.sourceDir).toBe(sourceDir)
      expect(snapshot.runtime.running).toBe(false)
      expect(snapshot.supervisor.kind).toBe('launchd')
    })

    it('SC-211 marks a managed install as not launchable on an unsupported Node', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({ 'node --version': 'v20.11.0\n' }))
      expect(snapshot.node.supported).toBe(false)
      expect(snapshot.install.canInstall).toBe(false)
    })

    it('SC-212 degrades when the registry is unreachable without breaking the rest', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({ 'npm view': new Error('offline') }))
      expect(snapshot.registry.ok).toBe(false)
      expect(snapshot.registry.upgradeTargets).toEqual({ latest: null, next: null })
      expect(snapshot.install.kind).toBe('managed')
    })

    it('SC-213 offers an upgrade only when the channel is strictly newer', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const tags = JSON.stringify({ versions: ['0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3'], 'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.3' } })
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({ 'npm view': tags }))
      // latest 比已装版本旧：不能提示「可升级」（否则就是降级）
      expect(snapshot.registry.upgradeTargets.latest).toBe(null)
      expect(snapshot.registry.upgradeTargets.next).toBe('0.1.5-rc.3')
    })

    it('SC-214 reports a running dsh process, asking the kernel for its port', async () => {
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({
        'ps -Ao pid=,command=': '  4242 /opt/homebrew/bin/node --import tsx/esm apps/cli/src/bin.ts web\n',
        'lsof -nP -a -p 4242 -iTCP -sTCP:LISTEN -Fn': 'p4242\nn127.0.0.1:3080\n',
      }))
      expect(snapshot.runtime.running).toBe(true)
      expect(snapshot.runtime.pid).toBe(4242)
      expect(snapshot.runtime.mode).toBe('external')
      // 端口只能问内核：launchd/外部进程都没有 sidecar 落盘状态
      expect(snapshot.runtime.port).toBe(3080)
      expect(snapshot.runtime.url).toBe('http://127.0.0.1:3080/')
    })

    it('SC-214c prefers the token URL from the supervisor log when the port matches', async () => {
      const logPath = path.join(sandbox, 'dsh-web.log')
      await fs.writeFile(logPath, 'boot\ndsh web: http://127.0.0.1:3080/?token=tok123\ndsh web: opening the default browser\n')
      const launchd = { kind: 'launchd', label: 'com.dsh.web', plistPath: '/tmp/p.plist', entry: '/tmp/e.ts', keepAlive: true, running: true, pid: 4242, loaded: true, lastExitCode: 0, logPath }
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({
        'ps -Ao pid=,command=': '  4242 /opt/homebrew/bin/node --import tsx/esm apps/cli/src/bin.ts web\n',
        'lsof -nP -a -p 4242 -iTCP -sTCP:LISTEN -Fn': 'p4242\nn127.0.0.1:3080\n',
      }, { detectManagedServiceFn: async () => launchd }))
      // 首次访问需要这条带 token 的地址，所以优先取它
      expect(snapshot.runtime.url).toBe('http://127.0.0.1:3080/?token=tok123')
      expect(snapshot.runtime.port).toBe(3080)
    })

    it('SC-214d never reuses a stale token from another process', async () => {
      const logPath = path.join(sandbox, 'stale.log')
      // 日志里的端口与当前进程实际监听的不一致 → 说明是上一次启动留下的
      await fs.writeFile(logPath, 'dsh web: http://127.0.0.1:9999/?token=oldtok\n')
      const launchd = { kind: 'launchd', label: 'com.dsh.web', plistPath: '/tmp/p.plist', entry: '/tmp/e.ts', keepAlive: true, running: true, pid: 4242, loaded: true, lastExitCode: 0, logPath }
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({
        'ps -Ao pid=,command=': '  4242 /opt/homebrew/bin/node --import tsx/esm apps/cli/src/bin.ts web\n',
        'lsof -nP -a -p 4242 -iTCP -sTCP:LISTEN -Fn': 'p4242\nn127.0.0.1:3080\n',
      }, { detectManagedServiceFn: async () => launchd }))
      expect(snapshot.runtime.url).toBe('http://127.0.0.1:3080/')
      expect(snapshot.runtime.url).not.toContain('oldtok')
    })

    it('SC-214e reads only the tail of a large supervisor log', async () => {
      const logPath = path.join(sandbox, 'big.log')
      await fs.writeFile(logPath, `${'x'.repeat(300 * 1024)}\ndsh web: http://127.0.0.1:3080/?token=tailtok\n`)
      const endpoint = await service.readInstanceEndpoint({ logPath }, depsFor())
      expect(endpoint.port).toBe(3080)
      expect(endpoint.url).toContain('tailtok')
    })

    it('SC-214b reports a launchd-owned instance as launchd mode with its keepAlive', async () => {
      const launchd = { kind: 'launchd', label: 'com.dsh.web', plistPath: '/tmp/com.dsh.web.plist', entry: '/tmp/checkout/apps/cli/src/bin.ts', keepAlive: true, running: true, pid: 4242, loaded: true, lastExitCode: 0, logPath: '/tmp/out.log' }
      const snapshot = await service.getHarnessSnapshot({ homeDir }, depsFor({
        'ps -Ao pid=,command=': '  4242 /opt/homebrew/bin/node --import tsx/esm apps/cli/src/bin.ts web\n',
        'plutil -convert json': JSON.stringify({ Label: 'com.dsh.web', KeepAlive: true, ProgramArguments: ['/opt/homebrew/bin/node', 'apps/cli/src/bin.ts', 'web'] }),
      }, {
        detectManagedServiceFn: async () => launchd,
        fetchFn: async () => ({ status: 200 }),
      }))
      expect(snapshot.runtime.mode).toBe('launchd')
      expect(snapshot.supervisor.kind).toBe('launchd')
      expect(snapshot.supervisor.label).toBe('com.dsh.web')
      expect(snapshot.supervisor.keepAlive).toBe(true)
    })
  })

  describe('启停与落盘', () => {
    /** 造一个受控的假子进程，手动触发就绪行与退出。 */
    function makeFakeChild(pid = 4242) {
      const listeners = {}
      const child = {
        pid,
        stdout: { on: (event, handler) => { listeners[`stdout:${event}`] = handler; return child.stdout } },
        stderr: { on: () => child.stderr },
        killed: null,
        kill: vi.fn((signal) => { child.killed = signal; return true }),
        once: (event, handler) => { listeners[`once:${event}`] = handler; return child },
      }
      return {
        child,
        emit: (event, payload) => listeners[`stdout:${event}`]?.(payload),
        exit: () => listeners['once:exit']?.(0),
      }
    }

    it('SC-215 starts on an OS-assigned port and persists runtime state', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const fake = makeFakeChild()
      const spawnProcess = vi.fn(() => fake.child)
      const childrenMap = new Map()
      const deps = depsFor({}, { spawnProcess, childrenMap })

      const started = service.startHarness({ homeDir }, deps)
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalled())
      const argv = spawnProcess.mock.calls[0][1]
      // --port 0：让 OS 挑空闲端口，从根上避开 EADDRINUSE
      expect(argv).toEqual([expect.stringContaining('bin.js'), 'web', '--port', '0', '--no-open'])
      fake.emit('data', 'dsh web: http://127.0.0.1:51423/?token=tok\n')
      const result = await started
      expect(result.pid).toBe(4242)
      expect(result.port).toBe(51423)
      expect(result.url).toBe('http://127.0.0.1:51423/?token=tok')
      expect(childrenMap.has(4242)).toBe(true)

      const persisted = JSON.parse(await fs.readFile(path.join(userDataDir, 'harness-runtime.json'), 'utf8'))
      expect(persisted.pid).toBe(4242)
      expect(persisted.version).toBe('0.1.5-rc.2')
    })

    it('SC-216 refuses to start a second instance', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const fake = makeFakeChild()
      const childrenMap = new Map()
      const deps = depsFor({}, { spawnProcess: () => fake.child, childrenMap })
      const started = service.startHarness({ homeDir }, deps)
      await vi.waitFor(() => expect(childrenMap.size).toBe(1))
      fake.emit('data', 'dsh web: http://127.0.0.1:51423/\n')
      await started
      await expect(service.startHarness({ homeDir }, deps)).rejects.toMatchObject({ code: 'HARNESS_ALREADY_RUNNING' })
    })

    it('SC-217 fails a start that never announces readiness', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const fake = makeFakeChild()
      const deps = depsFor({}, { spawnProcess: () => fake.child, childrenMap: new Map(), startTimeoutMs: 30 })
      await expect(service.startHarness({ homeDir }, deps)).rejects.toMatchObject({ code: 'HARNESS_START_TIMEOUT' })
      expect(fake.child.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('SC-218 clears persisted state when the process exits, so no dead PID is shown', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const fake = makeFakeChild()
      const childrenMap = new Map()
      const deps = depsFor({}, { spawnProcess: () => fake.child, childrenMap })
      const started = service.startHarness({ homeDir }, deps)
      await vi.waitFor(() => expect(childrenMap.size).toBe(1))
      fake.emit('data', 'dsh web: http://127.0.0.1:51423/\n')
      await started
      expect(await fs.readFile(path.join(userDataDir, 'harness-runtime.json'), 'utf8')).toBeTruthy()
      fake.exit()
      await vi.waitFor(async () => {
        await expect(fs.readFile(path.join(userDataDir, 'harness-runtime.json'), 'utf8')).rejects.toThrow()
      })
      expect(childrenMap.size).toBe(0)
    })

    it('SC-219 stops with SIGTERM and clears state', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const fake = makeFakeChild(4243)
      const childrenMap = new Map()
      const deps = depsFor({}, { spawnProcess: () => fake.child, childrenMap, stopGraceMs: 100 })
      const started = service.startHarness({ homeDir }, deps)
      await vi.waitFor(() => expect(childrenMap.size).toBe(1))
      fake.emit('data', 'dsh web: http://127.0.0.1:51423/\n')
      await started
      const stopped = await service.stopHarness({ homeDir }, deps)
      expect(stopped.stopped).toBe(true)
      expect(fake.child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(childrenMap.size).toBe(0)
    })

    it('SC-220 refuses to stop when nothing is running', async () => {
      await expect(service.stopHarness({ homeDir }, depsFor())).rejects.toMatchObject({ code: 'HARNESS_NOT_RUNNING' })
    })

    it('SC-221 never adopts a foreign PID as its own', async () => {
      // 落盘里写一个属于别的进程的 PID：没有子进程句柄时不认为它在托管之下
      await fs.writeFile(
        path.join(userDataDir, 'harness-runtime.json'),
        JSON.stringify({ pid: process.pid, port: 3080, url: 'http://127.0.0.1:3080/' }),
      )
      const deps = depsFor({}, { childrenMap: new Map() })
      const state = await service.readRuntimeState(deps)
      expect(state).not.toBe(null)
      expect(state.owned).toBe(false)
      await expect(service.stopHarness({ homeDir }, deps)).rejects.toMatchObject({ code: 'HARNESS_MANAGED_ONLY' })
    })
  })

  describe('安装与卸载', () => {
    it('SC-229 安全接管源码安装：选择不降级的 npm 版本并切换 launchd 入口', async () => {
      const sourceDir = path.join(sandbox, 'source-checkout')
      const dshHome = path.join(homeDir, '.dsh')
      await fs.mkdir(path.join(sourceDir, 'apps', 'cli'), { recursive: true })
      await fs.mkdir(path.join(dshHome, 'sessions'), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }),
      )
      await fs.writeFile(path.join(sourceDir, 'local-change.txt'), 'keep me')

      const repointManagedServiceFn = vi.fn(async () => ({ backupPath: '/tmp/com.dsh.web.plist.codepal-backup' }))
      const runCommand = vi.fn(async (binary, args) => {
        if (path.basename(binary) === 'node' && args[0] === '--version') return { stdout: `${NODE_OK}\n`, stderr: '', exitCode: 0 }
        if (path.basename(binary) === 'npm' && args[0] === '--version') return NPM_OK
        if (path.basename(binary) === 'npm' && args[0] === 'view') {
          return { stdout: JSON.stringify({ versions: ['0.1.5-rc.1', '0.1.5-rc.2'], 'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.2' } }), stderr: '', exitCode: 0 }
        }
        if (path.basename(binary) === 'npm' && args[0] === 'install') {
          expect(args).toContain('@deepseek-ai/dsh@0.1.5-rc.2')
          await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        throw new Error(`unexpected command: ${binary} ${args.join(' ')}`)
      })
      const supervisor = { kind: 'launchd', label: 'com.dsh.web', running: true, pid: 4242 }
      const result = await service.takeOverSourceInstallation({ homeDir, sourceDir }, {
        homeDir,
        userDataDir,
        sourceDir,
        nodeBinFromProcess: path.join(nodeDir, 'node'),
        runCommand,
        detectManagedServiceFn: async () => supervisor,
        repointManagedServiceFn,
      })

      expect(result).toMatchObject({ kind: 'managed', adopted: true, version: '0.1.5-rc.2', channel: 'next' })
      expect(repointManagedServiceFn).toHaveBeenCalledWith(expect.objectContaining({
        label: 'com.dsh.web',
        nextBin: service.resolveManagedBinPath(runtimeDir),
        workingDirectory: runtimeDir,
      }), expect.any(Object))
      expect(await fs.readFile(path.join(sourceDir, 'local-change.txt'), 'utf8')).toBe('keep me')
      expect((await fs.stat(path.join(dshHome, 'sessions'))).isDirectory()).toBe(true)
    })

    it('SC-230 launchd 切换失败时删除新托管目录，源码与数据保持原样', async () => {
      const sourceDir = path.join(sandbox, 'source-checkout')
      const dshHome = path.join(homeDir, '.dsh')
      await fs.mkdir(path.join(sourceDir, 'apps', 'cli'), { recursive: true })
      await fs.mkdir(path.join(dshHome, 'sessions'), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }),
      )
      const runCommand = vi.fn(async (binary, args) => {
        if (path.basename(binary) === 'node' && args[0] === '--version') return { stdout: `${NODE_OK}\n`, stderr: '', exitCode: 0 }
        if (path.basename(binary) === 'npm' && args[0] === '--version') return NPM_OK
        if (path.basename(binary) === 'npm' && args[0] === 'view') {
          return { stdout: JSON.stringify({ versions: ['0.1.5-rc.2'], 'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.2' } }), stderr: '', exitCode: 0 }
        }
        if (path.basename(binary) === 'npm' && args[0] === 'install') {
          await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        throw new Error(`unexpected command: ${binary} ${args.join(' ')}`)
      })
      await expect(service.takeOverSourceInstallation({ homeDir, sourceDir }, {
        homeDir,
        userDataDir,
        sourceDir,
        nodeBinFromProcess: path.join(nodeDir, 'node'),
        runCommand,
        detectManagedServiceFn: async () => ({ kind: 'launchd', label: 'com.dsh.web', running: true }),
        repointManagedServiceFn: async () => { throw Object.assign(new Error('switch failed'), { code: 'LAUNCHD_REPOINT_FAILED' }) },
      })).rejects.toMatchObject({ code: 'HARNESS_TAKEOVER_FAILED' })

      await expect(fs.stat(runtimeDir)).rejects.toThrow()
      expect((await fs.stat(sourceDir)).isDirectory()).toBe(true)
      expect((await fs.stat(path.join(dshHome, 'sessions'))).isDirectory()).toBe(true)
    })

    it('SC-231 registry 没有不低于源码的版本时拒绝接管，不发生安装', async () => {
      const sourceDir = path.join(sandbox, 'source-checkout')
      await fs.mkdir(path.join(sourceDir, 'apps', 'cli'), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }),
      )
      const runCommand = vi.fn(async (binary, args) => {
        if (path.basename(binary) === 'node' && args[0] === '--version') return { stdout: `${NODE_OK}\n`, stderr: '', exitCode: 0 }
        if (path.basename(binary) === 'npm' && args[0] === '--version') return NPM_OK
        if (path.basename(binary) === 'npm' && args[0] === 'view') {
          return { stdout: JSON.stringify({ versions: ['0.1.5-rc.2'], 'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.2' } }), stderr: '', exitCode: 0 }
        }
        throw new Error(`unexpected command: ${binary} ${args.join(' ')}`)
      })
      await expect(service.takeOverSourceInstallation({ homeDir, sourceDir }, {
        homeDir,
        sourceDir,
        nodeBinFromProcess: path.join(nodeDir, 'node'),
        runCommand,
        detectManagedServiceFn: async () => null,
      })).rejects.toMatchObject({ code: 'HARNESS_TAKEOVER_VERSION_UNAVAILABLE' })
      expect(runCommand.mock.calls.some(([, args]) => args[0] === 'install')).toBe(false)
    })

    it('SC-232 stopped launchd source can be removed without an env-provided source path', async () => {
      const sourceDir = path.join(sandbox, 'source-checkout')
      await fs.mkdir(path.join(sourceDir, 'apps', 'cli'), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }),
      )
      const supervisor = {
        label: 'com.dsh.web',
        plistPath: path.join(homeDir, 'Library', 'LaunchAgents', 'com.dsh.web.plist'),
        entry: path.join(sourceDir, 'apps', 'cli', 'src', 'bin.ts'),
        workingDirectory: sourceDir,
        running: false,
        pid: null,
      }
      const result = await service.uninstallHarness({ homeDir }, depsFor({
        'launchctl bootout': '',
      }, {
        detectManagedServiceFn: async () => supervisor,
      }))

      expect(result).toMatchObject({ removed: true, kind: 'source', serviceRemoved: true })
      expect((await fs.stat(sourceDir)).isDirectory()).toBe(true)
    })

    it('SC-222 installs through npm into the CodePal runtime dir', async () => {
      const runCommand = makeRunner({
        'node --version': `${NODE_OK}\n`,
        'npm install': '',
      })
      // 安装命令本身由 fake 接管；随后必须能读到托管 manifest
      const deps = {
        runCommand: vi.fn(async (binary, args) => {
          if (path.basename(binary) === 'npm' && args[0] === 'install') {
            await seedManagedInstall(runtimeDir, '0.1.5-rc.3')
            return { stdout: '', stderr: '', exitCode: 0 }
          }
          return runCommand(binary, args)
        }),
        homeDir,
        userDataDir,
        nodeBinFromProcess: path.join(nodeDir, 'node'),
      }
      const result = await service.installHarness({ homeDir, channel: 'latest' }, deps)
      expect(result.version).toBe('0.1.5-rc.3')
      expect(result.channel).toBe('latest')
      const installCall = deps.runCommand.mock.calls.find(([, args]) => args[0] === 'install')
      expect(installCall[1]).toContain('@deepseek-ai/dsh@latest')
      expect(installCall[1]).toContain('--prefix')
      expect(installCall[1]).toContain(runtimeDir)
    })

    it('SC-223 refuses to install on an unsupported Node', async () => {
      const deps = depsFor({ 'node --version': 'v20.11.0\n' })
      await expect(service.installHarness({ homeDir }, deps)).rejects.toMatchObject({ code: 'HARNESS_NODE_UNSUPPORTED' })
    })

    it('SC-224 uninstall removes the runtime dir but keeps ~/.dsh by default', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const dshHome = path.join(homeDir, '.dsh')
      await fs.mkdir(path.join(dshHome, 'sessions'), { recursive: true })
      await fs.writeFile(path.join(dshHome, '.credentials.yaml'), 'token: fake\n')

      const result = await service.uninstallHarness({ homeDir }, depsFor())
      expect(result).toEqual({ removed: true, purgedData: false })
      await expect(fs.stat(runtimeDir)).rejects.toThrow()
      // 会话历史与凭证必须保留
      expect((await fs.stat(path.join(dshHome, 'sessions'))).isDirectory()).toBe(true)
      expect((await fs.stat(path.join(dshHome, '.credentials.yaml'))).isFile()).toBe(true)
    })

    it('SC-225 purges ~/.dsh only when explicitly asked', async () => {
      await seedManagedInstall(runtimeDir, '0.1.5-rc.2')
      const dshHome = path.join(homeDir, '.dsh')
      await fs.mkdir(path.join(dshHome, 'sessions'), { recursive: true })
      const result = await service.uninstallHarness({ homeDir, purgeData: true }, depsFor())
      expect(result.purgedData).toBe(true)
      await expect(fs.stat(dshHome)).rejects.toThrow()
    })

    it('SC-226 refuses to uninstall what is not installed', async () => {
      await expect(service.uninstallHarness({ homeDir }, depsFor())).rejects.toMatchObject({ code: 'HARNESS_NOT_INSTALLED' })
    })
  })

  describe('退出清理', () => {
    it('SC-227 stops children on quit but honours the opt-out preference', async () => {
      const kill = vi.fn()
      const childrenMap = new Map([[777, { kill }]])
      const stopped = await service.shutdownAllHarness({ childrenMap, userDataDir, getStopOnQuit: () => true })
      expect(stopped).toBe(1)
      expect(kill).toHaveBeenCalledWith('SIGTERM')
      expect(childrenMap.size).toBe(0)
    })

    it('SC-228 keeps the instance running when the preference is off', async () => {
      const kill = vi.fn()
      const childrenMap = new Map([[778, { kill }]])
      const stopped = await service.shutdownAllHarness({ childrenMap, userDataDir, getStopOnQuit: () => false })
      expect(stopped).toBe(0)
      expect(kill).not.toHaveBeenCalled()
      expect(childrenMap.has(778)).toBe(true)
    })
  })
})
