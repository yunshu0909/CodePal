/**
 * V1.6.5 statusLine 第二行 Git 信息 — 自动化测试
 *
 * 对应 PRD-Skill-Manager-V1.6.5-statusLine-Git信息行-测试用例.md（Frozen 2026-05-18 451c04f）。
 * 全部"不费Key"确定性本地用例：渲染脚本→隔离路径→临时 git 仓库→喂构造 payload→断言 stdout。
 * 隔离铁律（memory 2026-05-11）：事前 HOME 沙箱 + 全部临时目录，绝不碰真实 ~/.claude / 真实仓库。
 *
 * @module 自动化测试/V1.6.5/statusLineGitLine
 */
// vitest globals:true → describe/it/expect/beforeAll/afterAll 全局可用，无需 import
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SVC = path.resolve(__dirname, '../../electron/services/claudeUsageStatusService.js')
const svc = require(SVC)

const BASE = {
  model: { display_name: 'Opus 4.7 (1M context)', id: 'claude-opus-4-7' },
  rate_limits: {
    five_hour: { used_percentage: 41, resets_at: 4102444800 },
    seven_day: { used_percentage: 13, resets_at: 4102444800 },
  },
}

let TMP, TMP_HOME, SL, RAW, REALSNAP
const trash = []
const mkd = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v165-')); trash.push(d); return d }
const PY3 = execFileSync('bash', ['-lc', 'command -v python3'], { encoding: 'utf8' }).trim()
/** 建一个只含指定工具软链、绝不含 git 的 bin 目录，返回路径 */
function nogitBin() {
  const d = mkd()
  for (const [name, real] of [['cat', '/bin/cat'], ['python3', PY3], ['env', '/usr/bin/env']]) {
    try { fs.symlinkSync(real, path.join(d, name)) } catch {}
  }
  return d
}

/** 在 dir 建一个 git 仓库（分支名 branch），返回 dir */
function mkrepo(branch = 'master', { tag, dirty, detached } = {}) {
  const d = mkd()
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'pipe' })
  g('init', '-q')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  g('commit', '--allow-empty', '-q', '-m', 'c1')
  g('branch', '-M', branch)
  if (detached) {
    g('commit', '--allow-empty', '-q', '-m', 'c2')
    const first = execFileSync('git', ['-C', d, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim()
    g('-c', 'advice.detachedHead=false', 'checkout', '-q', first)
  }
  if (tag) g('tag', tag)
  if (dirty) fs.writeFileSync(path.join(d, 'x.tmp'), 'x')
  return d
}

/** 用 jq filter 在 BASE 上变换，喂渲染脚本，返回 {code, lines, raw} */
function run(jqFilter, { configJson } = {}) {
  if (configJson === undefined) {
    try { fs.unlinkSync(path.join(TMP, 'cfg.json')) } catch {}
  } else {
    fs.writeFileSync(path.join(TMP, 'cfg.json'), configJson)
  }
  const finalJson = execFileSync('jq', ['-c', jqFilter], {
    input: JSON.stringify(BASE), encoding: 'utf8',
  })
  const r = spawnSync('bash', [SL], { input: finalJson, encoding: 'utf8' })
  return { code: r.status, raw: r.stdout, lines: r.stdout.split('\n').filter((x, i, a) => !(i === a.length - 1 && x === '')) }
}
const deansi = (s) => (s == null ? s : s.replace(/\x1b\[[0-9;]*m/g, ''))

beforeAll(() => {
  TMP = mkd()
  TMP_HOME = mkd()
  process.env.HOME = TMP_HOME // 事前 HOME 沙箱
  RAW = svc.buildStatusScriptContent()
  // 隔离：把渲染产物里的真实三路径替换到临时目录
  let s = RAW
  for (const [real, tmpName] of [
    [svc.STATUS_CONFIG_PATH, 'cfg.json'],
    [svc.STATUS_SNAPSHOT_PATH, 'snap.json'],
    [svc.STATUS_HISTORY_PATH, 'hist.json'],
  ]) {
    s = s.split(real).join(path.join(TMP, tmpName))
  }
  SL = path.join(TMP, 'sl.sh')
  fs.writeFileSync(SL, s)
  fs.chmodSync(SL, 0o755)
  // config 不会被 ambient statusLine 写（只在用户保存时写），用内容快照精确把关；
  // snapshot/history 宿主自身 Claude Code statusLine 每 prompt 都写，不能用它判我们的污染。
  const rd = (p) => { try { return fs.readFileSync(p) } catch { return null } }
  REALSNAP = {
    cfg: rd(svc.STATUS_CONFIG_PATH),
    script: rd(svc.scriptPath),
    innerHead: (() => {
      try { return execFileSync('git', ['-C', path.resolve(__dirname, '../..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return null }
    })(),
  }
})
afterAll(() => {
  for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
})

// ───────── 模块 A · 阶段0 资格地基 ─────────
describe('模块A 资格地基', () => {
  it('TC-001 渲染产物无残留占位符', () => {
    expect(RAW.length).toBeGreaterThan(0)
    expect(RAW.match(/__[A-Z_]+__/)).toBeNull()
  })
  it('TC-002 SCRIPT_VERSION===7 且版本注释为7', () => {
    expect(svc.SCRIPT_VERSION).toBe(7)
    expect(/^# codepal-script-version: 7$/m.test(RAW)).toBe(true)
  })
  it('TC-003 渲染脚本 Python 段语法可解析', () => {
    const body = RAW.split("<<'PY'")[1].split('\nPY')[0]
    const p = path.join(TMP, 'body.py')
    fs.writeFileSync(p, body)
    const r = spawnSync('python3', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', p], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  })
  it('TC-004 git print 在主 print 之后、SystemExit 退出点关系正确', () => {
    const body = RAW.split("<<'PY'")[1]
    const mainPrint = body.indexOf('print(f"{line}{sep}" + f"{sep}".join(parts))')
    const gitAfterMain = body.indexOf('compute_git_line(payload)', mainPrint)
    expect(mainPrint).toBeGreaterThan(0)
    expect(gitAfterMain).toBeGreaterThan(mainPrint) // git 在第一行主 print 之后
    // no rate limits 分支：git 追加在 418 print 之后、419 SystemExit 之前
    const norate = body.indexOf('no rate limits')
    const gitAfterNorate = body.indexOf('compute_git_line(payload)', norate)
    const sysexitAfterNorate = body.indexOf('raise SystemExit(0)', norate)
    expect(gitAfterNorate).toBeGreaterThan(norate)
    expect(gitAfterNorate).toBeLessThan(sysexitAfterNorate)
  })
  it('TC-005 旧版6脚本被 readDeployedScriptVersion 正则判 outdated', () => {
    const old = '# codepal-script-version: 6\n# rest'
    const m = old.match(/^# codepal-script-version:\s*(\d+)/m)
    expect(m && m[1]).toBe('6')
    expect(6 < svc.SCRIPT_VERSION).toBe(true)
    const cur = RAW.match(/^# codepal-script-version:\s*(\d+)/m)
    expect(cur[1]).toBe('7')
    expect(7 < svc.SCRIPT_VERSION).toBe(false)
  })
})

// ───────── 模块 B · 阶段1 连通 ─────────
describe('模块B 连通', () => {
  it('TC-101 最小合法 payload 退出0且第一行存在', () => {
    const ng = mkd()
    const { code, lines } = run(`.workspace.current_dir="${ng}"`)
    expect(code).toBe(0)
    const l1 = deansi(lines[0])
    expect(l1).toContain('Opus 4.7 (1M context)')
    expect(l1).toContain('5h:')
    expect(l1).toContain('7d:')
  })
  it('TC-102 首启无 rate_limits 即使在 git 仓库内也静默', () => {
    const r = mkrepo('master')
    const { code, raw } = run(`del(.rate_limits)|.workspace.current_dir="${r}"`)
    expect(code).toBe(0)
    expect(raw).toBe('') // 强对照：有效 git 仓库，耦合错则必冒 git 行
  })
})

// ───────── 模块 C · 阶段2 能力 ─────────
describe('模块C 能力', () => {
  it('TC-201 cwd 优先 workspace.current_dir', () => {
    const a = mkrepo('aaa'); const b = mkrepo('bbb')
    const { lines } = run(`.workspace.current_dir="${a}"|.cwd="${b}"`)
    expect(deansi(lines[1])).toBe('git:aaa')
  })
  it('TC-202 cwd 回退顶层 cwd', () => {
    const c = mkrepo('ccc')
    const { lines } = run(`del(.workspace)|.cwd="${c}"`)
    expect(deansi(lines[1])).toBe('git:ccc')
  })
  it('TC-203 cwd 缺失只第一行且第一行==基线', () => {
    const ng = mkd()
    const base1 = run(`.workspace.current_dir="${ng}"`).lines[0]
    const { code, lines, raw } = run('del(.workspace,.cwd)')
    expect(code).toBe(0)
    expect(lines[0]).toBe(base1)
    expect(raw).not.toContain('git:')
  })
  it('TC-204 正常仓库输出分支名', () => {
    const r = mkrepo('master')
    expect(deansi(run(`.workspace.current_dir="${r}"`).lines[1])).toBe('git:master')
  })
  it('TC-205 detached → 十六进制短sha 非HEAD', () => {
    const r = mkrepo('master', { detached: true })
    const sha = execFileSync('git', ['-C', r, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    const seg = deansi(run(`.workspace.current_dir="${r}"`).lines[1])
    expect(seg).toBe('git:' + sha)
    expect(seg.replace('git:', '')).toMatch(/^[0-9a-f]{7,40}$/)
    expect(seg).not.toBe('git:HEAD')
  })
  it('TC-206 有 tag 拼最近 tag 无偏移后缀', () => {
    const r = mkrepo('master', { tag: 'v1.6.4' })
    expect(deansi(run(`.workspace.current_dir="${r}"`).lines[1])).toBe('git:master@v1.6.4')
  })
  it('TC-207 无 tag 省略 tag 段不报错', () => {
    const r = mkrepo('dev')
    const { code, lines } = run(`.workspace.current_dir="${r}"`)
    expect(code).toBe(0)
    expect(deansi(lines[1])).toBe('git:dev')
  })
  it('TC-208 已跟踪改动触发 *', () => {
    const r = mkrepo('master')
    fs.writeFileSync(path.join(r, 'a.txt'), 'v1')
    execFileSync('git', ['-C', r, 'add', 'a.txt']); execFileSync('git', ['-C', r, 'commit', '-q', '-m', 'a'])
    fs.appendFileSync(path.join(r, 'a.txt'), 'v2')
    expect(deansi(run(`.workspace.current_dir="${r}"`).lines[1]).endsWith('*')).toBe(true)
  })
  it('TC-209 仅未跟踪文件也触发 *', () => {
    const r = mkrepo('master', { dirty: true })
    expect(deansi(run(`.workspace.current_dir="${r}"`).lines[1]).endsWith('*')).toBe(true)
  })
  it('TC-210 干净工作区无 *', () => {
    const r = mkrepo('master')
    expect(deansi(run(`.workspace.current_dir="${r}"`).lines[1])).not.toContain('*')
  })
  it('TC-211 非 git 目录无第二行但有第一行', () => {
    const ng = mkd()
    const { code, lines, raw } = run(`.workspace.current_dir="${ng}"`)
    expect(code).toBe(0)
    expect(deansi(lines[0])).toContain('5h:')
    expect(raw).not.toContain('git:')
  })
  it('TC-212 git 不可用时无第二行不报错', () => {
    const r = mkrepo('master')
    const nogit = nogitBin() // 只含 cat/python3/env，无 git
    const finalJson = execFileSync('jq', ['-c', `.workspace.current_dir="${r}"`], { input: JSON.stringify(BASE), encoding: 'utf8' })
    // 前置：该 PATH 下 git 确实不可见
    expect(spawnSync('/bin/bash', ['-c', 'command -v git'], { env: { PATH: nogit } }).status).not.toBe(0)
    const res = spawnSync('/bin/bash', [SL], { input: finalJson, encoding: 'utf8', env: { PATH: nogit, HOME: process.env.HOME } })
    expect(res.status, res.stderr).toBe(0)
    expect(deansi(res.stdout)).toContain('5h:')
    expect(res.stdout).not.toContain('git:')
  })
  it('TC-213 git -C 非法路径第一行完整无第二行', () => {
    const ng = mkd()
    const base1 = run(`.workspace.current_dir="${ng}"`).lines[0]
    const { code, lines, raw } = run('.workspace.current_dir="/dev/null/not-a-dir"')
    expect(code).toBe(0)
    expect(lines[0]).toBe(base1)
    expect(raw).not.toContain('git:')
  })
  it('TC-214 脏：第二行纯文本无任何 ANSI（原始字节）', () => {
    const r = mkrepo('master', { tag: 'v1.6.4', dirty: true })
    const raw2 = run(`.workspace.current_dir="${r}"`).lines[1]
    expect(raw2).toBe('git:master@v1.6.4*') // 原始字节即纯文本
    expect(/\x1b\[/.test(raw2)).toBe(false) // 不含任何 ANSI 转义
  })
  it('TC-215 off 耦合（强对照有效仓库）stdout 全空', () => {
    const r = mkrepo('master')
    const { code, raw } = run(`.workspace.current_dir="${r}"`, { configJson: '{"displayMode":"off","fiveHourThreshold":70,"sevenDayThreshold":70}' })
    expect(code).toBe(0)
    expect(raw).toBe('')
  })
  it('TC-216 threshold 未达阈值（强对照）stdout 全空', () => {
    const r = mkrepo('master')
    const { code, raw } = run(
      `.rate_limits.five_hour.used_percentage=10|.rate_limits.seven_day.used_percentage=10|.workspace.current_dir="${r}"`,
      { configJson: '{"displayMode":"threshold","fiveHourThreshold":70,"sevenDayThreshold":70}' },
    )
    expect(code).toBe(0)
    expect(raw).toBe('')
  })
  it('TC-217 no rate limits 行下方追加 git', () => {
    const r = mkrepo('main')
    const { lines } = run(`.rate_limits={}|.workspace.current_dir="${r}"`)
    expect(deansi(lines[0])).toContain('no rate limits')
    expect(deansi(lines[1])).toBe('git:main')
    expect(lines.length).toBe(2)
  })
  it('TC-218 超时降级：tag/脏超时省略段、分支超时整行省，受1.0s约束', () => {
    const fg = mkd()
    const mkfake = (branchSleeps) => {
      const lines = [
        '#!/bin/bash',
        'if [ "$1" = "-C" ]; then shift 2; fi', // 跳过 git -C <dir> 前缀
        'case "$1" in',
        '  rev-parse)',
        '    case "$2" in',
        `      --abbrev-ref) ${branchSleeps ? 'sleep 5; ' : ''}echo master; exit 0;;`,
        '      --short) echo abc1234; exit 0;;',
        '      *) echo abc1234; exit 0;;',
        '    esac;;',
        '  describe) sleep 5; echo v9; exit 0;;',
        '  status) sleep 5; echo " M x"; exit 0;;',
        '  *) exit 0;;',
        'esac',
      ]
      fs.writeFileSync(path.join(fg, 'git'), lines.join('\n') + '\n')
      fs.chmodSync(path.join(fg, 'git'), 0o755)
    }
    const r = mkd()
    const finalJson = execFileSync('jq', ['-c', `.workspace.current_dir="${r}"`], { input: JSON.stringify(BASE), encoding: 'utf8' })
    const ENV = { ...process.env, PATH: `${fg}:${process.env.PATH}` } // 伪 git 在前遮蔽真 git
    // 伪 git A：分支即时，tag/status 各 sleep5 → 仅分支段
    mkfake(false)
    let t = Date.now()
    let res = spawnSync('/bin/bash', [SL], { input: finalJson, encoding: 'utf8', env: ENV })
    const durA = Date.now() - t
    expect(res.status, res.stderr).toBe(0)
    expect(deansi(res.stdout).split('\n')[1]).toBe('git:master')
    expect(durA).toBeLessThan(3500) // 2×1.0s 超时 + ~1.5s Python/spawn 固定开销；无超时则为 2×5s
    // 伪 git B：分支也 sleep5 → 整行省
    mkfake(true)
    t = Date.now()
    res = spawnSync('/bin/bash', [SL], { input: finalJson, encoding: 'utf8', env: ENV })
    const durB = Date.now() - t
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).not.toContain('git:')
    expect(durB).toBeLessThan(2500) // 1×1.0s 超时 + ~1.5s 固定开销；无超时则为 1×5s
  })
  it('TC-219 detached + 脏 → git:<sha>*', () => {
    const r = mkrepo('master', { detached: true, dirty: true })
    const sha = execFileSync('git', ['-C', r, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(deansi(run(`.workspace.current_dir="${r}"`).lines[1])).toBe(`git:${sha}*`)
  })
  it('TC-220 detached 到被 tag 的提交 → git:<sha>@<tag>', () => {
    const d = mkd()
    const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'pipe' })
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
    g('commit', '--allow-empty', '-q', '-m', 'c1'); g('tag', 'v1.0.0')
    g('commit', '--allow-empty', '-q', '-m', 'c2')
    g('-c', 'advice.detachedHead=false', 'checkout', '-q', 'v1.0.0')
    const sha = execFileSync('git', ['-C', d, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    const exp = execFileSync('git', ['-C', d, 'describe', '--tags', '--abbrev=0'], { encoding: 'utf8' }).trim()
    expect(deansi(run(`.workspace.current_dir="${d}"`).lines[1])).toBe(`git:${sha}@${exp}`)
  })
  it('TC-221 cwd 非字符串（int/array/null）按缺失兜底', () => {
    const ng = mkd()
    const base1 = run(`.workspace.current_dir="${ng}"`).lines[0]
    for (const f of ['.workspace.current_dir=123|del(.cwd)', '.workspace.current_dir=["x"]|del(.cwd)', '.workspace.current_dir=null|del(.cwd)']) {
      const { code, lines, raw } = run(f)
      expect(code, f).toBe(0)
      expect(lines[0], f).toBe(base1)
      expect(raw, f).not.toContain('git:')
    }
  })
  it('TC-222 git 返回非UTF8/超长输出总兜底不崩', () => {
    const fg = mkd()
    const lines = [
      '#!/bin/bash',
      'if [ "$1" = "-C" ]; then shift 2; fi', // 跳过 git -C <dir> 前缀
      'case "$1" in',
      '  rev-parse)',
      "    printf '\\xff\\xfe\\n'; exit 0;;",
      "  describe) head -c 1000000 /dev/zero | tr '\\0' 'a'; exit 0;;",
      "  status) printf '\\xff\\n'; exit 0;;",
      '  *) exit 0;;',
      'esac',
    ]
    fs.writeFileSync(path.join(fg, 'git'), lines.join('\n') + '\n')
    fs.chmodSync(path.join(fg, 'git'), 0o755)
    const r = mkd()
    const ng = mkd()
    const base1 = run(`.workspace.current_dir="${ng}"`).lines[0]
    const finalJson = execFileSync('jq', ['-c', `.workspace.current_dir="${r}"`], { input: JSON.stringify(BASE), encoding: 'utf8' })
    const res = spawnSync('/bin/bash', [SL], { input: finalJson, encoding: 'utf8', env: { ...process.env, PATH: `${fg}:${process.env.PATH}` } })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.split('\n')[0]).toBe(base1)
    expect(res.stdout).not.toContain('git:')
  })
  it('TC-223 干净仓库第二行纯文本无任何 ANSI、不染后续行', () => {
    const r = mkrepo('master', { tag: 'v1.6.4' })
    const raw2 = run(`.workspace.current_dir="${r}"`).lines[1]
    expect(raw2).toBe('git:master@v1.6.4') // 干净=无 *
    expect(/\x1b\[/.test(raw2)).toBe(false) // 无任何 ANSI → 天然不染下一行
  })
})

// ───────── 模块 D · 阶段3 端到端 ─────────
describe('模块D 双层git端到端', () => {
  it('TC-301 双层 git 7 步命中最近 .git', () => {
    const runOnce = () => {
      const outer = mkd()
      const G = (d, ...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'pipe' })
      G(outer, 'init', '-q'); G(outer, 'config', 'user.email', 't@t'); G(outer, 'config', 'user.name', 't')
      // 如实建模真实双层结构：外层 .gitignore 排除 skill-manager/（见 MEMORY 发布流程），
      // 否则嵌套 git 目录会让外层 status 永远脏，step1 期望 git:master 落空
      fs.writeFileSync(path.join(outer, '.gitignore'), 'skill-manager/\n')
      G(outer, 'add', '.gitignore'); G(outer, 'commit', '-q', '-m', 'o'); G(outer, 'branch', '-M', 'master')
      const inner = path.join(outer, 'skill-manager')
      fs.mkdirSync(path.join(inner, 'electron'), { recursive: true })
      G(inner, 'init', '-q'); G(inner, 'config', 'user.email', 't@t'); G(inner, 'config', 'user.name', 't')
      G(inner, 'commit', '--allow-empty', '-q', '-m', 'i'); G(inner, 'branch', '-M', 'master'); G(inner, 'tag', 'v1.6.4')
      const exp = []
      exp.push(deansi(run(`.workspace.current_dir="${outer}"`).lines[1]) === 'git:master')
      exp.push(deansi(run(`.workspace.current_dir="${inner}"`).lines[1]) === 'git:master@v1.6.4')
      fs.writeFileSync(path.join(inner, 'x.tmp'), 'x')
      exp.push(deansi(run(`.workspace.current_dir="${inner}"`).lines[1]) === 'git:master@v1.6.4*')
      exp.push(deansi(run(`.workspace.current_dir="${path.join(inner, 'electron')}"`).lines[1]) === 'git:master@v1.6.4*')
      fs.writeFileSync(path.join(outer, 'outer.tmp'), 'x')
      exp.push(deansi(run(`.workspace.current_dir="${outer}"`).lines[1]) === 'git:master*')
      const s6 = run('del(.workspace,.cwd)')
      exp.push(s6.code === 0 && !s6.raw.includes('git:'))
      const ng2 = mkd()
      const s7 = run(`.workspace.current_dir="${ng2}"`)
      exp.push(s7.code === 0 && !s7.raw.includes('git:'))
      return exp
    }
    const a = runOnce()
    const b = runOnce() // 独立复跑（全新 mktemp）
    expect(a).toEqual([true, true, true, true, true, true, true])
    expect(b).toEqual(a)
  })
})

// ───────── 贯穿 · 安全 ─────────
describe('贯穿安全', () => {
  it('TC-901 第一行逐字节零改动（含满血四段）', () => {
    // 基线脚本 = git HEAD 上的 .tpl 经同法渲染（隔离）
    const tplRel = 'electron/services/claudeUsageStatusScript.tpl'
    const baseTpl = execFileSync('git', ['-C', path.resolve(__dirname, '../..'), 'show', `HEAD:${tplRel}`], { encoding: 'utf8' })
    let bs = baseTpl
      .replace(/__SCRIPT_VERSION__/g, '6')
      .split('__CONFIG_PATH__').join(path.join(TMP, 'cfg.json'))
      .split('__SNAPSHOT_PATH__').join(path.join(TMP, 'snap.json'))
      .split('__HISTORY_PATH__').join(path.join(TMP, 'hist.json'))
      .replace(/__MAX_COMPLETED_CYCLES__/g, String(svc.MAX_COMPLETED_CYCLES))
    const baseSh = path.join(TMP, 'base.sh')
    fs.writeFileSync(baseSh, bs); fs.chmodSync(baseSh, 0o755)

    const ng = mkd()
    const transcript = path.join(TMP, 'tr.jsonl')
    fs.writeFileSync(transcript, JSON.stringify({ message: { usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000 } } }) + '\n')
    const repo = mkrepo('master')
    const payloads = [
      JSON.stringify({ ...BASE, workspace: { current_dir: ng } }),
      JSON.stringify({ ...BASE, rate_limits: {}, workspace: { current_dir: ng } }),
      JSON.stringify({ ...BASE, transcript_path: transcript, workspace: { current_dir: ng } }),
      JSON.stringify({ ...BASE, transcript_path: transcript, workspace: { current_dir: repo } }),
    ]
    for (const p of payloads) {
      const a = spawnSync('bash', [baseSh], { input: p, encoding: 'utf8' }).stdout.split('\n')[0]
      const b = spawnSync('bash', [SL], { input: p, encoding: 'utf8' }).stdout.split('\n')[0]
      expect(b).toBe(a)
    }
  })
  it('TC-902 不污染真实磁盘/真实仓库（事前隔离 + 事后核对）', () => {
    const rd = (p) => { try { return fs.readFileSync(p) } catch { return null } }
    const eqBuf = (a, b) => (a === null && b === null) || (a && b && Buffer.compare(a, b) === 0)
    // 1) 真实 config 内容零变化（ambient statusLine 不写 config；若隔离失效写了它必被抓）
    expect(eqBuf(rd(svc.STATUS_CONFIG_PATH), REALSNAP.cfg), 'real config changed').toBe(true)
    // 2) 真实磁盘 statusLine 脚本零变化（绝不能被测试通过 ensureUsageStatusInstalled 覆盖）
    expect(eqBuf(rd(svc.scriptPath), REALSNAP.script), 'real statusline script changed').toBe(true)
    // 3) 真实 skill-manager 仓库 HEAD 零变化（全部用例只在 mktemp 内 git，绝不碰真实仓库）
    const innerNow = (() => { try { return execFileSync('git', ['-C', path.resolve(__dirname, '../..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return null } })()
    expect(innerNow).toBe(REALSNAP.innerHead)
    // 4) 事前防护核心不变量：写盘的隔离脚本不含真实 ~/.claude 字面路径（含则可能写真实文件）
    const real = path.join(os.homedir(), '.claude')
    expect(fs.readFileSync(SL, 'utf8').includes(real)).toBe(false)
    // 5) 隔离确实生效：脚本写的是临时 snapshot（前面用例已大量触发渲染脚本运行）
    expect(fs.existsSync(path.join(TMP, 'snap.json'))).toBe(true)
  })
})
