/**
 * launchd 服务入口切换测试
 *
 * plutil 使用系统真实实现，launchctl 使用状态机替身：既验证 plist 字节备份与
 * 参数改写，也验证切换失败时恢复原文件并重新拉起旧服务。
 *
 * @module tests/v22/launchdService
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)
let service

beforeAll(async () => {
  const module = await import('../../electron/services/launchdService.js')
  service = module.default || module
})

describe('launchd 安全切换 Harness 入口', () => {
  let sandbox
  let homeDir
  let label
  let plistPath
  let originalBytes
  let machine
  let calls
  let bootstrapFailures

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-launchd-switch-'))
    homeDir = path.join(sandbox, 'home')
    label = 'com.test.dsh'
    const dir = path.join(homeDir, 'Library', 'LaunchAgents')
    plistPath = path.join(dir, `${label}.plist`)
    await fs.mkdir(dir, { recursive: true })
    originalBytes = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>--import</string><string>tsx/esm</string><string>apps/cli/src/bin.ts</string><string>web</string></array>
<key>WorkingDirectory</key><string>/Users/demo/deepseek-harness</string>
<key>KeepAlive</key><true/>
</dict></plist>`)
    await fs.writeFile(plistPath, originalBytes, { mode: 0o600 })
    machine = { loaded: true, running: true, pid: 4100 }
    calls = []
    bootstrapFailures = 0
  })

  afterEach(async () => { await fs.rm(sandbox, { recursive: true, force: true }) })

  async function runCommand(binary, args) {
    calls.push(`${binary} ${args.join(' ')}`)
    if (binary === 'plutil') {
      try {
        const result = await execFileAsync(binary, args, { encoding: 'utf8' })
        return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: 0 }
      } catch (error) {
        return { stdout: error.stdout || '', stderr: error.stderr || '', exitCode: 1 }
      }
    }
    if (args[0] === 'print') {
      if (!machine.loaded) throw new Error('service not loaded')
      return {
        stdout: `state = ${machine.running ? 'running' : 'stopped'}\npid = ${machine.pid}\nproperties = keepalive | runatload\n`,
        stderr: '',
        exitCode: 0,
      }
    }
    if (args[0] === 'bootout') {
      machine.loaded = false
      machine.running = false
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    if (args[0] === 'bootstrap') {
      if (bootstrapFailures > 0) {
        bootstrapFailures -= 1
        return { stdout: '', stderr: 'bootstrap failed', exitCode: 1 }
      }
      machine.loaded = true
      machine.running = true
      machine.pid += 1
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    if (args[0] === 'kickstart') {
      if (!machine.loaded) return { stdout: '', stderr: 'not loaded', exitCode: 1 }
      machine.running = true
      machine.pid += 1
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    throw new Error(`unexpected command: ${binary} ${args.join(' ')}`)
  }

  it('SC-601 先备份原 plist，再卸载旧服务、改入口并重新 bootstrap', async () => {
    const managedBin = '/Users/demo/Documents/SkillManager/runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    const runtimeDir = '/Users/demo/Documents/SkillManager/runtimes/dsh'
    const result = await service.repointEntry({
      homeDir,
      label,
      uid: 501,
      nextBin: managedBin,
      nodeBin: '/opt/homebrew/bin/node',
      workingDirectory: runtimeDir,
    }, { runCommand, homeDir, label, uid: 501 })

    const converted = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' })
    const next = JSON.parse(converted.stdout)
    expect(next.ProgramArguments).toEqual(['/opt/homebrew/bin/node', managedBin, 'web'])
    expect(next.WorkingDirectory).toBe(runtimeDir)
    expect(await fs.readFile(result.backupPath)).toEqual(originalBytes)
    expect(calls.some((call) => call.includes('launchctl bootout'))).toBe(true)
    expect(calls.some((call) => call.includes('launchctl bootstrap'))).toBe(true)
    expect(machine.running).toBe(true)
  })

  it('SC-602 新入口启动失败时恢复原 plist，并重新启动旧服务', async () => {
    bootstrapFailures = 1
    await expect(service.repointEntry({
      homeDir,
      label,
      uid: 501,
      nextBin: '/Users/demo/runtime/dsh/lib/bin.js',
      nodeBin: '/opt/homebrew/bin/node',
      workingDirectory: '/Users/demo/runtime',
    }, { runCommand, homeDir, label, uid: 501 }))
      .rejects.toMatchObject({ code: 'LAUNCHD_REPOINT_FAILED' })

    expect(await fs.readFile(plistPath)).toEqual(originalBytes)
    expect(machine.running).toBe(true)
    expect(calls.filter((call) => call.includes('launchctl bootstrap')).length).toBe(2)
  })

  it('SC-603 正式运行未注入 runCommand 时仍能调用系统 plutil', async () => {
    await service.writePlist(plistPath, (json) => ({ ...json, KeepAlive: false }))

    const converted = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' })
    expect(JSON.parse(converted.stdout).KeepAlive).toBe(false)
    expect(await fs.readFile(`${plistPath}.codepal-backup`)).toEqual(originalBytes)
  })
})
