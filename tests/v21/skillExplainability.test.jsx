/**
 * v2.1 Skill 来源真相与可解释性测试
 *
 * 通过临时 HOME 验证 Skill 控制中心只发现独立 Skill，
 * Plugin 子 Skill 与 Plugin inventory 故障均不会进入 Skill 快照或页面。
 *
 * @module tests/v21/skillExplainability
 */

import React from 'react'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ManagePage from '../../src/pages/ManagePage'
import { dataStore } from '../../src/store/data'

let discoverCodexSkills
let getSkillControlSnapshot

vi.mock('../../src/hooks/useSkillUsage', () => ({
  default: () => ({ status: 'ready', usageMap: new Map(), sources: {} }),
}))
vi.mock('../../src/hooks/useTagManagement', () => ({
  default: () => ({
    tags: [], skillTags: {}, activeTagFilter: null, setActiveTagFilter: vi.fn(),
    isTagModalOpen: false, setIsTagModalOpen: vi.fn(), loadTagData: vi.fn(async () => {}),
    handleAssignTag: vi.fn(), handleRemoveTag: vi.fn(), handleCreateTag: vi.fn(),
    handleRenameTag: vi.fn(), handleDeleteTag: vi.fn(),
  }),
}))
vi.mock('../../src/store/data', () => ({
  dataStore: {
    getCentralSkills: vi.fn(async () => []),
    getRepoPath: vi.fn(async () => '/tmp/catalog'),
    getPushTargets: vi.fn(async () => []),
    isPushed: vi.fn(async () => false),
  },
  toolDefinitions: [],
}))

beforeAll(async () => {
  const adapterPath = '../../electron/services/skillAdapters/codexSkillAdapter.js'
  const servicePath = '../../electron/services/skillControlService.js'
  const adapter = await import(/* @vite-ignore */ adapterPath)
  const service = await import(/* @vite-ignore */ servicePath)
  ;({ discoverCodexSkills } = adapter.default || adapter)
  ;({ getSkillControlSnapshot } = service.default || service)
})

async function writeSkill(root, name, description) {
  const skillPath = path.join(root, name)
  await fs.mkdir(skillPath, { recursive: true })
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`)
  return skillPath
}

function installPageSnapshot(value) {
  window.electronAPI = {
    getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: value })),
    executeSkillCommand: vi.fn(async () => ({ success: true, snapshot: value })),
  }
}

describe('v2.1 Skill explainability', () => {
  let sandbox
  let homeDir
  let repoPath

  beforeEach(async () => {
    vi.clearAllMocks()
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-skill-explain-'))
    homeDir = path.join(sandbox, 'home')
    repoPath = path.join(sandbox, 'catalog')
    await fs.mkdir(repoPath, { recursive: true })
    dataStore.getCentralSkills.mockResolvedValue([])
  })

  afterEach(async () => {
    cleanup()
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  it('SC-001 filters plugin skills by official enabled inventory and explains immutable origins', async () => {
    const activeRoot = path.join(sandbox, 'plugins', 'active')
    const disabledRoot = path.join(sandbox, 'plugins', 'disabled')
    await writeSkill(path.join(activeRoot, 'skills'), 'active-helper', '维护证据链与交付状态')
    await writeSkill(path.join(disabledRoot, 'skills'), 'disabled-helper', '不应加载')
    await writeSkill(path.join(homeDir, '.codex', 'plugins', 'cache', 'vendor', 'cached', '1.0.0', 'skills'), 'cached-helper', '只在缓存')
    await writeSkill(path.join(homeDir, '.agents', 'skills'), 'personal-helper', '个人目录中的可变 Skill')
    await writeSkill(path.join(homeDir, '.codex', 'skills', '.system'), 'system-helper', 'Codex 系统提供')

    const listPluginInventory = vi.fn(async () => [
      { id: 'dev-workflow@local', name: 'dev-workflow', installed: true, enabled: true, localRoot: activeRoot },
      { id: 'disabled@local', name: 'disabled', installed: true, enabled: false, localRoot: disabledRoot },
    ])

    const discovered = await discoverCodexSkills({ homeDir }, { listPluginInventory })
    expect(discovered.sources.map((source) => source.name)).toEqual(expect.arrayContaining([
      'personal-helper', 'system-helper',
    ]))
    expect(discovered.sources.some((source) => source.name === 'active-helper')).toBe(false)
    expect(discovered.sources.some((source) => source.name === 'disabled-helper')).toBe(false)
    expect(discovered.sources.some((source) => source.name === 'cached-helper')).toBe(false)
    expect(listPluginInventory).not.toHaveBeenCalled()

    const snapshot = await getSkillControlSnapshot({ homeDir, repoPath }, { listPluginInventory })
    expect(snapshot.summary.codexEnabled).toBe(2)
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain('active-helper')
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain('disabled-helper')
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain('cached-helper')
    expect(JSON.stringify(snapshot)).not.toContain(activeRoot)

    installPageSnapshot(snapshot)
    render(<ManagePage onNavigateToConfig={vi.fn()} />)
    await screen.findByText('Skill 与作用')
    expect(screen.getByText('这里只显示独立 Skill', { exact: false })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('搜索 Skill'), { target: { value: '证据链' } })
    expect(screen.queryByText('active-helper')).toBeNull()
    expect(screen.queryByText('Plugin Skill')).toBeNull()
    expect(screen.queryByText('随 Plugin 启用')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('搜索 Skill'), { target: { value: 'personal-helper' } })
    expect(await screen.findByText('personal-helper')).toBeTruthy()
    expect(await screen.findByRole('button', { name: '收进资产库' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看 personal-helper 详情' }))
    expect(screen.getByText('如何处理')).toBeTruthy()
  })

  it('SC-002 keeps confirmed skills usable when plugin inventory fails without trusting cache', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'plugins', 'cache', 'vendor', 'cached', '1.0.0', 'skills'), 'cached-helper', '只在缓存')
    await writeSkill(path.join(homeDir, '.agents', 'skills'), 'personal-helper', '明确存在于个人目录')
    const listPluginInventory = vi.fn(async () => {
      throw Object.assign(new Error('failed at /Users/private with token_redacted_fixture'), { code: 'ENOENT' })
    })

    const snapshot = await getSkillControlSnapshot({ homeDir, repoPath }, { listPluginInventory })
    expect(listPluginInventory).not.toHaveBeenCalled()
    expect(snapshot.partial).toBe(false)
    expect(snapshot.skills.map((skill) => skill.name)).toContain('personal-helper')
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain('cached-helper')
    expect(snapshot.errors.some((error) => error.origin === 'plugin')).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('/Users/private')
    expect(JSON.stringify(snapshot)).not.toContain('token_redacted_fixture')

    installPageSnapshot(snapshot)
    render(<ManagePage onNavigateToConfig={vi.fn()} />)
    expect(await screen.findByText('personal-helper')).toBeTruthy()
    expect(screen.queryByText('Codex Plugin 状态暂时不可读取', { exact: false })).toBeNull()
    expect(screen.queryByText('缓存不会被当作已启用', { exact: false })).toBeNull()
    expect(screen.getByRole('button', { name: '收进资产库' })).toBeTruthy()
  })
})
