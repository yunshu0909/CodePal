/**
 * @vitest-environment node
 *
 * 模型接入 · 命令行透传与写回（4-test-cases.md 模块 C 与模块 D 的命令行部分）
 *
 * 负责：
 * - 用 Node 跑真实 cli.cjs + 替身 claude：--version 透传、标准输出逐字透传、退出码、信号、各退出路径
 * - 后台模式按调用方要求的输出格式写回状态文件
 *
 * @module tests/models/cli.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { makeSandbox, runCli, spawnCli, readReport, waitFor, alive, FAKE, KEY } from './helpers'

const require = createRequire(import.meta.url)
const store = require('../../electron/modules/models/store.js')

let sb
const L = ['launch', 'deepseek', 'deepseek-flash']
const statusFile = () => path.join(sb.models, 'status', 'deepseek__deepseek-flash.json')
const readStatus = () => JSON.parse(fs.readFileSync(statusFile(), 'utf8'))

beforeEach(() => {
  sb = makeSandbox()
  process.env.CODEPAL_MODELS_HOME = sb.models
  store.setKey('deepseek', KEY)
})
afterEach(() => {
  delete process.env.CODEPAL_MODELS_HOME
  sb.cleanup()
})

const env = (extra = {}) => ({ ...sb.env, ...extra })

describe('模块 C · 透传', () => {
  it('TC-C01 --version 与替身直接运行逐字节相同', () => {
    const direct = spawnSync(FAKE, ['--version'], { encoding: 'utf8', env: env() }).stdout
    const r = runCli([...L, '--', '--version'], { env: env({ FAKE_CLAUDE_MODE: 'version' }) })
    expect(direct).toBe('2.1.283 (Claude Code)\n')
    expect(r.stdout).toBe(direct)
    expect(r.status).toBe(0)
  })

  it('TC-C02 后台模式标准输出逐字透传，日志不进标准输出', () => {
    const r = runCli([...L, '--', '--print', '--output-format', 'json'], { env: env({ FAKE_CLAUDE_MODE: 'success' }), input: 'hi\n' })
    expect(r.stdout).toBe(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CODEPAL_OK', session_id: 's1', num_turns: 1, modelUsage: { 'deepseek-flash': {} } }))
    expect(r.status).toBe(0)
  })

  it('TC-C03 退出码原样返回', () => {
    expect(runCli([...L, '--', '--print'], { env: env({ FAKE_CLAUDE_MODE: 'exit3' }) }).status).toBe(3)
  })

  it.each([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]])('TC-C04 %s 转发给 claude，命令行以 %i 退出', async (sig, code) => {
    const child = spawnCli([...L, '--', '--print'], { env: env({ FAKE_CLAUDE_MODE: 'hang' }) })
    const exited = new Promise((r) => child.on('exit', (c, s) => r({ c, s })))
    expect(await waitFor(() => readReport(sb.report)?.pid, 8000)).toBe(true)
    const pid = readReport(sb.report).pid
    child.kill(sig)
    const res = await exited
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true)
    expect(res.c).toBe(code)
  })

  it('TC-C05 Key 未填时提示并不启动 claude', () => {
    fs.rmSync(sb.models, { recursive: true, force: true })
    const r = runCli([...L, '--'], { env: env() })
    expect(r.stderr.trim()).toBe('DeepSeek 还没填 Key，在 CodePal「模型接入」里填')
    expect(r.status).toBe(1)
    expect(fs.existsSync(sb.report)).toBe(false)
  })

  it('TC-C06 交互模式保留参数退出码 2', () => {
    const r = runCli([...L, '--', '--model', 'opus'], { env: env() })
    expect(r.stderr.trim()).toBe('这个参数由 CodePal 管理：--model')
    expect(r.status).toBe(2)
    expect(fs.existsSync(sb.report)).toBe(false)
  })

  it('TC-C07 Claude Code 版本太旧时退出 1', () => {
    const r = runCli([...L, '--', '--print'], { env: env({ FAKE_CLAUDE_MODE: 'oldversion' }) })
    expect(r.stderr.trim()).toBe('需要 Claude Code 2.1.251 或更新，当前 2.1.200')
    expect(r.status).toBe(1)
    expect(fs.existsSync(sb.report)).toBe(false)
  })

  it('TC-C08 settings 冲突时退出 1 且只列字段名', () => {
    const claudeDir = path.join(sb.home, '.claude')
    fs.mkdirSync(claudeDir)
    const settings = path.join(claudeDir, 'settings.json')
    fs.writeFileSync(settings, JSON.stringify({ env: { HTTP_USER_AGENT: 'secret-ua' } }))
    const before = fs.readFileSync(settings)
    const proj = path.join(sb.root, 'proj')
    fs.mkdirSync(proj)
    const r = runCli([...L, '--'], { env: env(), cwd: proj })
    expect(r.stderr).toContain('env.HTTP_USER_AGENT')
    expect(r.stderr).toContain('没有修改你的 Claude 配置')
    expect(r.stderr).not.toContain('secret-ua')
    expect(r.status).toBe(1)
    expect(fs.existsSync(sb.report)).toBe(false)
    expect(fs.readFileSync(settings).equals(before)).toBe(true)
  })

  it('TC-C09 Key 读不到时的提示', () => {
    fs.rmSync(path.join(sb.models, 'secrets', 'deepseek.key'))
    const r = runCli([...L, '--', '--print'], { env: env() })
    expect(r.stderr.trim()).toBe('本机保存的 Key 找不到了，重新填写')
    expect(r.status).toBe(1)
    expect(fs.existsSync(sb.report)).toBe(false)
  })

  it('TC-C10 配置读不出时的提示且不改写', () => {
    fs.writeFileSync(path.join(sb.models, 'models.json'), '{broken')
    const r = runCli([...L, '--', '--print'], { env: env() })
    expect(r.stderr.trim()).toBe('模型配置读不出，打开 CodePal「模型接入」看看')
    expect(r.status).toBe(1)
    expect(fs.readFileSync(path.join(sb.models, 'models.json'), 'utf8')).toBe('{broken')
  })
})

describe('模块 D · 命令行写回', () => {
  it('TC-D09 后台审核调用写回 balance', () => {
    const r = runCli([...L, '--', '--print', '--output-format', 'json'], { env: env({ FAKE_CLAUDE_MODE: 'api402' }), input: 'review' })
    expect(r.status).toBe(1)
    expect(JSON.parse(r.stdout).result).toContain('402')
    expect(readStatus()).toMatchObject({ ok: false, reason: 'balance', source: 'review' })
  })

  it('TC-D10 文本输出不写回', () => {
    const r = runCli([...L, '--', '--print'], { env: env({ FAKE_CLAUDE_MODE: 'success' }), input: 'hi' })
    expect(r.status).toBe(0)
    expect(fs.existsSync(statusFile())).toBe(false)
  })

  it('TC-D12 --output-format=json 写法也写回', () => {
    runCli([...L, '--', '--print', '--output-format=json'], { env: env({ FAKE_CLAUDE_MODE: 'success' }), input: 'hi' })
    expect(readStatus()).toMatchObject({ ok: true, source: 'review' })
  })

  it('TC-D13 写回失败不影响透传与退出码', () => {
    const statusDir = path.join(sb.models, 'status')
    fs.mkdirSync(statusDir, { recursive: true })
    fs.chmodSync(statusDir, 0o500)
    try {
      const r = runCli([...L, '--', '--print', '--output-format', 'json'], { env: env({ FAKE_CLAUDE_MODE: 'success' }), input: 'hi' })
      expect(JSON.parse(r.stdout).result).toBe('CODEPAL_OK')
      expect(r.status).toBe(0)
      expect(r.stderr).toContain('CodePal：没能记录这次结果')
      expect(r.stderr).not.toContain(KEY)
    } finally {
      fs.chmodSync(statusDir, 0o700)
    }
  })

  it('TC-D14 交互模式不写回', () => {
    const r = runCli([...L, '--', '--permission-mode', 'plan'], { env: env({ FAKE_CLAUDE_MODE: 'success' }) })
    expect(r.status).toBe(0)
    expect(fs.existsSync(statusFile())).toBe(false)
  })

  it('TC-D15 两次后台调用共用 claude-home，--resume 原样透传', () => {
    const r1 = path.join(sb.root, 'r1.json')
    const r2 = path.join(sb.root, 'r2.json')
    runCli([...L, '--', '--print', '--output-format', 'json'], { env: env({ FAKE_CLAUDE_REPORT: r1 }), input: 'a' })
    runCli([...L, '--', '--print', '--output-format', 'json', '--resume', 's1'], { env: env({ FAKE_CLAUDE_REPORT: r2 }), input: 'b' })
    const a = readReport(r1)
    const b = readReport(r2)
    expect(a.env.CLAUDE_CONFIG_DIR).toBe(path.join(sb.models, 'claude-home'))
    expect(b.env.CLAUDE_CONFIG_DIR).toBe(a.env.CLAUDE_CONFIG_DIR)
    const i = b.argv.indexOf('--resume')
    expect(b.argv[i + 1]).toBe('s1')
  })

  it('TC-D17 要求 JSON 但连接失败也写回 net', () => {
    const r = runCli([...L, '--', '--print', '--output-format', 'json'], { env: env({ FAKE_CLAUDE_MODE: 'conn' }), input: 'r' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(readStatus()).toMatchObject({ ok: false, reason: 'net', source: 'review' })
  })

  it('TC-D11 测一下的固定参数、提示词与重试 1 次；v2.1.17 起由 CodePal 把模型接入的档位作为 --effort 传入', () => {
    runCli([...L, '--test'], { env: env({ FAKE_CLAUDE_MODE: 'success' }) })
    const rep = readReport(sb.report)
    expect(rep.argv.slice(3)).toEqual(['--print', '--output-format', 'json', '--tools', 'Read', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--effort', 'max'])
    expect(rep.stdin).toBe('Reply with exactly: CODEPAL_OK')
    expect(rep.env.CLAUDE_CODE_MAX_RETRIES).toBe('1')
    expect(readStatus()).toMatchObject({ ok: true, source: 'test' })
  })

  it('TC-D06 测一下超时判 net 且替身进程结束', async () => {
    const t0 = Date.now()
    const r = runCli([...L, '--test'], { env: env({ FAKE_CLAUDE_MODE: 'hang', CODEPAL_TEST_TIMEOUT_MS: '2000' }) })
    const ms = Date.now() - t0
    expect(ms).toBeGreaterThanOrEqual(1500)
    expect(ms).toBeLessThan(8000)
    expect(readStatus()).toMatchObject({ ok: false, reason: 'net', source: 'test' })
    expect(await waitFor(() => !alive(readReport(sb.report).pid), 3000)).toBe(true)
    expect(r.status).not.toBe(0)
  })

  it('真实形态的 401（Failed to authenticate 开头、退出码 1）写回 key', () => {
    const r = runCli([...L, '--test'], { env: env({ FAKE_CLAUDE_MODE: 'api401' }) })
    expect(r.status).toBe(1)
    expect(readStatus()).toMatchObject({ ok: false, reason: 'key', source: 'test' })
  })

  it('注入进 claude 的 Key 与存的 Key 一致（只比哈希）', async () => {
    const crypto = await import('node:crypto')
    runCli([...L, '--', '--print'], { env: env({ FAKE_CLAUDE_MODE: 'success' }), input: 'hi' })
    expect(readReport(sb.report).tokenSha256).toBe(crypto.createHash('sha256').update(KEY).digest('hex'))
  })
})
