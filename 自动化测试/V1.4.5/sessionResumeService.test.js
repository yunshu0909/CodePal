/**
 * V1.4.5 sessionResumeService 单元测试
 *
 * 负责：
 * - readSessionCwd：扫 JSONL 前 N 行提取 cwd；存在性检测；异常输入处理
 * - launchInNewTerminal：execFile 路径（mock osascript）；字符转义；错误包装
 * - 内部工具：escapeSingleQuote / escapeAppleScriptString
 *
 * @module 自动化测试/V1.4.5/sessionResumeService.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const service = await import('../../electron/services/sessionResumeService.js').then(m => m.default || m)
const { readSessionCwd, launchInNewTerminal, __INTERNAL__ } = service
const {
  escapeSingleQuote,
  escapeAppleScriptString,
  CLAUDE_PROJECTS_DIR,
  __setExecFile,
  __resetExecFile,
} = __INTERNAL__

const execFileMock = vi.fn()

// 临时 projects 目录：模拟 ~/.claude/projects 结构
let tmpRoot
let origHome

// 用 SAFE id 测试，不做 SAFE 校验的那部分单独跑
const PROJECT_ID = 'test-project-dir'
const UUID = '12345678-1234-1234-1234-123456789abc'
const BAD_UUID = 'not-a-valid-uuid'

/**
 * 直接调 readSessionCwd 是不方便注入路径的（硬编码 CLAUDE_PROJECTS_DIR）
 * 改用"在真实 CLAUDE_PROJECTS_DIR 下创建测试目录"策略，测完清理
 */
function seedSessionFile(lines) {
  const projectDir = join(CLAUDE_PROJECTS_DIR, PROJECT_ID)
  const { mkdirSync } = require('node:fs')
  mkdirSync(projectDir, { recursive: true })
  const jsonlPath = join(projectDir, `${UUID}.jsonl`)
  const content = lines.map(obj => (typeof obj === 'string' ? obj : JSON.stringify(obj))).join('\n') + '\n'
  writeFileSync(jsonlPath, content)
  return jsonlPath
}

function cleanupSessionFile() {
  const projectDir = join(CLAUDE_PROJECTS_DIR, PROJECT_ID)
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true })
}

beforeEach(() => {
  cleanupSessionFile()
  execFileMock.mockReset()
  __setExecFile(execFileMock)
})
afterEach(() => {
  cleanupSessionFile()
  __resetExecFile()
})

describe('escapeSingleQuote', () => {
  it("路径含单引号被正确转义", () => {
    expect(escapeSingleQuote("O'Brien/project")).toBe("O'\\''Brien/project")
  })
  it('无单引号路径不变', () => {
    expect(escapeSingleQuote('/Users/a/project')).toBe('/Users/a/project')
  })
  it('多个单引号全部转义', () => {
    expect(escapeSingleQuote("a'b'c")).toBe("a'\\''b'\\''c")
  })
})

describe('escapeAppleScriptString', () => {
  it('双引号和反斜杠都转义', () => {
    expect(escapeAppleScriptString('say "hi" \\n')).toBe('say \\"hi\\" \\\\n')
  })
  it('普通字符串不变', () => {
    expect(escapeAppleScriptString('cd /Users/a && claude')).toBe('cd /Users/a && claude')
  })
})

describe('readSessionCwd - 安全校验', () => {
  it('projectId 含斜杠 → 抛 INVALID_ID', async () => {
    await expect(readSessionCwd('..', UUID)).rejects.toThrow('INVALID_ID')
  })
  it('sessionId 含特殊字符 → 抛 INVALID_ID', async () => {
    await expect(readSessionCwd(PROJECT_ID, '../secret')).rejects.toThrow('INVALID_ID')
  })
  it('合法 ID 但文件不存在 → 抛 SESSION_FILE_NOT_FOUND', async () => {
    await expect(readSessionCwd(PROJECT_ID, UUID)).rejects.toThrow('SESSION_FILE_NOT_FOUND')
  })
})

describe('readSessionCwd - JSONL 解析', () => {
  it('首行就有 cwd → 正确返回 + 存在性 true（用真实存在的 /tmp）', async () => {
    seedSessionFile([{ cwd: '/tmp', type: 'meta' }])
    const result = await readSessionCwd(PROJECT_ID, UUID)
    expect(result.cwd).toBe('/tmp')
    expect(result.cwdExists).toBe(true)
  })

  it('cwd 在第 3 行才出现 → 正确返回', async () => {
    seedSessionFile([
      { type: 'noise-1' },
      { type: 'noise-2' },
      { cwd: '/tmp', type: 'meta' },
    ])
    const result = await readSessionCwd(PROJECT_ID, UUID)
    expect(result.cwd).toBe('/tmp')
  })

  it('前 20 行都没 cwd → cwd=null, cwdExists=false', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ type: `line-${i}` }))
    seedSessionFile(lines)
    const result = await readSessionCwd(PROJECT_ID, UUID)
    expect(result.cwd).toBeNull()
    expect(result.cwdExists).toBe(false)
  })

  it('第 21 行才有 cwd → 超出扫描窗口，返回 null', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ type: `line-${i}` }))
    lines.push({ cwd: '/tmp' })
    seedSessionFile(lines)
    const result = await readSessionCwd(PROJECT_ID, UUID)
    expect(result.cwd).toBeNull()
  })

  it('JSON 损坏行被跳过，后续行的 cwd 仍能读到', async () => {
    seedSessionFile([
      'this is not json',
      '{broken: "json"}',
      { cwd: '/tmp', type: 'meta' },
    ])
    const result = await readSessionCwd(PROJECT_ID, UUID)
    expect(result.cwd).toBe('/tmp')
  })

  it('cwd 为空字符串 → 继续往后扫', async () => {
    seedSessionFile([
      { cwd: '', type: 'empty' },
      { cwd: '/tmp', type: 'real' },
    ])
    const result = await readSessionCwd(PROJECT_ID, UUID)
    expect(result.cwd).toBe('/tmp')
  })

  it('cwd 指向不存在的目录 → cwd 返回但 cwdExists=false', async () => {
    seedSessionFile([{ cwd: '/definitely/does/not/exist/12345', type: 'meta' }])
    const result = await readSessionCwd(PROJECT_ID, UUID)
    expect(result.cwd).toBe('/definitely/does/not/exist/12345')
    expect(result.cwdExists).toBe(false)
  })
})

describe('launchInNewTerminal - 参数校验', () => {
  it('空 cwd → EMPTY_CWD', async () => {
    const r = await launchInNewTerminal('', UUID)
    expect(r.success).toBe(false)
    expect(r.error).toBe('EMPTY_CWD')
  })
  it('非字符串 cwd → EMPTY_CWD', async () => {
    const r = await launchInNewTerminal(null, UUID)
    expect(r.success).toBe(false)
    expect(r.error).toBe('EMPTY_CWD')
  })
  it('uuid 格式不对 → INVALID_UUID', async () => {
    const r = await launchInNewTerminal('/tmp', BAD_UUID)
    expect(r.success).toBe(false)
    expect(r.error).toBe('INVALID_UUID')
  })
})

describe('launchInNewTerminal - execFile 调用', () => {
  it('成功路径：osascript 返回 0 → {success:true}', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, 'tab 1 of window id 123', '')
    })
    const r = await launchInNewTerminal('/tmp', UUID)
    expect(r.success).toBe(true)
  })

  it('失败路径：execFile 错误 → {success:false, error:...}', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error('spawn ENOENT')
      cb(err, '', 'osascript: command not found')
    })
    const r = await launchInNewTerminal('/tmp', UUID)
    expect(r.success).toBe(false)
    expect(r.error).toContain('osascript')
  })

  it('cwd 含单引号 → 命令被正确转义', async () => {
    let capturedArgs
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      capturedArgs = args
      cb(null, 'ok', '')
    })
    await launchInNewTerminal("/Users/O'Brien/proj", UUID)
    const doScriptArg = capturedArgs.find(a => a.startsWith('do script'))
    // 两重转义：
    //   shell 层：' → '\''（关单引号 + 转义引号 + 重开单引号）
    //   AppleScript do script 层：\ → \\（因为 do script 的字符串参数又包了一层双引号）
    // 所以在最终 doScriptArg 里期望看到：O'\\''Brien
    expect(doScriptArg).toContain("O'\\\\''Brien")
    expect(doScriptArg).toContain("O'\\\\''Brien/proj")
  })

  it('命令末尾包含 claude --resume <uuid>', async () => {
    let capturedArgs
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      capturedArgs = args
      cb(null, 'ok', '')
    })
    await launchInNewTerminal('/tmp', UUID)
    const doScriptArg = capturedArgs.find(a => a.startsWith('do script'))
    expect(doScriptArg).toContain(`claude --resume ${UUID}`)
  })
})
