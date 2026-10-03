/**
 * Skill 管理页组件测试（Native+ 双栏，照签收的定稿包 specs/skills-redesign/Skill管理-定稿/）
 *
 * 负责：
 * - 按 specs/skills-redesign-dev2/1-plan.md 测试清单断言页面可观察结果（TC-014–033、040–044、047、048；TC-045 在 SkillsPage.visual.test.js）
 * - electronAPI 全部是假的，不读真实目录；Toast 与确认框用真实的全局组件
 * - 页面用动态 import：新页面不存在时只让用到它的用例失败，守卫用例（TC-047）照常跑
 *
 * @module tests/skills/SkillsPage.test
 */

import React from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import useSkillControl from '../../src/hooks/useSkillControl'
import * as skillUsageModule from '../../src/hooks/useSkillUsage'
import { resetToastForTests } from '../../src/components/Toast'

// 调用记录的时间写法（今天 / 周几 / 几月几日）依赖「现在」和时区：固定成样本数据所在的那一刻
process.env.TZ = 'Asia/Shanghai'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// 资产库路径由主进程给（v2.1.9 起经 skill-control:get-repo-path，见 src/store/skillRepoPath.js）
vi.mock('../../src/store/skillRepoPath', () => ({
  skillRepoPath: {
    getRepoPath: vi.fn(async () => '/Users/me/Documents/SkillManager'),
    getCachedRepoPath: vi.fn(() => null),
  },
}))

const loadPage = async () => (await import('../../src/pages/skills/SkillsPage')).default

// ---------- 快照样本（按 2026-09-29 本机真实数据缩小） ----------
const CENTRAL = '/Users/me/Documents/SkillManager'
const on = (extra = {}) => ({ enabled: true, state: 'synced', mutable: true, origin: 'user', ...extra })
const off = (extra = {}) => ({ enabled: false, state: 'disabled', mutable: true, ...extra })
const none = () => ({ enabled: false, state: 'disabled', mutable: true })
const loc = (toolId, p, extra = {}) => ({ toolId, path: p, missing: false, ...extra })

function managed(name, description, { claude = none(), codex = none(), locations } = {}) {
  return {
    name,
    displayName: name,
    description,
    managed: true,
    origins: [],
    tools: { 'claude-code': claude, codex },
    locations: locations || [loc('central', `${CENTRAL}/${name}`)],
  }
}

function baseSkills() {
  return [
    {
      ...managed('page-solution-design', '和用户一起敲定一个前端页面的整页方案', {
        claude: on(), codex: off(),
        locations: [loc('central', `${CENTRAL}/page-solution-design`), loc('claude-code', '~/.claude/skills/page-solution-design')],
      }),
      // 快照里带同名 Skill 的插件（主进程从 Codex 官方接口的 pluginId 读出）
      plugins: ['dev-workflow'],
    },
    managed('viral-title', 'Generate high-potential viral title candidates', { claude: on(), codex: on() }),
    managed('readable-output', '产出给人读的 HTML 长文', { claude: on(), codex: on() }),
    managed('memory-init', '在当前目录下初始化记忆系统', { claude: on(), codex: on() }),
    managed('logo-design', '设计、诊断和迭代产品或品牌 Logo', {
      claude: off(), codex: on({ duplicate: true }),
      locations: [loc('central', `${CENTRAL}/logo-design`), loc('codex', '~/.agents/skills/logo-design'), loc('codex', '~/.codex/skills/logo-design')],
    }),
    managed('aippt', 'AIPPT - 从文章生成精美 PPT 的完整工作流', {}),
    managed('weekly-report', '帮助用户梳理周报', {
      claude: on(),
      locations: [loc('central', `${CENTRAL}/weekly-report`), loc('claude-code', '~/.claude/skills/weekly-report', { missing: true })],
    }),
    {
      name: 'baseplate-deck',
      displayName: 'baseplate-deck',
      description: '用主办方给的 PPT 模板做一套深色演讲 PPT',
      managed: false,
      origins: [{ toolId: 'claude-code', origin: 'user', mutable: true }],
      tools: { 'claude-code': { enabled: true, state: 'external', mutable: true, origin: 'user' }, codex: none() },
      locations: [loc('claude-code', '~/.claude/skills/baseplate-deck', { target: '/Users/me/Documents/projects/知识库/分享/PPT/skill/baseplate-deck' })],
    },
    {
      name: 'slides-pec2026',
      displayName: 'slides-pec2026',
      description: '用 PEC2026 主办方底板做一套深色演讲 PPT',
      managed: false,
      origins: [{ toolId: 'claude-code', origin: 'user', mutable: true }],
      tools: { 'claude-code': { enabled: true, state: 'external', mutable: true, origin: 'user' }, codex: none() },
      locations: [loc('claude-code', '~/.claude/skills/slides-pec2026')],
    },
    {
      name: 'pptx',
      displayName: 'pptx',
      description: 'Use this skill any time a .pptx file is involved',
      managed: false,
      origins: [{ toolId: 'claude-code', origin: 'synced', mutable: false }],
      tools: { 'claude-code': { enabled: true, state: 'external', mutable: false, origin: 'synced' }, codex: none() },
      locations: [loc('claude-code', '~/.claude/skills/synced/acct/pptx')],
    },
    {
      name: 'imagegen',
      displayName: 'imagegen',
      description: 'Generate images',
      managed: false,
      origins: [{ toolId: 'codex', origin: 'system', mutable: false }],
      tools: { 'claude-code': none(), codex: { enabled: true, state: 'external', mutable: false, origin: 'system' } },
      locations: [loc('codex', '~/.codex/skills/.system/imagegen')],
    },
  ]
}

function snapshot({ skills = baseSkills(), errors = [], tools } = {}) {
  return {
    generatedAt: '2026-09-29T10:42:00.000Z',
    partial: errors.length > 0,
    errors,
    central: { available: true, exists: true, skillCount: skills.filter((skill) => skill.managed).length },
    tools: tools || {
      'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, load: { personal: 7, synced: 8, total: 15, tokens: 2500 } },
      codex: { id: 'codex', name: 'Codex', available: true, load: { personal: 6, system: 6, total: 12, tokens: 1300 } },
    },
    skills,
    summary: {},
  }
}

const USAGE = [
  { name: 'page-solution-design', total: 7, claude: 7, codex: 0 },
  { name: 'viral-title', total: 4, claude: 1, codex: 3 },
  { name: 'readable-output', total: 2, claude: 2, codex: 0 },
  { name: 'baseplate-deck', total: 1, claude: 1, codex: 0 },
]

const RECORDS = [
  { invocationId: 'r1', skillName: 'page-solution-design', tool: 'claude', triggerType: 'claude_tool_use', triggeredAt: '2026-09-26T12:42:09.682Z', session: { relativePath: '-Users-me-Documents-trae-projects-skills/a.jsonl' } },
  { invocationId: 'r2', skillName: 'page-solution-design', tool: 'claude', triggerType: 'claude_tool_use', triggeredAt: '2026-09-20T12:21:20.706Z', session: { relativePath: '-Users-me-Documents-trae-projects-skills/b.jsonl' } },
]

let api

function makeApi({ snap = snapshot(), usage = USAGE, execute } = {}) {
  return {
    getSkillControlSnapshot: vi.fn(async () => ({ success: true, data: snap, error: null })),
    executeSkillCommand: vi.fn(execute || (async () => ({ success: true, data: {}, snapshot: snap, error: null }))),
    adoptExternalSkill: vi.fn(async () => ({ success: true })),
    aggregateSkillUsage: vi.fn(async () => ({ success: true, data: { skills: usage } })),
    listSkillRunSamples: vi.fn(async ({ skillName }) => ({ success: true, data: { records: RECORDS.filter((record) => record.skillName === skillName) } })),
    getTags: vi.fn(async () => []),
  }
}

async function renderPage(options) {
  skillUsageModule.resetSkillUsageCache?.()
  api = makeApi(options)
  window.electronAPI = api
  const Page = await loadPage()
  const view = render(<Page />)
  await screen.findByText('装载总览', { selector: '.np-li b' })
  // 次数到了分组才定：等统计返回、页面用上它（全是只读 Skill 时不统计）
  const skills = (options?.snap || snapshot()).skills
  if (skills.some((skill) => skill.managed || skill.origins?.some((origin) => origin.mutable))) {
    await waitFor(() => expect(api.aggregateSkillUsage).toHaveBeenCalled())
  }
  await act(async () => {})
  return view
}

/** 左栏一条；不在当前页签就依次点页签去找（v2.1.11 左栏改页签） */
const listItem = (name) => {
  const find = () => screen.queryAllByRole('option').find((item) => within(item).queryByText(name, { exact: true }))
  let hit = find()
  for (const tab of screen.queryAllByRole('tab')) {
    if (hit) break
    fireEvent.click(tab)
    hit = find()
  }
  return hit
}
const selectSkill = async (name) => {
  fireEvent.click(listItem(name))
  await screen.findByRole('heading', { name, level: 2 })
}
const detail = () => document.querySelector('.np-pane--detail')
// v2.1.11 左栏页签：页签文字（名字 + 条数）、选中的页签、列表里当前列出的名字（遇到只读小标题前为止 / 之后）
const tabTexts = () => screen.queryAllByRole('tab').map((tab) => tab.textContent)
const currentTab = () => screen.queryAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent
const bodyNames = (container, part = 'before') => {
  const out = { before: [], after: [] }
  let side = 'before'
  for (const node of container.querySelectorAll('.np-pane--list .np-pane-body > *')) {
    if (node.classList.contains('np-lg')) side = 'after'
    else if (node.getAttribute('role') === 'option') out[side].push(node.querySelector('b').textContent)
  }
  return out[part]
}
const toolRow = (label) => within(detail()).getAllByText(label, { exact: true }).map((node) => node.closest('.np-row')).find(Boolean)
const toastText = async (text) => waitFor(() => expect(document.body.textContent).toContain(text))

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-29T20:00:00+08:00'))
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
  // 次数有 5 分钟的模块级缓存，每个用例从头读
  skillUsageModule.resetSkillUsageCache?.()
})

afterEach(() => {
  cleanup()
  resetToastForTests()
  document.querySelectorAll('.confirm-dialog-host').forEach((node) => node.remove())
})

describe('外壳与列表', () => {
  // v2.1.11（Skills 要处理）起「外部」组、栏头与全部收进资产库下线，全局目录里资产库没有的进「要处理」（tests/skills/inbox/InboxPage.test.jsx）
  it('TC-014 NATIVE_SPLIT 新样式外壳、工具栏 Skills、没有旧按钮和数字格；左栏第一条装载总览选中；在用 / 没用两个页签，只读跟在没用末尾；右栏总览', async () => {
    const { container } = await renderPage()
    expect(container.querySelector('.page-shell--native')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy()
    for (const gone of ['管理标签', '配置', '这里只显示独立 Skill', '资产库\n81']) {
      expect(screen.queryByText(gone)).toBeNull()
    }
    expect(container.querySelector('.skill-control-summary, .skill-control-views, .tag-filter-chips')).toBeNull()
    expect(container.querySelector('.np-split .np-pane--list')).not.toBeNull()
    const first = screen.getAllByRole('option')[0]
    expect(first.textContent).toContain('装载总览')
    expect(first.getAttribute('aria-selected')).toBe('true')
    // v2.1.11 左栏页签（用户 10-03 定）：没有要处理时不出「要处理」，停在「在用」
    expect(tabTexts()).toEqual(['在用3', '没用4'])
    expect(currentTab()).toBe('在用3')
    fireEvent.click(screen.getByRole('tab', { name: /没用/ }))
    const groups = [...container.querySelectorAll('.np-pane--list .np-lg')].map((node) => node.textContent)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatch(/^只读 · 同步来的和系统自带的\s*2$/)
    expect(groups.some((title) => title.startsWith('外部'))).toBe(false)
    expect(within(detail()).getByRole('heading', { level: 2, name: '装载总览' })).toBeTruthy()
  })

  it('TC-015 GROUPING 在用按次数多到少；没在用里还在装载的排前；0 次不写；只读含同步和系统；插件带的不出现', async () => {
    const { container } = await renderPage()
    expect(bodyNames(container)).toEqual(['page-solution-design', 'viral-title', 'readable-output'])
    fireEvent.click(screen.getByRole('tab', { name: /没用/ }))
    const unused = bodyNames(container)
    expect(unused.slice(0, 3).sort()).toEqual(['logo-design', 'memory-init', 'weekly-report'])
    expect(unused[3]).toBe('aippt')
    expect(bodyNames(container, 'after')).toEqual(['pptx', 'imagegen'])
    expect(listItem('aippt').textContent).not.toMatch(/0\s*次/)
    expect(listItem('page-solution-design').textContent).toMatch(/7\s*次/)
    expect(screen.queryByText('dev-workflow:page-solution-design')).toBeNull()
  })
})

describe('右栏', () => {
  it('TC-016 OVERVIEW 两张工具卡与来源行；要处理：两份一行点了选中它', async () => {
    await renderPage()
    const pane = detail()
    expect(pane.textContent).toContain('Claude Code')
    expect(pane.textContent).toMatch(/15\s*个 Skill · 约 2\.5k tokens/)
    expect(pane.textContent).toMatch(/12\s*个 Skill · 约 1\.3k tokens/)
    for (const label of ['个人', 'claude.ai 同步', '系统自带', '在这页开关', '在 claude.ai 的设置里关', 'Codex 自带，关不了']) {
      expect(within(pane).getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(within(pane).getByText('要处理')).toBeTruthy()
    expect(within(pane).queryByRole('button', { name: '全部收进资产库' })).toBeNull()
    fireEvent.click(within(pane).getByText('Codex 里有两份，内容不一样'))
    await screen.findByRole('heading', { level: 2, name: 'logo-design' })
    expect(listItem('logo-design').getAttribute('aria-selected')).toBe('true')
  })

  it('TC-017 DETAIL 在用的 Skill：栏头、两个开关、隶属插件、调用记录、说明、位置两行完整路径、删除；没有从工具移除和同步', async () => {
    await renderPage()
    await selectSkill('page-solution-design')
    const pane = detail()
    expect(pane.textContent).toContain('个人 · 近 30 天 7 次')
    expect(within(toolRow('Claude Code')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(within(toolRow('Codex')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect(within(pane).getByText('隶属插件')).toBeTruthy())
    expect(within(pane).getByText('dev-workflow')).toBeTruthy()
    await waitFor(() => expect(pane.textContent).toContain('周六 20:42'))
    expect(pane.textContent).toContain('9月20日 20:21')
    expect(within(pane).getByText('和用户一起敲定一个前端页面的整页方案')).toBeTruthy()
    expect(within(pane).getByText(`${CENTRAL}/page-solution-design`)).toBeTruthy()
    expect(within(pane).getByText('~/.claude/skills/page-solution-design')).toBeTruthy()
    expect(within(pane).getByRole('button', { name: '删除' })).toBeTruthy()
    for (const gone of ['从 Claude Code 移除', '移除', '同步']) expect(within(pane).queryByRole('button', { name: gone })).toBeNull()
  })

  it('TC-019 READONLY_DETAIL 只读 Skill：没有开关，装载中 + 去哪关；没有删除', async () => {
    await renderPage()
    await selectSkill('pptx')
    const pane = detail()
    expect(pane.textContent).toContain('claude.ai 同步 · 只读')
    expect(within(pane).queryAllByRole('switch')).toHaveLength(0)
    expect(pane.textContent).toContain('装载中')
    expect(pane.textContent).toContain('在 claude.ai 的设置里关')
    expect(within(pane).queryByRole('button', { name: '删除' })).toBeNull()
  })

  it('TC-020 DUPLICATE_UI 两份：列表橙标签、启用卡说明、位置 Codex 两行', async () => {
    await renderPage()
    expect(listItem('logo-design').querySelector('.np-tag--orange').textContent).toBe('两份')
    await selectSkill('logo-design')
    const pane = detail()
    expect(pane.textContent).toContain('Codex 里有两份')
    expect(pane.textContent).toContain('一份来自资产库，一份是旧目录里的副本，内容不一样，两份都在装载')
    expect(within(pane).getByText('~/.agents/skills/logo-design')).toBeTruthy()
    expect(within(pane).getByText('~/.codex/skills/logo-design')).toBeTruthy()
  })

  it('TC-021 MISSING_FOLDER 文件夹不在了：列表橙标签找不到；位置红字', async () => {
    await renderPage()
    expect(listItem('weekly-report').querySelector('.np-tag--orange').textContent).toBe('找不到')
    await selectSkill('weekly-report')
    expect(within(detail()).getByText('找不到这个文件夹')).toBeTruthy()
  })
})

describe('动作', () => {
  it('TC-022 TOGGLE_OK 写入中只禁用这一个开关；成功 Toast，状态点与总览数字随新快照变', async () => {
    let finish
    const after = snapshot({
      skills: baseSkills().map((skill) => (skill.name === 'page-solution-design' ? { ...skill, tools: { ...skill.tools, codex: on() } } : skill)),
      tools: {
        'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, load: { personal: 7, synced: 8, total: 15, tokens: 2500 } },
        codex: { id: 'codex', name: 'Codex', available: true, load: { personal: 7, system: 6, total: 13, tokens: 1400 } },
      },
    })
    await renderPage({ execute: () => new Promise((resolve) => { finish = () => resolve({ success: true, data: {}, snapshot: after, error: null }) }) })
    await selectSkill('page-solution-design')
    fireEvent.click(within(toolRow('Codex')).getByRole('switch'))
    await waitFor(() => expect(within(toolRow('Codex')).getByRole('switch').getAttribute('aria-disabled')).toBe('true'))
    expect(within(toolRow('Claude Code')).getByRole('switch').getAttribute('aria-disabled')).toBe('false')
    expect(api.executeSkillCommand).toHaveBeenCalledWith(expect.objectContaining({ skillName: 'page-solution-design', toolId: 'codex', action: 'enable' }))
    await act(async () => finish())
    await toastText('已在 Codex 启用 page-solution-design')
    expect(within(toolRow('Codex')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(listItem('装载总览').textContent).toMatch(/Codex\s*13/)
  })

  it('TC-023 TOGGLE_FAIL 失败退回原值 + Toast；没权限另一句', async () => {
    await renderPage({ execute: async () => ({ success: false, error: 'NOT_EFFECTIVE', snapshot: null }) })
    await selectSkill('page-solution-design')
    fireEvent.click(within(toolRow('Codex')).getByRole('switch'))
    await toastText('操作失败，已保留原状态')
    expect(within(toolRow('Codex')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    cleanup()
    resetToastForTests()
    await renderPage({ execute: async () => ({ success: false, error: 'PERMISSION_DENIED', snapshot: null }) })
    await selectSkill('page-solution-design')
    fireEvent.click(within(toolRow('Claude Code')).getByRole('switch'))
    await toastText('操作失败，请检查工具目录权限')
  })

  it('TC-025 DELETE_FLOW 确认框；取消不调；确认后删除中 → 成功回总览；失败 Toast', async () => {
    const afterDelete = snapshot({ skills: baseSkills().filter((skill) => skill.name !== 'page-solution-design') })
    let finish
    await renderPage({ execute: () => new Promise((resolve) => { finish = () => resolve({ success: true, data: {}, snapshot: afterDelete, error: null }) }) })
    await selectSkill('page-solution-design')
    fireEvent.click(within(detail()).getByRole('button', { name: '删除' }))
    await screen.findByText('删除 page-solution-design？')
    expect(document.body.textContent).toContain('资产库里的和 Claude Code 里的都会删掉，不能撤销。')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText('删除 page-solution-design？')).toBeNull())
    expect(api.executeSkillCommand).not.toHaveBeenCalled()

    fireEvent.click(within(detail()).getByRole('button', { name: '删除' }))
    await screen.findByText('删除 page-solution-design？')
    const dialog = document.querySelector('.confirm-dialog-host')
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await within(dialog).findByRole('button', { name: '删除中…' })
    expect(api.executeSkillCommand).toHaveBeenCalledWith(expect.objectContaining({ skillName: 'page-solution-design', action: 'delete' }))
    await act(async () => finish())
    await toastText('已删除 page-solution-design')
    expect(within(detail()).getByRole('heading', { level: 2, name: '装载总览' })).toBeTruthy()
    expect(screen.getAllByRole('option').some((item) => item.textContent.includes('page-solution-design'))).toBe(false)

    cleanup(); resetToastForTests()
    await renderPage({ execute: async () => ({ success: false, error: 'PERMISSION_DENIED', snapshot: null }) })
    await selectSkill('page-solution-design')
    fireEvent.click(within(detail()).getByRole('button', { name: '删除' }))
    await screen.findByText('删除 page-solution-design？')
    fireEvent.click(within(document.querySelector('.confirm-dialog-host')).getByRole('button', { name: '删除' }))
    await toastText('删除失败，什么都没改')
  })
})

describe('状态', () => {
  it('TC-026 LOAD_STATES 首次读取骨架；整体失败左栏整块 + 重试，右栏一句话；重试再读', async () => {
    api = makeApi()
    api.getSkillControlSnapshot = vi.fn(() => new Promise(() => {}))
    window.electronAPI = api
    const Page = await loadPage()
    const first = render(<Page />)
    await waitFor(() => expect(first.container.querySelectorAll('.np-pane--list .np-sk').length).toBeGreaterThan(0))
    expect(first.container.querySelector('.np-pane--detail .np-card')).not.toBeNull()
    cleanup()

    api = makeApi()
    api.getSkillControlSnapshot = vi.fn(async () => ({ success: false, data: null, error: 'READ_FAILED' }))
    window.electronAPI = api
    render(<Page />)
    await screen.findByText('Skill 状态读取失败')
    expect(screen.getByText('没有修改任何目录')).toBeTruthy()
    expect(within(detail()).getByText('选一个 Skill 查看')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(api.getSkillControlSnapshot).toHaveBeenCalledTimes(2))
  })

  it('TC-027 CODEX_STATES Codex 读不出 / 没找到 Codex', async () => {
    const unreadable = snapshot({
      errors: [{ toolId: 'codex', origin: 'config', code: 'CODEX_API_FAILED' }],
      skills: baseSkills().map((skill) => ({ ...skill, tools: { ...skill.tools, codex: { enabled: null, state: 'unavailable', mutable: false } } })),
      tools: {
        'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, load: { personal: 7, synced: 8, total: 15, tokens: 2500 } },
        codex: { id: 'codex', name: 'Codex', available: true, load: null },
      },
    })
    await renderPage({ snap: unreadable })
    expect(detail().textContent).toContain('Codex 状态无法读取，其他数据仍可使用')
    expect(within(detail()).getAllByRole('button', { name: '重试' }).length).toBeGreaterThan(0)
    await selectSkill('viral-title')
    expect(within(toolRow('Codex')).getByRole('switch').getAttribute('aria-disabled')).toBe('true')

    cleanup()
    const missing = snapshot({
      errors: [{ toolId: 'codex', origin: 'tool', code: 'CODEX_NOT_FOUND' }],
      skills: unreadable.skills,
      tools: { ...unreadable.tools, codex: { id: 'codex', name: 'Codex', available: false, load: null } },
    })
    await renderPage({ snap: missing })
    expect(detail().textContent).toContain('没找到 Codex')
    expect(listItem('viral-title').textContent).not.toContain('Codex')
    await selectSkill('viral-title')
    const row = toolRow('Codex')
    expect(within(row).getByRole('switch').getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('没找到 Codex')
  })

  it('TC-048 CLAUDE_UNREADABLE Claude 读不出：卡片「—」+ 一句 + 重试；Claude 开关全部禁用；Codex 照常', async () => {
    const snap = snapshot({
      errors: [{ toolId: 'claude-code', origin: 'settings', code: 'INVALID_JSON' }],
      skills: baseSkills().map((skill) => ({ ...skill, tools: { ...skill.tools, 'claude-code': { enabled: null, state: 'unavailable', mutable: false } } })),
      tools: {
        'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, load: null },
        codex: { id: 'codex', name: 'Codex', available: true, load: { personal: 6, system: 6, total: 12, tokens: 1300 } },
      },
    })
    await renderPage({ snap })
    expect(detail().textContent).toContain('Claude Code 状态无法读取，其他数据仍可使用')
    expect(detail().textContent).toMatch(/12\s*个 Skill/)
    await selectSkill('viral-title')
    expect(within(toolRow('Claude Code')).getByRole('switch').getAttribute('aria-disabled')).toBe('true')
    expect(within(toolRow('Codex')).getByRole('switch').getAttribute('aria-disabled')).toBe('false')
  })

  it('TC-028 EMPTY_LIBRARY 资产库为空：总览 + 一句 + 只读组', async () => {
    const onlyReadOnly = baseSkills().filter((skill) => ['pptx', 'imagegen'].includes(skill.name))
    const { container } = await renderPage({ snap: snapshot({ skills: onlyReadOnly }), usage: [] })
    expect(screen.getByText('资产库还没有 Skill')).toBeTruthy()
    const groups = [...container.querySelectorAll('.np-pane--list .np-lg')].map((node) => node.textContent)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatch(/^只读/)

  })

  it('TC-029 SEARCH 过滤名字和用途、命中字橙底、三组一起列、总览常驻、页签变淡写搜到几个、右栏不变；无结果一句 + 清除搜索', async () => {
    const { container } = await renderPage()
    await selectSkill('page-solution-design')
    const input = screen.getByPlaceholderText('搜索名称和用途')
    fireEvent.change(input, { target: { value: 'PPT' } })
    // v2.1.11：装载总览常驻栏头（用户 10-03），搜索时页签变淡、数字换成搜到几个
    await waitFor(() => expect(screen.getAllByRole('tab').every((tab) => tab.disabled)).toBe(true))
    expect(screen.getAllByRole('option')[0].textContent).toContain('装载总览')
    const shown = bodyNames(container).concat(bodyNames(container, 'after'))
    expect(shown).toEqual(expect.arrayContaining(['aippt']))
    expect(shown).not.toContain('viral-title')
    expect(container.querySelector('.np-pane--list .np-hit')).not.toBeNull()
    expect(within(detail()).getByRole('heading', { level: 2, name: 'page-solution-design' })).toBeTruthy()

    fireEvent.change(input, { target: { value: 'zzz-没有' } })
    await screen.findByText('没有符合条件的 Skill')
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    await waitFor(() => expect(input.value).toBe(''))
    expect(screen.getAllByRole('option')[0].textContent).toContain('装载总览')
    expect(screen.getAllByRole('tab').some((tab) => tab.disabled)).toBe(false)
  })

  it('TC-030 KEYBOARD ↑↓ 换选中；⌘F 聚焦搜索；Esc 清空搜索', async () => {
    await renderPage()
    const first = screen.getAllByRole('option')[0]
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    await screen.findByRole('heading', { level: 2, name: 'page-solution-design' })
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' })
    await screen.findByRole('heading', { level: 2, name: 'viral-title' })
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    await screen.findByRole('heading', { level: 2, name: 'page-solution-design' })
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    const input = screen.getByPlaceholderText('搜索名称和用途')
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'viral' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('TC-031 REFRESH 读取中旧结果留着；成功不弹、时间更新；失败顶上红字 + 原位重试', async () => {
    await renderPage()
    let resolveNext
    api.getSkillControlSnapshot.mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve }))
    fireEvent.click(within(detail()).getByRole('button', { name: '重新读取' }))
    await within(detail()).findByRole('button', { name: '读取中…' })
    expect(detail().textContent).toMatch(/15\s*个 Skill/)
    await act(async () => resolveNext({ success: true, data: { ...snapshot(), generatedAt: '2026-09-29T10:47:00.000Z' } }))
    await waitFor(() => expect(within(detail()).getByRole('button', { name: '重新读取' })).toBeTruthy())
    expect(document.querySelector('.toast')).toBeNull()

    api.getSkillControlSnapshot.mockImplementationOnce(async () => ({ success: false, data: null, error: 'READ_FAILED' }))
    fireEvent.click(within(detail()).getByRole('button', { name: '重新读取' }))
    await within(detail()).findByText('读取失败，下面是上次读到的结果')
    expect(within(detail()).getByRole('button', { name: '重试' })).toBeTruthy()
    expect(detail().textContent).toMatch(/15\s*个 Skill/)
  })

  it('TC-032 USAGE_NAMES 统计名单含外部 Skill、不含插件带的', async () => {
    await renderPage()
    await waitFor(() => expect(api.aggregateSkillUsage).toHaveBeenCalled())
    const names = api.aggregateSkillUsage.mock.calls.at(-1)[0].skillNames
    expect(names).toEqual(expect.arrayContaining(['page-solution-design', 'baseplate-deck', 'slides-pec2026']))
    expect(names.some((name) => name.includes(':'))).toBe(false)
  })

  it('TC-041 USAGE_REFRESH 已有次数时再读：旧次数留着不闪骨架，新结果就地换', async () => {
    await renderPage()
    await waitFor(() => expect(listItem('page-solution-design').textContent).toMatch(/7\s*次/))
    let resolveUsage
    api.aggregateSkillUsage.mockImplementationOnce(() => new Promise((resolve) => { resolveUsage = resolve }))
    fireEvent.click(within(detail()).getByRole('button', { name: '重新读取' }))
    await waitFor(() => expect(api.aggregateSkillUsage.mock.calls.length).toBeGreaterThan(1))
    expect(listItem('page-solution-design').textContent).toMatch(/7\s*次/)
    expect(listItem('page-solution-design').querySelector('.np-sk')).toBeNull()
    await act(async () => resolveUsage({ success: true, data: { skills: [{ name: 'page-solution-design', total: 8, claude: 8, codex: 0 }] } }))
    await waitFor(() => expect(listItem('page-solution-design').textContent).toMatch(/8\s*次/))
  })

  it('TC-042 USAGE_ERROR 次数读不出：写 —；详情一句 + 重试；资产库两组合成一组（只剩它时不出页签），只读照常', async () => {
    api = makeApi()
    api.aggregateSkillUsage = vi.fn(async () => ({ success: false, error: 'READ_FAILED' }))
    window.electronAPI = api
    const Page = await loadPage()
    const { container } = render(<Page />)
    await screen.findByText('装载总览', { selector: '.np-li b' })
    // v2.1.11 页签：读不出次数时是「要处理 | 资产库」；这里没有要处理，只剩资产库一组，页签整排不出
    await waitFor(() => {
      const groups = [...container.querySelectorAll('.np-pane--list .np-lg')].map((node) => node.textContent)
      expect(groups.map((text) => text.replace(/\s*\d+$/, ''))).toEqual(['只读 · 同步来的和系统自带的'])
    })
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getAllByRole('option').length).toBe(1 + baseSkills().length - 2)
    await selectSkill('page-solution-design')
    expect(detail().textContent).toContain('个人 · 近 30 天 — 次')
    expect(within(detail()).getByText('调用数据读取失败')).toBeTruthy()
    fireEvent.click(within(detail()).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(api.aggregateSkillUsage).toHaveBeenCalledTimes(2))
  })

  it('TC-043 SYNCED_ERROR_UI 同步目录读不出：只这一行写 — + 一句', async () => {
    const snap = snapshot({
      errors: [{ toolId: 'claude-code', origin: 'synced', code: 'PERMISSION_DENIED' }],
      tools: {
        'claude-code': { id: 'claude-code', name: 'Claude Code', available: true, load: { personal: 7, synced: null, total: 7, tokens: 700 } },
        codex: { id: 'codex', name: 'Codex', available: true, load: { personal: 6, system: 6, total: 12, tokens: 1300 } },
      },
    })
    await renderPage({ snap })
    const row = within(detail()).getByText('claude.ai 同步').closest('.np-row')
    expect(row.textContent).toContain('—')
    expect(detail().textContent).toContain('claude.ai 同步的 Skill 读不出')
    const personal = within(detail()).getAllByText('个人')[0].closest('.np-row')
    expect(personal.textContent).toContain('7')
  })

  it('TC-044 STATE_UNKNOWN_UI 重读成功按实际；重读仍失败标为读不出、开关禁用、可重试（Claude、Codex 各一次）', async () => {
    const actual = snapshot({ skills: baseSkills().map((skill) => (skill.name === 'page-solution-design' ? { ...skill, tools: { ...skill.tools, codex: on() } } : skill)) })
    await renderPage({ execute: async () => ({ success: false, error: 'STATE_UNKNOWN', snapshot: actual }) })
    await selectSkill('page-solution-design')
    fireEvent.click(within(toolRow('Codex')).getByRole('switch'))
    await toastText('操作失败，已按实际状态显示')
    expect(within(toolRow('Codex')).getByRole('switch').getAttribute('aria-checked')).toBe('true')

    for (const [toolId, label, code] of [['codex', 'Codex', 'CODEX_API_FAILED'], ['claude-code', 'Claude Code', 'READ_FAILED']]) {
      cleanup(); resetToastForTests()
      const unreadable = snapshot({
        errors: [{ toolId, origin: 'config', code }],
        skills: baseSkills().map((skill) => ({ ...skill, tools: { ...skill.tools, [toolId]: { enabled: null, state: 'unavailable', mutable: false } } })),
      })
      await renderPage({ execute: async () => ({ success: false, error: 'STATE_UNKNOWN', snapshot: null }) })
      api.getSkillControlSnapshot.mockImplementation(async () => ({ success: true, data: unreadable }))
      await selectSkill('viral-title')
      fireEvent.click(within(toolRow(label)).getByRole('switch'))
      await toastText('操作失败，当前状态读不出')
      await waitFor(() => expect(within(toolRow(label)).getByRole('switch').getAttribute('aria-disabled')).toBe('true'))
      fireEvent.click(listItem('装载总览'))
      await screen.findByText(`${label} 状态无法读取，其他数据仍可使用`)
      const before = api.getSkillControlSnapshot.mock.calls.length
      fireEvent.click(within(detail()).getAllByRole('button', { name: '重试' })[0])
      await waitFor(() => expect(api.getSkillControlSnapshot.mock.calls.length).toBe(before + 1))
    }
  })

  it('TC-040 NO_LEGACY_CALLS 加载与各种操作都不调用标签、推送目标与旧删除接口', async () => {
    await renderPage()
    await selectSkill('page-solution-design')
    fireEvent.click(within(toolRow('Codex')).getByRole('switch'))
    await waitFor(() => expect(api.executeSkillCommand).toHaveBeenCalled())
    // 旧的标签 / 推送目标 / 资产库存储已随旧引擎删除（v2.1.9），页面也不调旧的标签接口
    expect(fs.existsSync(path.join(root, 'src/store/data.js'))).toBe(false)
    expect(api.getTags).not.toHaveBeenCalled()
  })

  it('TC-033 STYLE_WIRING native.css 状态行与状态点；页面样式不声明颜色 / 字体变量；无 emoji；npm test 接线', async () => {
    const native = fs.readFileSync(path.join(root, 'src/styles/native.css'), 'utf8')
    expect(native).toMatch(/\.np-li > \.m\s*\{/)
    expect(native).toMatch(/\.np-li \.dot/)
    const pageCss = fs.readFileSync(path.join(root, 'src/pages/skills/skills.css'), 'utf8')
    expect(pageCss).not.toMatch(/--[a-z0-9-]+\s*:/i)
    // 数字用 var(--num) 可以，不许写具体字体
    expect(pageCss).not.toMatch(/font-family:(?!\s*var\()/)
    expect(pageCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    const { container } = await renderPage()
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u)
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['test:skills']).toMatch(/tests\/skills/)
    expect(pkg.scripts.test).toContain('npm run test:skills')
    // 三个旧测试已在合并后删除：文件不在、脚本也不再指着它们
    const all = Object.values(pkg.scripts).join('\n')
    for (const retired of ['tests/v2/ManagePage.skillControl.test.jsx', 'tests/v21/skillExplainability.test.jsx', 'tests/safety/codexSkillConfig.test.js']) {
      expect(fs.existsSync(path.join(root, retired))).toBe(false)
      expect(all).not.toContain(retired)
    }
  })
})

describe('守卫', () => {
  it('TC-047 旧快照响应晚到不覆盖操作后的新状态', async () => {
    const stale = snapshot({ skills: baseSkills().map((skill) => (skill.name === 'viral-title' ? { ...skill, tools: { ...skill.tools, codex: on() } } : skill)) })
    const fresh = snapshot({ skills: baseSkills().map((skill) => (skill.name === 'viral-title' ? { ...skill, tools: { ...skill.tools, codex: off() } } : skill)) })
    let resolveStale
    window.electronAPI = {
      getSkillControlSnapshot: vi.fn()
        .mockImplementationOnce(async () => ({ success: true, data: stale }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve })),
      executeSkillCommand: vi.fn(async () => ({ success: true, data: {}, snapshot: fresh, error: null })),
    }
    const { result } = renderHook(() => useSkillControl(0))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => { result.current.refresh({ silent: true }) })
    await act(async () => { await result.current.setActivation({ skillName: 'viral-title', toolId: 'codex', enabled: false }) })
    const codexState = () => result.current.snapshot.skills.find((skill) => skill.name === 'viral-title').tools.codex.enabled
    expect(codexState()).toBe(false)
    await act(async () => resolveStale({ success: true, data: stale }))
    expect(codexState()).toBe(false)
  })
})
