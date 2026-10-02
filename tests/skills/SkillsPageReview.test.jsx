/**
 * 代码审核（lite.G1 第 1 轮）指出的页面问题的回归测试（specs/skills-redesign-dev2 TC-053、TC-056）
 *
 * 负责：
 * - 只读 Skill 按来源写文案：旧命令不再写成 Codex 系统
 * - 删除按钮用 Button 的 danger 变体（红字）
 * - electronAPI 全是假的；页面用动态 import
 *
 * @module tests/skills/SkillsPageReview.test
 */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../../src/store/skillRepoPath', () => ({
  skillRepoPath: { getRepoPath: vi.fn(async () => '/Users/me/Documents/SkillManager'), getCachedRepoPath: vi.fn(() => null) },
  toolDefinitions: [],
}))

const none = () => ({ enabled: false, state: 'disabled', mutable: true })

function snapshot() {
  return {
    generatedAt: '2026-09-29T10:42:00.000Z',
    partial: false,
    errors: [],
    tools: {
      'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, load: { personal: 1, synced: 0, total: 1, tokens: 100 } },
      codex: { id: 'codex', name: 'Codex', available: true, load: { personal: 0, system: 0, total: 0, tokens: 0 } },
    },
    skills: [
      {
        name: 'mine', displayName: 'mine', description: '我的 Skill', managed: true, origins: [],
        tools: { 'claude-code': { enabled: true, state: 'synced', mutable: true, origin: 'user' }, codex: none() },
        locations: [{ toolId: 'central', path: '/Users/me/Documents/SkillManager/mine', missing: false }, { toolId: 'claude-code', path: '~/.claude/skills/mine', missing: false }],
      },
      {
        name: 'old-command', displayName: 'old-command', description: '', managed: false,
        origins: [{ toolId: 'claude-code', origin: 'command', mutable: false }],
        tools: { 'claude-code': { enabled: true, state: 'external', mutable: false, origin: 'command' }, codex: none() },
        locations: [{ toolId: 'claude-code', path: '~/.claude/commands/old-command.md', missing: false }],
      },
    ],
  }
}

async function renderPage() {
  window.electronAPI = {
    getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: snapshot() })),
    executeSkillCommand: vi.fn(),
    aggregateSkillUsage: vi.fn(async () => ({ success: true, data: { skills: [] } })),
    listSkillRunSamples: vi.fn(async () => ({ success: true, data: { records: [] } })),
  }
  const Page = (await import('../../src/pages/skills/SkillsPage')).default
  render(<Page />)
  await screen.findByText('装载总览', { selector: '.np-li b' })
}

const option = (name) => screen.getAllByRole('option').find((item) => within(item).queryByText(name, { exact: true }))

afterEach(() => cleanup())

describe('审核修复：页面', () => {
  it('TC-053 READONLY_COMMAND_LABELS 旧命令：行尾写旧命令，栏头与去哪关按旧命令写，不出现 Codex 系统', async () => {
    await renderPage()
    const item = option('old-command')
    expect(item.textContent).toContain('旧命令')
    expect(item.textContent).not.toContain('Codex')
    fireEvent.click(item)
    const pane = await screen.findByRole('heading', { level: 2, name: 'old-command' }).then((node) => node.closest('.np-pane--detail'))
    expect(pane.textContent).toContain('Claude Code 旧命令 · 只读')
    expect(pane.textContent).toContain('在 ~/.claude/commands 里管理')
    expect(pane.textContent).not.toContain('Codex 自带')
  })

  it('TC-056 DELETE_DANGER 删除按钮是危险样式', async () => {
    await renderPage()
    fireEvent.click(option('mine'))
    const pane = await screen.findByRole('heading', { level: 2, name: 'mine' }).then((node) => node.closest('.np-pane--detail'))
    // 危险样式由 Button 的 danger 变体给出（类名 btn--danger）；页面自拼的 np-btn--danger 在 native.css 里没有定义
    expect(within(pane).getByRole('button', { name: '删除' }).classList.contains('btn--danger')).toBe(true)
  })
})
