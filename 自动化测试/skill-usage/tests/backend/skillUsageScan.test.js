/**
 * Skill 使用次数扫描 — 后端测试
 *
 * 覆盖：三信号计数（Claude tool_use / Claude /slash / Codex $）+ 过滤（内置命令 /
 * shell 变量 / SKILL.md 噪声）+ 时间窗裁剪 + 部分可用（缺源）+ 空名单。
 *
 * @module 自动化测试/skill-usage/tests/backend/skillUsageScan.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSkillUsage } = require('../../../../electron/services/skillUsageScanService')
const { scanLogFilesInRange } = require('../../../../electron/logScanner')

const DAY = 86400000
const NAMES = ['git-push', 'prd-test-writer', 'ui-design']
const pathExists = async (p) => { try { await fs.access(p); return true } catch { return false } }

async function writeJsonl(file, objs) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n')
}

describe('skillUsageScanService', () => {
  let home, NOW, tsIn, tsOut, nowFn

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'skillusage-'))
    NOW = new Date()
    nowFn = () => NOW
    tsIn = new Date(NOW.getTime() - 5 * DAY).toISOString()   // 窗口内
    tsOut = new Date(NOW.getTime() - 40 * DAY).toISOString() // 窗口外
  })
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })

  async function setupClaude() {
    await writeJsonl(path.join(home, '.claude', 'projects', 'proj', 'a.jsonl'), [
      // 自主 tool_use Skill = git-push（窗口内）
      { type: 'assistant', timestamp: tsIn, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'git-push' } }] } },
      // 手动 /slash = prd-test-writer（窗口内）
      { type: 'user', timestamp: tsIn, message: { content: '<command-name>/prd-test-writer</command-name>' } },
      // 内置命令 /model（非 skill）→ 不计
      { type: 'user', timestamp: tsIn, message: { content: '<command-name>/model</command-name>' } },
      // 窗口外的 git-push tool_use → 不计
      { type: 'assistant', timestamp: tsOut, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'git-push' } }] } },
    ])
  }
  async function setupCodex() {
    await writeJsonl(path.join(home, '.codex', 'sessions', '2026', '06', '01', 'r.jsonl'), [
      // 显式 $git-push（窗口内）
      { type: 'event_msg', timestamp: tsIn, payload: { type: 'user_message', message: '请用 $git-push 推一下' } },
      // $PATH（shell 变量，非 skill）→ 不计
      { type: 'event_msg', timestamp: tsIn, payload: { type: 'user_message', message: 'echo $PATH' } },
      // SKILL.md 读取（catalog 噪声，无 $）→ 不计
      { type: 'response_item', timestamp: tsIn, payload: { type: 'function_call', arguments: 'cat skills/ui-design/SKILL.md' } },
    ])
  }

  it('三信号计数 + 过滤内置命令/shell变量/SKILL.md噪声/窗口外', async () => {
    await setupClaude(); await setupCodex()
    const r = await scanSkillUsage(
      { homeDir: home, scanLogFilesInRangeFn: scanLogFilesInRange, pathExistsFn: pathExists, nowFn },
      { windowDays: 30, skillNames: NAMES }
    )
    const byName = Object.fromEntries(r.skills.map((s) => [s.name, s]))
    expect(byName['git-push']).toMatchObject({ claude: 1, codex: 1, total: 2 }) // 窗口外那条不计
    expect(byName['prd-test-writer']).toMatchObject({ claude: 1, codex: 0, total: 1 })
    expect(byName['ui-design']).toBeUndefined() // 仅 SKILL.md 读取 → 不计
    expect(r.totals).toMatchObject({ total: 3, claude: 2, codex: 1 })
    expect(r.sources).toMatchObject({ claude: 'ok', codex: 'ok' })
    expect(byName['git-push'].lastUsedAt).toBeTruthy()
  })

  it('部分可用：缺 Codex 目录 → sources.codex=missing，Claude 仍计', async () => {
    await setupClaude()
    const r = await scanSkillUsage(
      { homeDir: home, scanLogFilesInRangeFn: scanLogFilesInRange, pathExistsFn: pathExists, nowFn },
      { windowDays: 30, skillNames: NAMES }
    )
    expect(r.sources).toMatchObject({ claude: 'ok', codex: 'missing' })
    const byName = Object.fromEntries(r.skills.map((s) => [s.name, s]))
    expect(byName['git-push']).toMatchObject({ claude: 1, codex: 0 })
  })

  it('skillNames 为空 → 不计任何（避免噪声）', async () => {
    await setupClaude(); await setupCodex()
    const r = await scanSkillUsage(
      { homeDir: home, scanLogFilesInRangeFn: scanLogFilesInRange, pathExistsFn: pathExists, nowFn },
      { windowDays: 30, skillNames: [] }
    )
    expect(r.skills.length).toBe(0)
    expect(r.totals.total).toBe(0)
  })

  it('两源都缺 → 全 missing，skills 空，不抛错', async () => {
    const r = await scanSkillUsage(
      { homeDir: home, scanLogFilesInRangeFn: scanLogFilesInRange, pathExistsFn: pathExists, nowFn },
      { windowDays: 30, skillNames: NAMES }
    )
    expect(r.sources).toMatchObject({ claude: 'missing', codex: 'missing' })
    expect(r.skills.length).toBe(0)
  })

  it('口径守卫：agent推理/function_call/assistant回显里的 $skill 与 command-name 不计', async () => {
    // Claude：assistant 文本回显 <command-name>（非 user）→ 不计
    await writeJsonl(path.join(home, '.claude', 'projects', 'proj', 'b.jsonl'), [
      { type: 'assistant', timestamp: tsIn, message: { content: [{ type: 'text', text: '建议你用 <command-name>/git-push</command-name>' }] } },
      { type: 'user', timestamp: tsIn, message: { content: '帮我提交' } }, // 用户无 command-name
    ])
    // Codex：function_call arguments 含 $prd-test-writer + agent_message 含 $git-push → 都不计
    await writeJsonl(path.join(home, '.codex', 'sessions', '2026', '06', '02', 'r.jsonl'), [
      { type: 'response_item', timestamp: tsIn, payload: { type: 'function_call', arguments: 'run $prd-test-writer now' } },
      { type: 'event_msg', timestamp: tsIn, payload: { type: 'agent_message', message: '我将调用 $git-push' } },
    ])
    const r = await scanSkillUsage(
      { homeDir: home, scanLogFilesInRangeFn: scanLogFilesInRange, pathExistsFn: pathExists, nowFn },
      { windowDays: 30, skillNames: NAMES }
    )
    expect(r.skills.length).toBe(0) // 全是非用户上下文，一个都不计
    expect(r.totals.total).toBe(0)
  })

  it('Codex response_item/message(role=user) 的 $skill 计入（OpenAI Responses 格式）', async () => {
    await writeJsonl(path.join(home, '.codex', 'sessions', '2026', '06', '03', 'r.jsonl'), [
      { type: 'response_item', timestamp: tsIn, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '用 $git-push 推一下' }] } },
    ])
    const r = await scanSkillUsage(
      { homeDir: home, scanLogFilesInRangeFn: scanLogFilesInRange, pathExistsFn: pathExists, nowFn },
      { windowDays: 30, skillNames: NAMES }
    )
    const byName = Object.fromEntries(r.skills.map((s) => [s.name, s]))
    expect(byName['git-push']).toMatchObject({ codex: 1, total: 1 })
  })
})
