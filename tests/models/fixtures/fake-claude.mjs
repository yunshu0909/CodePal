#!/usr/bin/env node
/**
 * 替身 claude（测试用）
 *
 * 负责：
 * - `--version` / `--help` 恒回固定文本、不写报告（FAKE_CLAUDE_MODE=oldversion 时版本为 2.1.200）
 * - 其余调用先把报告写到 $FAKE_CLAUDE_REPORT（argv、环境变量名、白名单变量的值、Key 的 sha256、标准输入、pid），再按 $FAKE_CLAUDE_MODE 行动
 * - Key 原文永不写进报告
 *
 * @module tests/models/fixtures/fake-claude
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_CLAUDE_MODE || 'success'
const report = process.env.FAKE_CLAUDE_REPORT

// 只 TC-F06 用：每次被调用都记一行参数
if (process.env.FAKE_CLAUDE_LOG_ALL === '1' && report) {
  fs.appendFileSync(path.join(path.dirname(report), 'doctor-calls.log'), JSON.stringify(argv) + '\n')
}

if (argv.includes('--version')) {
  process.stdout.write(mode === 'oldversion' ? '2.1.200 (Claude Code)\n' : '2.1.283 (Claude Code)\n')
  process.exit(0)
}
if (argv.includes('--help')) {
  process.stdout.write('Usage: claude [options]\n  --print\n  --output-format <format>\n  --safe-mode\n  --json-schema <schema>\n')
  process.exit(0)
}

const WHITELIST = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'CLAUDE_CONFIG_DIR', 'HOME', 'DISABLE_TELEMETRY',
  'CLAUDE_CODE_MAX_RETRIES',
]

/** 读完标准输入（没有管道时返回空串） */
function readStdin() {
  if (process.stdin.isTTY) return ''
  try { return fs.readFileSync(0, 'utf8') } catch { return '' }
}

const stdin = readStdin()
if (report) {
  const env = {}
  for (const k of WHITELIST) if (k in process.env) env[k] = process.env[k]
  const token = process.env.ANTHROPIC_AUTH_TOKEN
  fs.writeFileSync(report, JSON.stringify({
    argv,
    envNames: Object.keys(process.env).sort(),
    env,
    tokenSha256: token ? crypto.createHash('sha256').update(token).digest('hex') : null,
    stdin,
    pid: process.pid,
  }))
}

const base = { type: 'result', subtype: 'success', is_error: false, result: 'CODEPAL_OK', session_id: 's1', num_turns: 1, modelUsage: { 'deepseek-flash': {} } }
// api401 / api400 是 2026-09-27 对 DeepSeek 真实调用拿到的原文（TC-H06，请求 id 已去掉）；api402 仍按 Nexus 经验
const OUT = {
  success: [base, 0],
  api401: [{ ...base, is_error: true, result: 'Failed to authenticate. API Error: 401 Authentication Fails, Your api key: ****tion is invalid' }, 1],
  api400: [{ ...base, is_error: true, result: 'API Error: 400 The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-not-exist-codepal.' }, 1],
  api402: [{ ...base, is_error: true, result: 'API Error: 402 {"error":{"message":"Insufficient Balance"}}' }, 1],
}

if (OUT[mode]) {
  process.stdout.write(JSON.stringify(OUT[mode][0]))
  process.exit(OUT[mode][1])
}
if (mode === 'conn') {
  process.stderr.write('Connection error.\n')
  process.exit(1)
}
// #90：真 Claude Code 2.1.325 对认不出的模型名在标准错误写的诊断行（原文格式，模型名取这次启动配的）
const unrecognized = (model, source = 'sdk') => `[claude-code:unrecognized_model] ${JSON.stringify({ model, query_source: source })}\n`
if (mode === 'unrecognized') {
  process.stderr.write('before line\n')
  process.stderr.write(unrecognized(process.env.ANTHROPIC_MODEL))
  process.stderr.write(unrecognized('some-typo-model', 'agent:helper'))
  process.stderr.write('after line\n')
  process.stdout.write(JSON.stringify(base))
  process.exit(0)
}
if (mode === 'unrecognized-split') {
  // 一行拆成几块、隔一会儿才写完：模拟管道里分块到达
  const line = unrecognized(process.env.ANTHROPIC_MODEL)
  const parts = ['[claude-co', line.slice(10, 40), line.slice(40), 'tail without newline']
  let i = 0
  const next = () => {
    if (i < parts.length) { process.stderr.write(parts[i++]); setTimeout(next, 80); return }
    process.stdout.write(JSON.stringify(base))
    process.exit(0)
  }
  next()
}
if (mode === 'unrecognized-bytes') {
  // 不是 UTF-8 的字节（Latin-1 的 café）必须原样透传
  process.stderr.write(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  process.stderr.write(unrecognized(process.env.ANTHROPIC_MODEL))
  process.stderr.write(Buffer.from([0xff, 0xfe, 0x0a]))
  process.stdout.write(JSON.stringify(base))
  process.exit(0)
}
if (mode === 'unrecognized-late-newline') {
  // 别的模型名的整行先到、换行晚到：已经能确定不是要去掉的那行，应立即透传
  process.stderr.write(unrecognized('some-typo-model').trimEnd())
  setTimeout(() => {
    process.stderr.write('\n')
    process.stdout.write(JSON.stringify(base))
    process.exit(0)
  }, 1500)
}
if (mode === 'unrecognized-fail') {
  process.stderr.write(unrecognized(process.env.ANTHROPIC_MODEL))
  process.exit(1)
}
if (mode === 'exit3') process.exit(3)
if (mode === 'hang') {
  setTimeout(() => process.exit(0), 120000)
}
