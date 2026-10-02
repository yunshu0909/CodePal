/**
 * 代码审核（lite.G1 第 2 轮）指出的页面问题的回归测试（specs/skills-redesign-dev2 TC-057、TC-059）
 *
 * 负责：
 * - 两个工具里各有一份外部的：「收进资产库」禁用，启用卡里说明为什么
 * - 外部 Skill 的「收进资产库后才能装到 X」按工具写，只装在 Codex 的外部 Skill，Claude 那行写 Claude Code
 * - electronAPI 全是假的；页面用动态 import
 *
 * @module tests/skills/SkillsPageReview2.test
 */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../../src/store/skillRepoPath', () => ({
  skillRepoPath: { getRepoPath: vi.fn(async () => '/Users/me/Documents/SkillManager'), getCachedRepoPath: vi.fn(() => null) },
  toolDefinitions: [],
}))

const external = (origin = 'user') => ({ enabled: true, state: 'external', mutable: true, origin })
const absent = () => ({ enabled: false, state: 'disabled', mutable: true })

function snapshot() {
  return {
    generatedAt: '2026-09-29T10:42:00.000Z',
    partial: false,
    errors: [],
    tools: {
      'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, load: { personal: 1, synced: 0, total: 1, tokens: 100 } },
      codex: { id: 'codex', name: 'Codex', available: true, load: { personal: 2, system: 0, total: 2, tokens: 100 } },
    },
    skills: [
      {
        name: 'both-sides', displayName: 'both-sides', description: '两边各一份', managed: false,
        origins: [{ toolId: 'claude-code', origin: 'user', mutable: true }, { toolId: 'codex', origin: 'user', mutable: true }],
        tools: { 'claude-code': external(), codex: external() },
        locations: [{ toolId: 'claude-code', path: '~/.claude/skills/both-sides', missing: false }, { toolId: 'codex', path: '~/.agents/skills/both-sides', missing: false }],
      },
      {
        name: 'codex-only', displayName: 'codex-only', description: '只在 Codex', managed: false,
        origins: [{ toolId: 'codex', origin: 'user', mutable: true }],
        tools: { 'claude-code': absent(), codex: external() },
        locations: [{ toolId: 'codex', path: '~/.agents/skills/codex-only', missing: false }],
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

async function openDetail(name) {
  const item = screen.getAllByRole('option').find((node) => within(node).queryByText(name, { exact: true }))
  fireEvent.click(item)
  const heading = await screen.findByRole('heading', { level: 2, name })
  return heading.closest('.np-pane--detail')
}

afterEach(() => cleanup())

describe('审核修复：外部 Skill', () => {
  it('TC-057 ADOPT_CONFLICT 两个工具里各有一份外部的：收进资产库禁用，并说明先删掉一份', async () => {
    await renderPage()
    const pane = await openDetail('both-sides')
    expect(within(pane).getByRole('button', { name: '收进资产库' }).disabled).toBe(true)
    expect(pane.textContent).toContain('两个工具里各有一份')
    expect(pane.textContent).toContain('先在工具目录里删掉其中一份再收进资产库')
    expect(window.electronAPI.executeSkillCommand).not.toHaveBeenCalled()
  })

  it('TC-059 EXTERNAL_NOTE_PER_TOOL 只装在 Codex 的外部 Skill：Claude 那行写装到 Claude Code，不写 Codex', async () => {
    await renderPage()
    const pane = await openDetail('codex-only')
    const claudeRow = within(pane).getByText('Claude Code', { selector: '.lb' }).closest('.np-row')
    expect(claudeRow.textContent).toContain('收进资产库后才能装到 Claude Code')
    expect(claudeRow.textContent).not.toContain('装到 Codex')
  })
})
