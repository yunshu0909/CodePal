/**
 * @vitest-environment node
 *
 * 模型接入 · 在终端里用 · 终端里的 codepal 选择列表（specs/v2.1.22-在终端里用/4-test-cases.md）
 *
 * 负责：
 * - 从真实入口跑：用 commands.installCommands 生成真实的 codepal 命令，在伪终端（Python pty）里运行它、发按键
 * - 被启动的单模型命令换成只记录「当前目录 + 参数」的假命令（保留生成标记，选择程序才认它）
 * - 覆盖后-01～后-07、后-18 的例子与真话表 真-08；全部在临时目录里，不调用模型、不读真实 Key
 *
 * @module tests/models/terminalPicker.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { makeSandbox, REPO, KEY } from './helpers'

const require = createRequire(import.meta.url)
const PICKER = path.join(REPO, 'electron/modules/models/picker.cjs')
// 先红时这里找不到选择程序
require.resolve(PICKER)
const store = require('../../electron/modules/models/store.js')
const commands = require('../../electron/modules/models/commands.js')

const CLIP = path.join(REPO, 'electron/modules/models/cli.cjs')
const ESC = '\x1b'
const DOWN = '\x1b[B'
const DOWN_APP = '\x1bOB'
const ENTER = '\r'
const CTRL_C = '\x03'

/** 在伪终端里跑命令：等 ready 文字出现后按顺序发按键，收集输出与退出码 */
const PTY = `
import os, pty, sys, time, select, json
args = json.loads(sys.argv[1]); keys = json.loads(sys.argv[2]); ready = sys.argv[3]; cwd = sys.argv[4]
rows, cols = int(sys.argv[5]), int(sys.argv[6])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(args[0], args, os.environ)
import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
buf = b''
def pump(t):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: buf += os.read(fd, 65536)
            except OSError: return False
    return True
t0 = time.time()
while ready and ready.encode() not in buf and time.time() - t0 < 10:
    if not pump(0.05): break
for k in keys:
    os.write(fd, k.encode('latin-1') if k.startswith('\\x1b') else k.encode())
    pump(0.3)
status = None
t1 = time.time()
while time.time() - t1 < 10:
    pump(0.1)
    w, st = os.waitpid(pid, os.WNOHANG)
    if w: status = os.waitstatus_to_exitcode(st); break
if status is None:
    os.kill(pid, 9); os.waitpid(pid, 0)
pump(0.2)
print(json.dumps({"out": buf.decode('utf8', 'replace'), "status": status}))
`

let sb
let cwd

/** 生成命令后，把单模型命令换成记录参数的假命令 */
function install() {
  commands.installCommands({ appExecPath: process.execPath, cliPath: CLIP })
  for (const name of fs.readdirSync(sb.bin)) {
    if (name === 'codepal') continue
    const report = path.join(sb.root, `${name}.json`)
    fs.writeFileSync(path.join(sb.bin, name), [
      '#!/bin/sh',
      `${commands.GENERATED_MARK}：测试用假命令`,
      `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}))' '${report}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 })
  }
}
const report = (name) => {
  const f = path.join(sb.root, `${name}.json`)
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}
const env = () => ({ ...sb.env, PATH: `${sb.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, TERM: 'xterm-256color' })

/** 在伪终端里输入 codepal（可带参数），按 keys 操作 */
function runPty(keys, { args = [], ready = 'Esc', rows = 30, cols = 100 } = {}) {
  const r = spawnSync('python3', ['-c', PTY, JSON.stringify([path.join(sb.bin, 'codepal'), ...args]), JSON.stringify(keys), ready, cwd, String(rows), String(cols)],
    { env: env(), encoding: 'utf8', timeout: 40000 })
  const parsed = JSON.parse(r.stdout || '{"out":"","status":null}')
  parsed.text = parsed.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1bO./g, '').replace(/\r/g, '')
  return parsed
}
/** 不在终端里跑（管道 / 重定向） */
function runPlain(args = [], { stdin = 'ignore' } = {}) {
  const r = spawnSync(path.join(sb.bin, 'codepal'), args, { env: env(), cwd, encoding: 'utf8', stdio: [stdin, 'pipe', 'pipe'], timeout: 20000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
const ok = (pid, id) => store.writeStatus(pid, id, { ok: true, source: 'test' })
const bad = (pid, id) => store.writeStatus(pid, id, { ok: false, reason: 'auth', source: 'test' })

beforeEach(() => {
  sb = makeSandbox()
  cwd = fs.mkdtempSync(path.join(sb.root, 'proj-'))
  process.env.CODEPAL_MODELS_HOME = sb.models
  process.env.CODEPAL_BIN_DIR = sb.bin
  store.setKey('zhipu-api', KEY)
  store.addModel('zhipu-api', 'glm-5.3-flash')
  store.setKey('deepseek', KEY)
  store.addModel('deepseek', 'deepseek-v4-flash')
  ok('zhipu-api', 'glm-5.3')
  ok('deepseek', 'deepseek-v4-flash')
})
afterEach(() => {
  delete process.env.CODEPAL_MODELS_HOME
  delete process.env.CODEPAL_BIN_DIR
  try { fs.chmodSync(sb.models, 0o755) } catch {}
  sb.cleanup()
})

describe('列表（后-01、后-02、后-18）', () => {
  it('TC-017 列表只放测过能用的模型，两行说明；真-08 出现', () => {
    install()
    const r = runPty([ESC])
    expect(r.text).toContain('选择要用的模型，打开 Claude Code（↑↓ 选择 · 回车打开 · Esc 取消）')
    expect(r.text).toContain('列表里只有在 CodePal 测过能用的模型')
    expect(r.text).toContain('glm-5.3')
    expect(r.text).toContain('deepseek-v4-flash')
    expect(r.text).toContain('● 可用')
  })

  it('TC-017 后-01-例1 测过不可用的不出现；后-01-例2 只看「测一下」，后台审核失败不影响', () => {
    bad('zhipu-api', 'glm-5.3-flash')
    store.writeStatus('deepseek', 'deepseek-v4-flash', { ok: false, reason: 'timeout', source: 'review' })
    install()
    const r = runPty([ESC])
    expect(r.text).not.toContain('glm-5.3-flash')
    expect(r.text).toContain('deepseek-v4-flash')
  })

  it('TC-017 后-01-例3 Key 读不到 → 这家都不在列表里', () => {
    install()
    fs.rmSync(path.join(sb.models, 'secrets', 'zhipu-api.key'))
    const r = runPty([ESC])
    expect(r.text).not.toContain('glm-5.3')
    expect(r.text).toContain('deepseek-v4-flash')
  })

  it('TC-017 后-01-例4 单模型命令不在 ~/.local/bin → 不在列表里', () => {
    install()
    fs.rmSync(path.join(sb.bin, 'codepal-deepseek-v4-flash'))
    const r = runPty([ESC])
    expect(r.text).not.toContain('deepseek-v4-flash')
  })

  it('TC-017 后-01-例5 换了 Key 不清掉上次的测试结果 → 仍在列表里', () => {
    install()
    store.setKey('zhipu-api', `${KEY}-new`)
    const r = runPty([ESC])
    expect(r.text).toContain('glm-5.3')
  })

  it('TC-017 后-01-例6 测试结果文件读不出 → 当没测过', () => {
    install()
    fs.writeFileSync(path.join(sb.models, 'status', 'zhipu-api__glm-5.3.json'), '{坏了')
    const r = runPty([ESC])
    expect(r.text).not.toContain('glm-5.3')
  })

  it('TC-017 后-02-例1 光标停在上次选的那个（列表按页面顺序：DeepSeek 在前、智谱在后）', () => {
    install()
    runPty([DOWN, ENTER])
    const second = runPty([ENTER])
    expect(second.text).toMatch(/正在用 glm-5\.3（智谱 API）/)
  })

  it('TC-017 后-02-例2 上次选的已不在列表 → 光标停在第一个', () => {
    install()
    runPty([DOWN, ENTER])
    bad('zhipu-api', 'glm-5.3')
    const r = runPty([ENTER])
    expect(r.text).toMatch(/正在用 deepseek-v4-flash（DeepSeek）/)
  })

  it('TC-017 后-02-例3 光标在最后一个按 ↓ → 回到第一个', () => {
    install()
    const r = runPty([DOWN, DOWN, ENTER])
    expect(r.text).toMatch(/正在用 deepseek-v4-flash（DeepSeek）/)
  })

  it('TC-017 后-18-例1 按显示宽度对齐：中文家名不把「● 可用」那一列对歪', () => {
    install()
    const r = runPty([ESC])
    const lines = r.text.split('\n').filter((l) => l.includes('● 可用'))
    const width = (s) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)
    const cols = lines.map((l) => width(l.slice(0, l.indexOf('● 可用'))))
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(new Set(cols).size).toBe(1)
  })

  it('TC-017 后-18-例2 模型比终端高 → 只显示一屏，按 ↓ 到底会滚动', () => {
    for (let i = 0; i < 12; i++) {
      store.addModel('deepseek', `m${String(i).padStart(2, '0')}`)
      ok('deepseek', `m${String(i).padStart(2, '0')}`)
    }
    install()
    // 顺序：deepseek-v4-flash、m00～m11、glm-5.3；按 12 次 ↓ 停在 m11（第 13 个），一屏只放得下 5 个
    const r = runPty([...Array(12).fill(DOWN), ENTER], { rows: 8 })
    expect(r.text).toMatch(/正在用 m11（DeepSeek）/)
  })

  it('TC-017 后-18-例3 Ctrl-C 后光标重新出现、终端回到正常模式', () => {
    install()
    const r = runPty([CTRL_C])
    expect(r.out).toContain('\x1b[?25h')
    expect(r.status).toBe(130)
  })
})

describe('没有能用的模型 / 读不出配置 / 非交互（后-05、后-06、后-07）', () => {
  it('TC-018 后-05-例1 都没测过 → 打两行提示，退出码 1；真-08 消失', () => {
    fs.rmSync(path.join(sb.models, 'status'), { recursive: true, force: true })
    install()
    const r = runPty([], { ready: '' })
    expect(r.text).toContain('还没有测过能用的模型，所以列表是空的。')
    expect(r.text).toContain('打开 CodePal →「模型接入」，填好 Key，给模型点「测一下」，通过后就会出现在这里。')
    expect(r.text).not.toContain('列表里只有在 CodePal 测过能用的模型')
    expect(r.status).toBe(1)
  })

  it('TC-018 后-05-例2 唯一可用的后来测试不通过 → 同样打提示', () => {
    bad('zhipu-api', 'glm-5.3')
    bad('deepseek', 'deepseek-v4-flash')
    install()
    const r = runPty([], { ready: '' })
    expect(r.text).toContain('还没有测过能用的模型')
    expect(r.status).toBe(1)
  })

  it('TC-018 后-06-例1 模型配置读不出 → 打现有原话后退出', () => {
    install()
    fs.writeFileSync(path.join(sb.models, 'models.json'), '{坏了')
    const r = runPty([], { ready: '' })
    expect(r.text).toContain('模型配置读不出，打开 CodePal「模型接入」看看')
    expect(r.status).toBe(1)
  })

  it('TC-018 后-05-例3 配置读不出又在管道里调用 → 按后-06 打提示，退出码 1', () => {
    install()
    fs.writeFileSync(path.join(sb.models, 'models.json'), '{坏了')
    const r = runPlain()
    expect(r.stderr).toContain('模型配置读不出')
    expect(r.status).toBe(1)
  })

  it('TC-018 后-07-例1 输入不是终端 → 立刻退出 2，不启动任何命令', () => {
    install()
    const r = runPlain([], { stdin: 'ignore' })
    expect(r.status).toBe(2)
    expect(report('codepal-zhipu-api--glm-5.3')).toBeNull()
  })

  it('TC-018 后-07-例2 codepal | cat → 标准错误里有可选模型，标准输出为空', () => {
    install()
    const r = spawnSync('/bin/sh', ['-c', `'${path.join(sb.bin, 'codepal')}' | cat`], { env: env(), cwd, encoding: 'utf8', timeout: 20000 })
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('glm-5.3')
  })

  it('TC-018 后-07-例3 标准错误被重定向 → 也按非交互处理', () => {
    install()
    const log = path.join(sb.root, 'log.txt')
    const r = spawnSync('/bin/sh', ['-c', `'${path.join(sb.bin, 'codepal')}' 2> '${log}'`], { env: env(), cwd, encoding: 'utf8', timeout: 20000 })
    expect(r.status).toBe(2)
    expect(fs.readFileSync(log, 'utf8')).toContain('glm-5.3')
  })

  it('TC-018 后-07-例4 在终端里直接输入 → 正常出列表等你选', () => {
    install()
    const r = runPty([ESC])
    expect(r.text).toContain('选择要用的模型')
    expect(r.status).toBe(130)
  })
})

describe('找不到命令（SC-020）', () => {
  it('TC-019 PATH 里没有 ~/.local/bin → 是 shell 自己报找不到 codepal', () => {
    install()
    const r = spawnSync('/bin/zsh', ['-fc', 'codepal'], { env: { ...env(), PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    expect(r.stderr).toMatch(/command not found: codepal/)
  })
})

describe('带参数（SC-021）', () => {
  it('TC-020 codepal --resume → 选完后 --resume 原样交给单模型命令', () => {
    install()
    runPty([ENTER], { args: ['--resume'] })
    expect(report('codepal-deepseek-v4-flash')?.args).toEqual(['--resume'])
  })
})

describe('取消与按键（后-04）', () => {
  it('TC-021 后-04-例1 按 Esc → 打「已取消，没有打开 Claude Code」，退出 130，什么都不启动', () => {
    install()
    const r = runPty([ESC])
    expect(r.text).toContain('已取消，没有打开 Claude Code')
    expect(r.status).toBe(130)
    expect(report('codepal-zhipu-api--glm-5.3')).toBeNull()
  })

  it('TC-021 后-04-例2 ESC [ B 是方向键，不是 Esc', () => {
    install()
    const r = runPty([DOWN, ENTER])
    expect(r.text).not.toContain('已取消')
    expect(report('codepal-zhipu-api--glm-5.3')).not.toBeNull()
  })

  it('TC-021 后-04-例3 应用光标键模式的 ESC O B 同样下移', () => {
    install()
    runPty([DOWN_APP, ENTER])
    expect(report('codepal-zhipu-api--glm-5.3')).not.toBeNull()
  })
})

describe('回车打开（后-03）', () => {
  it('TC-022 后-03-例1 回车 → 打「正在用…」，在当前文件夹运行所选的单模型命令', () => {
    install()
    const r = runPty([ENTER])
    expect(r.text).toContain('→ 正在用 deepseek-v4-flash（DeepSeek）打开 Claude Code…')
    expect(fs.realpathSync(report('codepal-deepseek-v4-flash').cwd)).toBe(fs.realpathSync(cwd))
  })

  it('TC-022 回车后终端交给 Claude Code：替身拿到的是终端、模式已恢复，打的字收得到，Ctrl-C 后回到 shell 还能输入', () => {
    install()
    const out = path.join(sb.root, 'takeover.json')
    fs.writeFileSync(path.join(sb.bin, 'codepal-deepseek-v4-flash'), [
      '#!/bin/sh',
      `${commands.GENERATED_MARK}：测试用交互替身`,
      `tty_in=no; [ -t 0 ] && tty_in=yes; tty_out=no; [ -t 1 ] && tty_out=yes; mode=$(stty -a < /dev/tty | tr -c 'a-z-' ' ')`,
      'trap "exit 0" INT',
      'IFS= read -r line',
      `printf '{"in":"%s","out":"%s","line":"%s","mode":"%s"}' "$tty_in" "$tty_out" "$line" "$mode" > '${out}'`,
      'while :; do sleep 1; done',
      '',
    ].join('\n'), { mode: 0o755 })
    // 外层用一个交互 shell：codepal 结束后再敲一条命令，证明回到 shell 能继续输入
    const shell = PTY.replace("os.execvpe(args[0], args, os.environ)", "os.execvpe('/bin/sh', ['/bin/sh', '-i'], dict(os.environ, PS1='$ '))")
    const keys = [`${path.join(sb.bin, 'codepal')}\r`, '__WAIT__Esc', ENTER, '__WAIT__正在用', 'hello there\r', '__SLEEP__', CTRL_C, 'echo back-in-shell\r', 'exit\r']
    const script = shell.replace("for k in keys:\n", "for k in keys:\n    if k.startswith('__WAIT__'):\n        want = k[8:].encode(); t2 = time.time()\n        while want not in buf and time.time() - t2 < 10: pump(0.05)\n        pump(0.8)\n        continue\n    if k == '__SLEEP__':\n        pump(1.5); continue\n")
    const r = spawnSync('python3', ['-c', script, JSON.stringify(['/bin/sh']), JSON.stringify(keys), '$', cwd, '30', '100'], { env: env(), encoding: 'utf8', timeout: 40000 })
    const res = JSON.parse(r.stdout)
    const got = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(got.in).toBe('yes')
    expect(got.out).toBe('yes')
    expect(got.line).toBe('hello there')
    expect(got.mode).toMatch(/(^|\s)icanon(\s|$)/)
    expect(got.mode).toMatch(/(^|\s)echo(\s|$)/)
    expect(res.out).toContain('back-in-shell')
  })

  it('TC-022 后-03-例2 codepal --resume 选 deepseek → 等同运行 codepal-deepseek-v4-flash --resume', () => {
    install()
    runPty([ENTER], { args: ['--resume'] })
    expect(report('codepal-deepseek-v4-flash').args).toEqual(['--resume'])
  })

  it('TC-022 后-03-例3 模型目录只读、记不下上次的选择 → 照样打开', () => {
    install()
    fs.chmodSync(sb.models, 0o555)
    runPty([ENTER])
    fs.chmodSync(sb.models, 0o755)
    expect(report('codepal-deepseek-v4-flash')).not.toBeNull()
  })

  it('TC-022 后-03-例4 列表出来后命令被删 → 回车不打开，打提示，退出 1', () => {
    install()
    const keys = ['__RM__', ENTER]
    const cmd = path.join(sb.bin, 'codepal-deepseek-v4-flash')
    // 等列表出来后删掉命令：伪终端脚本遇到 __RM__ 时什么都不发，这里用 at-ready 钩子实现
    const script = PTY.replace("for k in keys:\n", `for k in keys:\n    if k == '__RM__':\n        os.remove(${JSON.stringify(cmd)}); continue\n`)
    const r = spawnSync('python3', ['-c', script, JSON.stringify([path.join(sb.bin, 'codepal')]), JSON.stringify(keys), 'Esc', cwd, '30', '100'],
      { env: env(), encoding: 'utf8', timeout: 40000 })
    const out = JSON.parse(r.stdout)
    expect(out.out).toContain('这个模型的命令刚被移除了，重新输入 codepal 选一个')
    expect(out.status).toBe(1)
  })
})
