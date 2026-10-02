/**
 * Skills 只留一套引擎（specs/v2.1.9-Skills只留一套引擎）：入口与保留的共用接口
 *
 * 负责：
 * - TC-002：点 Skills 直接进新页面（App 不再先判断资产库是否为空、不再走旧模块容器）；资产库为空时就是新页面的空状态
 * - TC-010（守卫）：退役旧引擎时，新建项目用的 select-folder、用量目标用的 store 通道、模型 / 权限 5 个 preload API 都还在
 * - electronAPI 全部是假的，不读真实目录
 *
 * @module tests/skills/oneEngineApp.test
 */

import React from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf-8')

afterEach(() => {
  cleanup()
  delete window.electronAPI
})

function emptySnapshot() {
  return {
    generatedAt: '2026-10-02T10:00:00.000Z',
    partial: false,
    errors: [],
    central: { available: true, exists: true, skillCount: 0 },
    tools: {
      'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, load: { personal: 0, synced: 0, total: 0, tokens: 0 } },
      codex: { id: 'codex', name: 'Codex', available: true, load: { personal: 0, system: 0, total: 0, tokens: 0 } },
    },
    skills: [],
    summary: {},
  }
}

describe('点 Skills 直接进新页面', () => {
  it('TC-002 ONE_ENGINE_APP App 直接渲染新 Skills 页；资产库为空时显示新页面的空状态', async () => {
    const app = read('src/App.jsx')
    expect(app, 'ONE_ENGINE_APP App 应直接引入新 Skills 页').toMatch(/import SkillsPage from '\.\/pages\/skills\/SkillsPage'/)
    expect(app, 'ONE_ENGINE_APP App 应在 Skills 模块渲染 SkillsPage').toMatch(/activeModule === 'skills' && <SkillsPage \/>/)
    for (const legacy of ['SkillManagerModule', 'hasCentralSkills', 'loading-state', 'initialSkillManagerPage']) {
      expect(app.includes(legacy), `ONE_ENGINE_APP App 仍有旧入口 ${legacy}`).toBe(false)
    }

    window.electronAPI = {
      getSkillRepoPath: vi.fn(async () => ({ success: true, data: '~/Documents/SkillManager/', error: null })),
      getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: emptySnapshot(), error: null })),
      executeSkillCommand: vi.fn(async () => ({ success: true, data: {}, error: null })),
      aggregateSkillUsage: vi.fn(async () => ({ success: true, data: { skills: [] } })),
      listSkillRunSamples: vi.fn(async () => ({ success: true, data: { records: [] } })),
    }
    const { default: SkillsPage } = await import('../../src/pages/skills/SkillsPage')
    render(<SkillsPage />)
    expect(await screen.findByText('资产库还没有 Skill')).toBeTruthy()
    await act(async () => {})
    expect(screen.queryByText('导入 Skills')).toBeNull()
    expect(window.electronAPI.getSkillRepoPath).toHaveBeenCalled()
  })
})

describe('退役旧引擎时共用接口保留', () => {
  it('TC-010 select-folder、store 通道、模型 / 权限 5 个 preload API 仍在；isRendererStoreKey 行为不变', () => {
    const main = read('electron/main.js')
    for (const channel of ['select-folder', 'get-store', 'set-store', 'delete-store']) {
      expect(main).toContain(`'${channel}'`)
    }
    const preload = read('electron/preload.js')
    for (const api of ['selectFolder', 'getStore', 'setStore', 'deleteStore', 'getModelConfig', 'setModelConfig', 'resetModelConfig', 'resetPermissionMode', 'restorePermissionMode']) {
      expect(preload).toMatch(new RegExp(`^\\s{2}${api}\\s*:`, 'm'))
    }
    expect(read('src/pages/projectInit/useProjectInit.js')).toContain('selectFolder')
    const { isRendererStoreKey } = require('../../electron/services/genericFileGuards')
    expect(isRendererStoreKey('usageGoal')).toBe(true)
    expect(isRendererStoreKey('usageGoalDismissed')).toBe(true)
    expect(isRendererStoreKey('repoPath')).toBe(false)
  })
})
