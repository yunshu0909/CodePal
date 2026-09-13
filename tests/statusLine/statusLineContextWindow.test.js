/**
 * V1.9.14 statusLine 上下文窗口来源修正 — 自动化测试
 *
 * 复现（修复前）：Opus 5 会话 154,679 tokens 被按 200k 窗口算成 77%（截图里的 74%），
 * 真实窗口是 1M（原生 native_1m），正确占比 15%。
 * 根因：脚本只按模型名里的独立 "1m" 猜窗口，而原生 1M 模型名里没有该标记，
 * 一律落到 200k 兜底；同时忽略了 Claude Code statusLine stdin 里已经给出的
 * 权威字段 context_window.context_window_size / used_percentage。
 *
 * 本套用例全部"不费Key"确定性本地用例：渲染脚本 → 隔离路径 → 喂构造 payload → 断言 stdout 与快照。
 * 隔离铁律（memory 2026-05-11）：事前 HOME 沙箱 + 全部临时目录，绝不碰真实 ~/.claude。
 *
 * @module 自动化测试/V1.9.14/statusLineContextWindow
 */
// vitest globals:true → describe/it/expect/beforeAll/afterAll 全局可用，无需 import
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SVC = path.resolve(__dirname, '../../electron/services/claudeUsageStatusService.js')
const svc = require(SVC)

/** 进度条字形（█ + 七个分数块），用于判定"这一行有没有上下文段" */
const BAR_CHARS = /[\u2588\u2589\u258a\u258b\u258c\u258d\u258e\u258f]/

/**
 * 模型窗口现状（来源：Claude Code 2.1.270 的编译期模型表，
 * 解析路径 Wz → jz(context.native_1m) → oh → qz → Ep(context_window_size)）：
 * - 原生 1M（window:1e6 + native_1m:!0）：显示名里**没有** "(1M context)"，旧启发式必然按 200k 算错
 * - 仍是 200k 默认（只有 1M beta / [1m] 后缀变体才是 1M）：名字里同样没有 1M 标记
 * 注意 claude-opus-4-6 / claude-sonnet-4-6 **不在**原生 1M 名单里 —— 按型号前缀"打表"会在这里翻车。
 */
const NATIVE_1M_MODELS = [
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-opus-4-7', 'Opus 4.7'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-5', 'Opus 5'],
  ['claude-fable-5', 'Fable 5'],
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-mythos-5', 'Mythos 5'],
  ['claude-mythos-5-1', 'Mythos 5.1'],
]
const LEGACY_200K_MODELS = [
  ['claude-opus-4-6', 'Opus 4.6'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'],
  ['claude-opus-4-5', 'Opus 4.5'],
  ['claude-haiku-4-5', 'Haiku 4.5'],
]

const trash = []
const mkd = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v1914-')); trash.push(d); return d }

let TMP, TMP_HOME, SL, NONGIT, REALSNAP
const CFG = () => path.join(TMP, 'cfg.json')
const SNAP = () => path.join(TMP, 'snap.json')

const deansi = (s) => (s == null ? s : s.replace(/\x1b\[[0-9;]*m/g, ''))
const line1 = (r) => deansi(r.lines[0] || '')
const snap = () => JSON.parse(fs.readFileSync(SNAP(), 'utf8'))

/** 基准 payload：Opus 5（原生 1M）+ 双窗口额度；cwd 指向非 git 临时目录 */
function payload(overrides = {}) {
  return {
    model: { display_name: 'Opus 5', id: 'claude-opus-5' },
    workspace: { current_dir: NONGIT, project_dir: NONGIT, added_dirs: [] },
    version: '2.1.270',
    rate_limits: {
      five_hour: { used_percentage: 41, resets_at: 4102444800 },
      seven_day: { used_percentage: 13, resets_at: 4102444800 },
    },
    ...overrides,
  }
}

/** 写一份只含 usage 的假 transcript，返回路径 */
function mkTranscript(dir, usages) {
  const p = path.join(dir, 'transcript.jsonl')
  fs.writeFileSync(p, usages
    .map((u) => JSON.stringify({ type: 'assistant', message: { usage: u } }))
    .join('\n') + '\n')
  return p
}

/** 喂 payload 给渲染脚本，返回 {code, raw, lines} */
function run(p, { env } = {}) {
  const r = spawnSync('bash', [SL], {
    input: JSON.stringify(p), encoding: 'utf8', env: { ...process.env, ...env },
  })
  return {
    code: r.status,
    stderr: r.stderr,
    raw: r.stdout,
    lines: r.stdout.split('\n').filter((x, i, a) => !(i === a.length - 1 && x === '')),
  }
}

beforeAll(() => {
  TMP = mkd()
  TMP_HOME = mkd()
  NONGIT = mkd()
  process.env.HOME = TMP_HOME // 事前 HOME 沙箱
  const RAW = svc.buildStatusScriptContent()
  // 隔离：把渲染产物里的真实配置/快照路径替换到临时目录
  let s = RAW
  for (const [real, tmpName] of [
    [svc.STATUS_CONFIG_PATH, 'cfg.json'],
    [svc.STATUS_SNAPSHOT_PATH, 'snap.json'],
  ]) {
    s = s.split(real).join(path.join(TMP, tmpName))
  }
  SL = path.join(TMP, 'sl.sh')
  fs.writeFileSync(SL, s)
  fs.chmodSync(SL, 0o755)
  const rd = (p) => { try { return fs.readFileSync(p) } catch { return null } }
  REALSNAP = { cfg: rd(svc.STATUS_CONFIG_PATH), script: rd(svc.scriptPath) }
})

afterAll(() => {
  for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
})

// ───────── 模块 A · 资格地基 ─────────
describe('模块A 资格地基', () => {
  it('TC-001 渲染产物无残留占位符且版本注释与常量一致', () => {
    const RAW = svc.buildStatusScriptContent()
    expect(RAW.length).toBeGreaterThan(0)
    expect(RAW.match(/__[A-Z_]+__/)).toBeNull()
    expect(svc.SCRIPT_VERSION).toBe(9)
    expect(new RegExp(`^# codepal-script-version: ${svc.SCRIPT_VERSION}$`, 'm').test(RAW)).toBe(true)
  })
  it('TC-002 渲染脚本 Python 段语法可解析', () => {
    const body = svc.buildStatusScriptContent().split("<<'PY'")[1].split('\nPY')[0]
    const p = path.join(TMP, 'body.py')
    fs.writeFileSync(p, body)
    const r = spawnSync('python3', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', p], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  })
})

// ───────── 模块 B · payload 权威字段优先 ─────────
describe('模块B 权威字段优先', () => {
  it('TC-101 原生 1M 模型：窗口取 payload，不再按 200k 虚高（复现用例）', () => {
    // 假 transcript 故意放 50,000 tokens：若脚本仍读 transcript + 200k 兜底会得到 25%
    const t = mkTranscript(mkd(), [{ input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 9000 }])
    const r = run(payload({
      transcript_path: t,
      context_window: {
        total_input_tokens: 154679,
        total_output_tokens: 594,
        context_window_size: 1000000,
        current_usage: { input_tokens: 2, cache_creation_input_tokens: 4929, cache_read_input_tokens: 149748, output_tokens: 594 },
        used_percentage: 15,
        remaining_percentage: 85,
      },
    }))
    expect(r.code, r.stderr).toBe(0)
    expect(line1(r)).toContain('15%')
    expect(line1(r)).not.toContain('77%')
    expect(line1(r)).not.toContain('25%')
    const s = snap()
    expect(s.contextWindow).toBe(1000000)
    expect(s.contextTokens).toBe(154679)
    expect(s.contextUsedPercentage).toBe(15)
  })
  it('TC-102 payload 说 200k 就按 200k，不再一律猜 200k 也不强推 1M', () => {
    const r = run(payload({
      model: { display_name: 'Sonnet 4.6', id: 'claude-sonnet-4-6' },
      context_window: { total_input_tokens: 154679, total_output_tokens: 100, context_window_size: 200000, used_percentage: 77, remaining_percentage: 23 },
    }))
    expect(r.code, r.stderr).toBe(0)
    expect(line1(r)).toContain('77%')
    expect(snap().contextWindow).toBe(200000)
  })
  it('TC-103 模型名带 (1M context) 也不能压过 payload（被额度限制时官方按 200k）', () => {
    const r = run(payload({
      model: { display_name: 'Opus 4.7 (1M context)', id: 'claude-opus-4-7' },
      context_window: { total_input_tokens: 154679, total_output_tokens: 100, context_window_size: 200000, used_percentage: 77, remaining_percentage: 23 },
    }))
    expect(r.code, r.stderr).toBe(0)
    expect(line1(r)).toContain('77%')
    expect(snap().contextWindow).toBe(200000)
  })
  it('TC-104 有窗口但本次会话还没有 usage → 不出上下文段', () => {
    const r = run(payload({
      context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 1000000, current_usage: null, used_percentage: null, remaining_percentage: null },
    }))
    expect(r.code, r.stderr).toBe(0)
    expect(BAR_CHARS.test(line1(r))).toBe(false)
    const s = snap()
    expect(s.contextWindow).toBe(1000000)
    expect(s.contextTokens).toBeNull()
    expect(s.contextUsedPercentage).toBeNull()
  })
  it('TC-105 payload 路径不读 transcript：transcript_path 不存在也照常出数', () => {
    const r = run(payload({
      transcript_path: path.join(mkd(), 'does-not-exist.jsonl'),
      context_window: { total_input_tokens: 154679, total_output_tokens: 100, context_window_size: 1000000, used_percentage: 15, remaining_percentage: 85 },
    }))
    expect(r.code, r.stderr).toBe(0)
    expect(line1(r)).toContain('15%')
  })
  it('TC-106 全部原生 1M 模型逐个跟随 payload（Sonnet 5 / Opus 4.7+ / Fable 5.x / Mythos 5.x）', () => {
    for (const [id, name] of NATIVE_1M_MODELS) {
      const r = run(payload({
        model: { display_name: name, id },
        context_window: { total_input_tokens: 250000, total_output_tokens: 100, context_window_size: 1000000, used_percentage: 25 },
      }))
      expect(r.code, `${id}: ${r.stderr}`).toBe(0)
      expect(line1(r), id).toContain('25%')
      expect(snap().contextWindow, id).toBe(1000000)
      expect(snap().contextUsedPercentage, id).toBe(25)
    }
  })
  it('TC-107 默认仍是 200k 的模型不能被"型号前缀打表"带跑（Opus 4.6 / Sonnet 4.6 等）', () => {
    for (const [id, name] of LEGACY_200K_MODELS) {
      const r = run(payload({
        model: { display_name: name, id },
        context_window: { total_input_tokens: 150000, total_output_tokens: 100, context_window_size: 200000, used_percentage: 75 },
      }))
      expect(r.code, `${id}: ${r.stderr}`).toBe(0)
      expect(line1(r), id).toContain('75%')
      expect(snap().contextWindow, id).toBe(200000)
    }
  })
})

// ───────── 模块 C · 老版本 Claude Code 回退 ─────────
describe('模块C 老版本回退（无 context_window 字段）', () => {
  it('TC-201 回退仍按 transcript 计算，名字带 (1M context) → 1M', () => {
    const t = mkTranscript(mkd(), [{ input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 9000 }])
    const r = run(payload({
      model: { display_name: 'Opus 4.7 (1M context)', id: 'claude-opus-4-7' },
      transcript_path: t,
    }))
    expect(r.code, r.stderr).toBe(0)
    expect(line1(r)).toContain('5%')
    expect(snap().contextWindow).toBe(1000000)
    expect(snap().contextTokens).toBe(50000)
  })
  it('TC-202 回退的 200k 默认仍保留（仅老版本会命中，当前版本走 payload）', () => {
    const t = mkTranscript(mkd(), [{ input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 9000 }])
    const r = run(payload({ transcript_path: t })) // 名字 "Opus 5" 不含 1m 标记
    expect(r.code, r.stderr).toBe(0)
    expect(line1(r)).toContain('25%')
    expect(snap().contextWindow).toBe(200000)
  })
  it('TC-203 回退路径无 transcript → 不出上下文段且不报错', () => {
    const r = run(payload())
    expect(r.code, r.stderr).toBe(0)
    expect(BAR_CHARS.test(line1(r))).toBe(false)
    expect(snap().contextUsedPercentage).toBeNull()
  })
})

// ───────── 模块 D · 健壮性 ─────────
describe('模块D 健壮性', () => {
  it('TC-301 context_window 类型不对（字符串）→ 回退不崩', () => {
    const r = run(payload({ context_window: '1000000' }))
    expect(r.code, r.stderr).toBe(0)
    expect(BAR_CHARS.test(line1(r))).toBe(false)
    expect(snap().contextWindow).toBe(200000)
  })
  it('TC-302 非法窗口值（负数/0/字符串/true）一律回退', () => {
    for (const bad of [-1, 0, '1000000', true]) {
      const r = run(payload({ context_window: { context_window_size: bad, total_input_tokens: 154679, used_percentage: 15 } }))
      expect(r.code, r.stderr).toBe(0)
      expect(BAR_CHARS.test(line1(r))).toBe(false)
      expect(snap().contextWindow).toBe(200000)
    }
  })
  it('TC-303 窗口合法但 used_percentage 类型不对 → 窗口入库、不出上下文段', () => {
    const r = run(payload({
      context_window: { context_window_size: 1000000, total_input_tokens: 154679, used_percentage: '15' },
    }))
    expect(r.code, r.stderr).toBe(0)
    expect(BAR_CHARS.test(line1(r))).toBe(false)
    const s = snap()
    expect(s.contextWindow).toBe(1000000)
    expect(s.contextTokens).toBe(154679)
    expect(s.contextUsedPercentage).toBeNull()
  })
  it('TC-304 used_percentage 为 0 是合法值，按 0% 渲染', () => {
    const r = run(payload({
      context_window: { context_window_size: 1000000, total_input_tokens: 1, used_percentage: 0 },
    }))
    expect(r.code, r.stderr).toBe(0)
    expect(line1(r)).toContain('0%')
    expect(snap().contextUsedPercentage).toBe(0)
  })
})

// ───────── 模块 E · 隔离 ─────────
describe('模块E 隔离', () => {
  it('TC-401 全程未触碰真实 ~/.claude 的脚本与配置', () => {
    const rd = (p) => { try { return fs.readFileSync(p) } catch { return null } }
    const now = { cfg: rd(svc.STATUS_CONFIG_PATH), script: rd(svc.scriptPath) }
    expect(now.cfg).toEqual(REALSNAP.cfg)
    expect(now.script).toEqual(REALSNAP.script)
  })
  it('TC-402 额度行与 git 行不因本次改动回归', () => {
    const r = run(payload({
      context_window: { context_window_size: 1000000, total_input_tokens: 154679, used_percentage: 15 },
    }))
    expect(r.code, r.stderr).toBe(0)
    const l = line1(r)
    expect(l).toContain('Opus 5')
    expect(l).toContain('5h:41%')
    expect(l).toContain('7d:13%')
    expect(l).toContain('resets')
  })
})
