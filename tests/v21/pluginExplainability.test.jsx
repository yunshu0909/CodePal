/**
 * v2.1 Plugin 用途、子 Skill 与降级说明测试
 *
 * 所有 Plugin 文件均写入临时目录，官方状态由 fake CLI 返回。
 *
 * @module tests/v21/pluginExplainability
 */

import React from 'react'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PluginControlPage from '../../src/pages/PluginControlPage'

let getPluginControlSnapshot

beforeAll(async () => {
  const modulePath = '../../electron/services/pluginControlService.js'
  const module = await import(/* @vite-ignore */ modulePath)
  ;({ getPluginControlSnapshot } = module.default || module)
})

function cliResult(value) {
  return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 }
}

async function writeSkill(root, name, description) {
  const skillPath = path.join(root, 'skills', name)
  await fs.mkdir(skillPath, { recursive: true })
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`)
}

function installPageSnapshot(value) {
  window.electronAPI = {
    getPluginControlSnapshot: vi.fn(async () => ({ success: true, data: value })),
    executePluginCommand: vi.fn(async () => ({ success: true, snapshot: value })),
  }
}

describe('v2.1 Plugin explainability', () => {
  let sandbox
  let homeDir

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-plugin-explain-'))
    homeDir = path.join(sandbox, 'home')
    await fs.mkdir(homeDir, { recursive: true })
  })

  afterEach(async () => {
    cleanup()
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  it('SC-003 reads manifest and child skills then explains disable impact and search', async () => {
    const pluginRoot = path.join(sandbox, 'dev-workflow')
    await fs.mkdir(path.join(pluginRoot, '.codex-plugin'), { recursive: true })
    await fs.writeFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'dev-workflow',
      description: '从 Issue、规格、TDD 到交付的完整开发流程',
    }))
    await writeSkill(pluginRoot, 'orchestrate-development', '统筹需求从 Issue 到本地候选发布')
    await writeSkill(pluginRoot, 'workflow-core', '维护证据链与可检验状态')
    await writeSkill(pluginRoot, 'task-spec', '创建并校验规格包')

    const runCommand = vi.fn(async (binary) => binary === 'codex'
      ? cliResult({ installed: [{
          pluginId: 'dev-workflow@local', name: 'dev-workflow', installed: true, enabled: true,
          version: '0.9.2', marketplaceName: 'local', source: { source: 'local', path: pluginRoot },
        }], available: [] })
      : cliResult([]))

    const snapshot = await getPluginControlSnapshot({ homeDir }, { runCommand })
    const plugin = snapshot.plugins.find((item) => item.id === 'dev-workflow@local')
    expect(plugin).toEqual(expect.objectContaining({
      installed: true,
      enabled: true,
      description: '从 Issue、规格、TDD 到交付的完整开发流程',
      metadataStatus: 'ready',
    }))
    expect(plugin.childSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'workflow-core', description: '维护证据链与可检验状态' }),
      expect.objectContaining({ name: 'task-spec', description: '创建并校验规格包' }),
    ]))
    expect(plugin.capabilities.skills).toBeGreaterThanOrEqual(3)
    expect(snapshot.summary.activeSkills).toBe(3)
    expect(JSON.stringify(snapshot)).not.toContain(pluginRoot)

    installPageSnapshot(snapshot)
    render(<PluginControlPage />)
    expect(await screen.findByText('Plugin 与作用')).toBeTruthy()
    expect(screen.getByText('Plugin 所带 Skill 只在这里查看', { exact: false })).toBeTruthy()
    expect(screen.getByText('从 Issue、规格、TDD 到交付的完整开发流程')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('搜索 Plugin'), { target: { value: '证据链' } })
    expect(await screen.findByText('dev-workflow')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看 dev-workflow 详情' }))
    expect(screen.getByText('包含的 Skills')).toBeTruthy()
    expect(screen.getByText('workflow-core')).toBeTruthy()
    expect(screen.getByText('维护证据链与可检验状态')).toBeTruthy()
    expect(screen.getByText('不会删除 Plugin 文件', { exact: false })).toBeTruthy()
  })

  it('SC-004 preserves official plugin state when local metadata is unavailable', async () => {
    const runCommand = vi.fn(async (binary) => binary === 'codex'
      ? cliResult({ installed: [{
          pluginId: 'unknown-tool@local', name: 'unknown-tool', installed: true, enabled: true,
          version: '1.0.0', marketplaceName: 'local', source: { source: 'local', path: '/secret/missing-plugin' },
        }], available: [] })
      : cliResult([]))

    const snapshot = await getPluginControlSnapshot({ homeDir }, { runCommand })
    const plugin = snapshot.plugins.find((item) => item.id === 'unknown-tool@local')
    expect(plugin).toEqual(expect.objectContaining({
      installed: true,
      enabled: true,
      description: '',
      metadataStatus: 'unavailable',
      childSkills: [],
    }))
    expect(snapshot.metadataPartial).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('/secret/')

    installPageSnapshot(snapshot)
    render(<PluginControlPage />)
    expect(await screen.findByText('unknown-tool')).toBeTruthy()
    expect(screen.getByText('Plugin 所带 Skill 只在这里查看', { exact: false })).toBeTruthy()
    expect(screen.getByText('部分 Plugin 元数据暂时不可读取', { exact: false })).toBeTruthy()
    expect(screen.getByText('未知用途不会被推测', { exact: false })).toBeTruthy()
    expect(screen.getByText('暂无说明')).toBeTruthy()
    expect(screen.getByRole('button', { name: '停用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '卸载 unknown-tool' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '查看 unknown-tool 详情' }))
    expect(screen.getByText('未发现可读取的 Skill')).toBeTruthy()
    expect(screen.getByText('不会删除 Plugin 文件', { exact: false })).toBeTruthy()
  })
})
