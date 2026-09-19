/**
 * 会话状态钩子脚本测试（#41）
 *
 * 负责：在临时 HOME 里真跑 templates/k28-status-light/k28_status.sh，确认写下的状态符合触发表
 * - 发消息 → 进行中，「在干嘛」= 前 30 字（不调模型）
 * - 停下来问你 → 等你确认，存下它问的话；回答后回到进行中、问话删掉
 * - 做完 → 完成了，「在干嘛」保留
 * - Claude 打开会话（SessionStart）不写；会话结束全部删掉
 * - 总闸为 0 时不记录
 *
 * @module tests/sessionStatusHook
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(root, 'templates', 'k28-status-light', 'k28_status.sh')

let home
let states
const run = (state, payload) => execFileSync('bash', [SCRIPT, state], {
  input: JSON.stringify({ session_id: 'sess-1', cwd: '/tmp/work/skill-manager', ...payload }),
  env: { PATH: process.env.PATH, HOME: home },
})
const read = (ext) => {
  const file = path.join(states, `sess_1.${ext}`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-hook-'))
  const dir = path.join(home, '.claude', 'k28-status-light')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'tts.conf'), 'STATUS_LIGHT_ENABLED=1\n')
  states = path.join(dir, 'states')
})

describe('k28_status.sh 按触发表写状态', () => {
  it('一个 Claude 会话从头到尾', () => {
    run('idle', {})
    expect(read('txt')).toBeNull() // 打开会话不显示

    const prompt = '帮我把状态灯改成小组件，并且在会话做完或者等我确认的时候发系统通知，谢谢'
    run('busy', { prompt })
    const [state, epoch, name, source] = read('txt').split('\t')
    expect([state, name, source]).toEqual(['busy', 'skill-manager', 'Claude'])
    expect(Number(epoch)).toBeGreaterThan(0)
    expect(read('task')).toBe(prompt.slice(0, 30))

    run('attention', { tool_input: { questions: [{ question: '要改 k28 目录名吗？', header: '目录' }] } })
    expect(read('txt').split('\t')[0]).toBe('attention')
    expect(read('ask')).toBe('要改 k28 目录名吗？')

    run('busy', {}) // PostToolUse：回答了，没有 prompt
    expect(read('txt').split('\t')[0]).toBe('busy')
    expect(read('ask')).toBeNull()
    expect(read('task')).toBe(prompt.slice(0, 30))

    run('done', {})
    expect(read('txt').split('\t')[0]).toBe('done')
    expect(read('task')).toBe(prompt.slice(0, 30)) // 完成时保留「在干嘛」

    run('idle', {}) // 上下文压缩等 SessionStart 不改状态
    expect(read('txt').split('\t')[0]).toBe('done')

    run('clear', {})
    expect([read('txt'), read('task'), read('ask')]).toEqual([null, null, null])
  })

  it('总闸为 0 时不记录，但 clear 照常清理', () => {
    fs.writeFileSync(path.join(home, '.claude', 'k28-status-light', 'tts.conf'), 'STATUS_LIGHT_ENABLED=0\n')
    run('busy', { prompt: '你好' })
    expect(read('txt')).toBeNull()
  })

  it('不再调用语音、亮灯、模型摘要', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8')
    expect(text).not.toMatch(/tts_say|k28_render|summarize_task|launchctl/)
  })
})

describe('codex-hook.sh：完成后 30 分钟清掉', () => {
  it('计时从 10 分钟改成 30 分钟', () => {
    const text = fs.readFileSync(path.join(root, 'templates', 'k28-status-light', 'codex-hook.sh'), 'utf8')
    expect(text).not.toMatch(/\b600\b/)
    expect(text.match(/\b1800\b/g)).toHaveLength(3)
    expect(text).not.toMatch(/k28_render/)
  })
})
