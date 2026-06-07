/**
 * V1.6.2 Codex 进程服务测试
 *
 * 覆盖：
 * - ps 输出解析与 Codex 进程树识别
 * - crashpad 不作为运行态
 * - 独立启动的 Codex 内置 node 不作为根进程
 * - 优雅退出成功时不触发 kill
 *
 * @module 自动化测试/V1.6.2/codexProcessService.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import processService from '../../electron/services/codexProcessService'

const { parsePsOutput, selectCodexProcessTree } = processService.__INTERNAL__

beforeEach(() => {
  processService.__INTERNAL__.__resetExecFile()
})

afterEach(() => {
  processService.__INTERNAL__.__resetExecFile()
})

function codexPsOutput() {
  return [
    ' 7609 1 /Applications/Codex.app/Contents/MacOS/Codex',
    ' 7611 1 /Applications/Codex.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --database=/Users/yunshu/Library/Application Support/Codex/Crashpad',
    ' 7612 7609 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=gpu-process',
    ' 7636 7609 /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled',
    ' 19288 7636 /Applications/Codex.app/Contents/Resources/node_repl',
    ' 19294 7636 npm exec xcodebuildmcp@latest mcp',
    ' 19410 19294 node /Users/yunshu/.npm/_npx/xcodebuildmcp mcp',
    ' 90000 1 /Applications/Other.app/Contents/MacOS/Other',
  ].join('\n')
}

describe('selectCodexProcessTree', () => {
  it('识别 Codex 主进程、app-server、helper 和子孙进程，并排除 crashpad', () => {
    const rows = parsePsOutput(codexPsOutput())
    const processes = selectCodexProcessTree(rows)
    const pids = processes.map((p) => p.pid)

    expect(pids).toEqual([7609, 7612, 7636, 19288, 19294, 19410])
    expect(processes.find((p) => p.pid === 7609)?.role).toBe('desktop')
    expect(processes.find((p) => p.pid === 7636)?.role).toBe('app-server')
    expect(processes.find((p) => p.pid === 7612)?.role).toBe('helper')
    expect(processes.some((p) => p.command.includes('chrome_crashpad_handler'))).toBe(false)
  })

  it('不把参数里带 Codex.app 路径的无关进程当成 Codex 根进程', () => {
    const rows = parsePsOutput([
      ' 700 1 /Applications/Codex.app/Contents/Resources/node /tmp/standalone.js',
      ' 701 1 /usr/bin/python3 /Applications/Codex.app/Contents/MacOS/Codex',
      ' 702 1 /usr/bin/python3 --target=/Applications/Codex.app/Contents/MacOS/Codex',
      ' 703 700 node child-of-standalone',
    ].join('\n'))
    const processes = selectCodexProcessTree(rows)

    expect(processes).toEqual([])
  })
})

describe('Codex process lifecycle', () => {
  it('listCodexProcesses 能通过 ps 发现正在运行的 Codex', async () => {
    const execFile = vi.fn((cmd, args, opts, cb) => {
      if (cmd === 'ps') cb(null, codexPsOutput(), '')
      else cb(null, '', '')
    })
    processService.__INTERNAL__.__setExecFile(execFile)

    const result = await processService.listCodexProcesses()

    expect(result.success).toBe(true)
    expect(result.processes.length).toBeGreaterThan(0)
    expect(await processService.isCodexRunning()).toBe(true)
  })

  it('quitCodex 优雅退出成功时只调用 osascript，不触发 kill', async () => {
    let psCalls = 0
    const execFile = vi.fn((cmd, args, opts, cb) => {
      if (cmd === 'ps') {
        psCalls += 1
        cb(null, psCalls === 1 ? codexPsOutput() : '', '')
        return
      }
      cb(null, '', '')
    })
    processService.__INTERNAL__.__setExecFile(execFile)

    const result = await processService.quitCodex({ timeoutMs: 20, force: true })

    expect(result.success).toBe(true)
    expect(result.wasRunning).toBe(true)
    expect(result.stoppedCount).toBe(6)
    expect(execFile.mock.calls.some((c) => c[0] === 'osascript')).toBe(true)
    expect(execFile.mock.calls.some((c) => c[0] === 'kill')).toBe(false)
  })

  it('quitCodex 等待退出时 ps 失败 → 不继续切换所需的成功态', async () => {
    let psCalls = 0
    const execFile = vi.fn((cmd, args, opts, cb) => {
      if (cmd === 'ps') {
        psCalls += 1
        if (psCalls === 1) cb(null, codexPsOutput(), '')
        else cb(Object.assign(new Error('ps failed'), { code: 1 }), '', 'ps failed')
        return
      }
      cb(null, '', '')
    })
    processService.__INTERNAL__.__setExecFile(execFile)

    const result = await processService.quitCodex({ timeoutMs: 20, force: false })

    expect(result.success).toBe(false)
    expect(result.error).toContain('ps failed')
  })
})
