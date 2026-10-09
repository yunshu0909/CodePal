/**
 * v2.1.21 TC-002：证据不全但来源可读时，恢复 v2.1.3 定稿的「在用 / 没用」分组与排序。
 * 在用按次数从多到少；没用里还在任一工具启用的排前面，其余按名字。
 * 只有读取中、整体读取失败、某个普通 Skill 来源真的读不出时，才退回「资产库」按名字排。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import SkillsPage from '../../../src/pages/skills/SkillsPage'
import { buildGroups, needsUsageFallback } from '../../../src/pages/skills/skillsModel'
import { resetSkillUsageCache } from '../../../src/hooks/useSkillUsage'

vi.mock('../../../src/store/skillRepoPath', () => ({ skillRepoPath: { getRepoPath: vi.fn(async () => '/library'), getCachedRepoPath: vi.fn(() => '/library') } }))

const asset = (name, loaded) => ({ name, displayName: name, managed: true, description: '用途说明', origins: [], locations: [{ toolId: 'central', path: '/library/' + name }],
  tools: { codex: { enabled: loaded, state: loaded ? 'synced' : 'disabled', mutable: true }, 'claude-code': { enabled: false, state: 'disabled', mutable: true } } })
// 名字故意和次数顺序相反，按名字排时一眼能看出来
const skills = [asset('alpha', false), asset('bravo', true), asset('delta', false), asset('echo', true), asset('zulu', false)]
const counts = { alpha: 1, bravo: 0, delta: 0, echo: 0, zulu: 9 }
// 统计证据不全（日志有读不懂的行）：total 仍是确认次数，completeness 只是诊断
const usageOf = (name, extra = {}) => ({ name, assetId: 'asset-' + name, total: counts[name], confirmedTotal: counts[name], claude: counts[name], codex: 0,
  completeness: 'pending', uncertaintyScope: 'all', availability: 'available', batchId: 'batch-a', ...extra })
const usageMap = (extra = {}) => new Map(skills.map((skill) => [skill.name, usageOf(skill.name, extra[skill.name])]))
const idsOf = (groups, id) => groups.find((group) => group.id === id)?.skills.map((skill) => skill.name)

beforeEach(() => {
  resetSkillUsageCache()
  const snapshot = { skills, errors: [], tools: {
    codex: { available: true, load: { total: 2, personal: 2, tokens: 20 } },
    'claude-code': { available: true, load: { total: 0, personal: 0, tokens: 0 } },
  } }
  window.electronAPI = {
    getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: snapshot })),
    executeSkillCommand: vi.fn(async () => ({ success: true, snapshot })),
    aggregateSkillUsage: vi.fn(async () => ({ success: true, data: { batchId: 'batch-a', skills: skills.map((skill) => usageOf(skill.name)) } })),
    listSkillRunSamples: vi.fn(async () => ({ success: true, data: { records: [] } })),
  }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('v2.1.21 TC-002 在用 / 没用分组回来', () => {
  it('TC-002 证据不全不再退回资产库：在用按次数降序，没用里启用的在前、其余按名字', () => {
    const map = usageMap()
    expect(needsUsageFallback(skills, map, 'ready'), 'USED_UNUSED_HIDDEN fallback').toBe(false)
    const groups = buildGroups(skills, { usageMap: map })
    expect(groups.map((group) => group.id), 'USED_UNUSED_HIDDEN groups').toEqual(['used', 'unused'])
    expect(idsOf(groups, 'used')).toEqual(['zulu', 'alpha'])
    expect(idsOf(groups, 'unused')).toEqual(['bravo', 'echo', 'delta'])
  })

  it('TC-002 来源真的读不出、读取中、整体失败时仍退回资产库按名字排', () => {
    const broken = usageMap({ delta: { availability: 'error' } })
    expect(needsUsageFallback(skills, broken, 'ready')).toBe(true)
    expect(idsOf(buildGroups(skills, { usageMap: broken }), 'library')).toEqual(['alpha', 'bravo', 'delta', 'echo', 'zulu'])
    expect(needsUsageFallback(skills, usageMap(), 'loading')).toBe(true)
    expect(needsUsageFallback(skills, usageMap(), 'error')).toBe(true)
  })

  it('TC-002 整页：两个页签「在用」「没用」出现，列表按次数排', async () => {
    const view = render(<SkillsPage />)
    await waitFor(() => expect(screen.queryAllByRole('tab').length, 'USED_UNUSED_HIDDEN tabs').toBeGreaterThan(0))
    expect(screen.queryAllByRole('tab').map((tab) => tab.textContent), 'USED_UNUSED_HIDDEN tabs').toEqual(['在用2', '没用3'])
    const ids = [...view.container.querySelectorAll('.np-pane--list .np-pane-body [role="option"]')].map((node) => node.getAttribute('data-id'))
    expect(ids).toEqual(['zulu', 'alpha'])
  })
})
