/**
 * Skills 要处理（specs/v2.1.11-Skills要处理-实现）页面测试共用的快照样本与渲染
 *
 * 负责：
 * - 照定稿包（specs/v2.1.10-Skills要处理与收进/Skills要处理-定稿/）的画面造快照：要处理清单、找到的项目、
 *   已忽略、收进记录、资产库已有的 Skill 与占位原因
 * - 假的 electronAPI：读快照、执行命令（每个用例自己给结果）、次数与调用记录
 * - 渲染 Skills 页、选中左栏一条、读 Toast
 *
 * @module tests/skills/inbox/uiFixtures
 */

import React from 'react'
import { vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as skillUsageModule from '../../../src/hooks/useSkillUsage'

const CENTRAL = '/Users/me/Documents/SkillManager'
const on = (extra = {}) => ({ enabled: true, state: 'synced', mutable: true, origin: 'user', ...extra })
const none = () => ({ enabled: false, state: 'disabled', mutable: true })
const loc = (toolId, p, extra = {}) => ({ toolId, path: p, missing: false, ...extra })

export function managed(name, description, { claude = none(), codex = none(), gate, locations } = {}) {
  return {
    name,
    displayName: name,
    description,
    managed: true,
    origins: [],
    tools: { 'claude-code': claude, codex },
    locations: locations || [loc('central', `${CENTRAL}/${name}`)],
    ...(gate ? { gate } : {}),
  }
}

export function copy(fields) {
  return {
    sourceId: `src_${fields.key || Math.random().toString(16).slice(2, 18)}`,
    toolId: 'claude-code',
    scope: 'project',
    projectName: 'my-blog',
    displayPath: '~/Documents/projects/my-blog/.claude/skills/x',
    relation: 'none',
    digest: `d_${fields.key || 'x'}`,
    diff: { added: [], removed: [], changed: [] },
    adaptedHint: false,
    isLink: false,
    loadState: 'loaded',
    blockedBy: null,
    ...fields,
  }
}

/** 要处理清单：不一样、资产库已有、资产库没有各几个 */
export function inboxItems() {
  return [
    {
      name: 'writing-assistant',
      displayName: 'writing-assistant',
      description: '写作助手',
      relation: 'diff',
      libraryDigest: 'lib_wa',
      peers: null,
      linkedTools: ['claude-code'],
      copies: [
        copy({ key: 'wa1', toolId: 'claude-code', displayPath: '~/Documents/projects/my-blog/.claude/skills/writing-assistant', relation: 'diff', diff: { added: [], removed: ['stages/00-diagnosis.md', 'stages/01-mining.md', 'stages/02-topic.md'], changed: [] } }),
        copy({ key: 'wa2', toolId: 'codex', displayPath: '~/Documents/projects/my-blog/.agents/skills/writing-assistant', relation: 'diff', diff: { added: [], removed: ['stages/00-diagnosis.md'], changed: ['SKILL.md'] }, adaptedHint: true }),
      ],
    },
    {
      name: 'multi-perspective-analysis',
      displayName: 'multi-perspective-analysis',
      description: '多视角深度分析',
      relation: 'diff',
      libraryDigest: 'lib_mpa',
      peers: null,
      linkedTools: [],
      copies: [
        copy({ key: 'mp1', displayPath: '~/x/test/.claude/skills/multi-perspective-analysis', projectName: 'test', relation: 'diff', diff: { added: [], removed: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'scripts/run.py'], changed: ['SKILL.md'] } }),
      ],
    },
    {
      name: 'github-repo-search',
      displayName: 'github-repo-search',
      description: '帮助用户搜索和筛选 GitHub 开源项目',
      relation: 'same',
      libraryDigest: 'lib_grs',
      peers: null,
      linkedTools: [],
      copies: [copy({ key: 'gr1', displayPath: '~/Documents/projects/my-blog/.claude/skills/github-repo-search', relation: 'same' })],
    },
    {
      name: 'dsh-code-review',
      displayName: 'dsh-code-review',
      description: 'Use when reviewing a pull request',
      relation: 'none',
      libraryDigest: null,
      peers: 'same',
      linkedTools: [],
      copies: [
        copy({ key: 'ds1', projectName: 'cloned-repo', displayPath: '~/Documents/Codex/cloned-repo/.claude/skills/dsh-code-review' }),
        copy({ key: 'ds2', toolId: 'codex', projectName: 'cloned-repo', displayPath: '~/Documents/Codex/cloned-repo/.agents/skills/dsh-code-review' }),
      ],
    },
    {
      name: 'liuyao-divination',
      displayName: 'liuyao-divination',
      description: '六爻复盘与交叉校验',
      relation: 'none',
      libraryDigest: null,
      peers: null,
      linkedTools: [],
      copies: [copy({ key: 'ly1', toolId: 'codex', projectName: 'notes-app', displayPath: '~/Documents/Codex/notes-app/.codex/skills/liuyao-divination' })],
    },
  ]
}

export function baseSkills() {
  return [
    managed('page-solution-design', '和用户一起敲定一个前端页面的整页方案', { claude: on() }),
    managed('writing-assistant', '写作助手', { claude: on() }),
    managed('multi-perspective-analysis', '多视角深度分析'),
    managed('github-repo-search', '帮助用户搜索和筛选 GitHub 开源项目'),
    managed('logo-design', '设计、诊断和迭代产品或品牌 Logo', { codex: on() }),
    {
      name: 'pptx',
      displayName: 'pptx',
      description: 'Use this skill any time a .pptx file is involved',
      managed: false,
      origins: [{ toolId: 'claude-code', origin: 'synced', mutable: false }],
      tools: { 'claude-code': { enabled: true, state: 'external', mutable: false, origin: 'synced' }, codex: none() },
      locations: [loc('claude-code', '~/.claude/skills/synced/acct/pptx')],
    },
    // 全局目录里资产库没有的：Claude 里装着，算「不在资产库」
    {
      name: 'only-global',
      displayName: 'only-global',
      description: '只在全局目录里',
      managed: false,
      origins: [{ toolId: 'claude-code', origin: 'user', mutable: true }],
      tools: { 'claude-code': { enabled: true, state: 'external', mutable: true, origin: 'user' }, codex: none() },
      locations: [loc('claude-code', '~/.claude/skills/only-global')],
    },
  ]
}

export function snapshot({ skills = baseSkills(), items = inboxItems(), ignored = [], operations = [], projects, central, tools } = {}) {
  return {
    generatedAt: '2026-10-03T13:38:00.000Z',
    partial: false,
    errors: [],
    central: central || { available: true, exists: true, skillCount: skills.filter((skill) => skill.managed).length, displayPath: '~/Documents/SkillManager/' },
    tools: tools || {
      'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, load: { personal: 4, synced: 8, total: 12, tokens: 2500 } },
      codex: { id: 'codex', name: 'Codex', available: true, load: { personal: 1, system: 6, total: 7, tokens: 1300 } },
    },
    skills,
    inbox: { items },
    projects: projects || {
      scanned: 9,
      found: [
        { name: 'my-blog', displayPath: '~/Documents/projects/my-blog', copies: 4, error: null },
        { name: 'cloned-repo', displayPath: '~/Documents/Codex/cloned-repo', copies: 2, error: null },
        { name: 'old-notes', displayPath: '~/Documents/old-notes', copies: 0, error: 'PERMISSION_DENIED' },
      ],
    },
    ignored,
    operations,
    summary: {},
  }
}

export const USAGE = [{ name: 'page-solution-design', total: 7, claude: 7, codex: 0 }]

let currentApi = null

export function makeApi({ snap = snapshot(), execute } = {}) {
  return {
    getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: snap, error: null })),
    executeSkillCommand: vi.fn(execute || (async () => ({ success: true, data: { outcome: 'done', snapshot: snap }, snapshot: snap, error: null }))),
    aggregateSkillUsage: vi.fn(async () => ({ success: true, data: { skills: USAGE } })),
    listSkillRunSamples: vi.fn(async () => ({ success: true, data: { records: [] } })),
  }
}

/** 渲染 Skills 页并等第一份快照用上 */
export async function renderPage(options = {}) {
  skillUsageModule.resetSkillUsageCache?.()
  currentApi = options.api || makeApi(options)
  window.electronAPI = currentApi
  const Page = (await import('../../../src/pages/skills/SkillsPage')).default
  const view = render(<Page />)
  await screen.findByText('装载总览', { selector: '.np-li b' })
  await waitFor(() => expect(currentApi.aggregateSkillUsage).toHaveBeenCalled())
  await act(async () => {})
  return { ...view, api: currentApi, Page }
}

export const listItems = () => screen.getAllByRole('option')
/** 左栏一条；不在当前页签就依次点页签去找（v2.1.11 左栏改页签后，和人找一条的做法一样） */
export const listItem = (name) => {
  const find = () => screen.queryAllByRole('option').find((item) => within(item).queryByText(name, { exact: true }))
  let hit = find()
  for (const tab of screen.queryAllByRole('tab')) {
    if (hit) break
    fireEvent.click(tab)
    hit = find()
  }
  return hit
}
export const detail = () => document.querySelector('.np-pane--detail')
export async function select(name) {
  fireEvent.click(listItem(name))
  await screen.findByRole('heading', { name, level: 2 })
}
export const groupTitles = (container) => [...container.querySelectorAll('.np-pane--list .np-lg')].map((node) => node.textContent)
export const toastText = (text) => waitFor(() => expect(document.body.textContent).toContain(text))
/** 详情里某一份副本的那一行（按位置文字找） */
export const copyRow = (pathText) => [...detail().querySelectorAll('.sk-copy')].find((row) => row.textContent.includes(pathText))
export const dialog = () => document.querySelector('[role="dialog"]')
