/**
 * V0.4 管理页交互集成测试
 *
 * 负责：
 * - 覆盖搜索过滤、全选与批量栏显示逻辑
 * - 覆盖无推送目标保护、单条推送/停用切换
 * - 验证前端交互与数据层调用契约
 *
 * @module 自动化测试/V0.4/tests/integration/ManagePage.v04.interaction.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import ManagePage from '@/pages/ManagePage.jsx'
import { dataStore } from '@/store/data.js'

vi.mock('@/store/data.js', () => ({
  toolDefinitions: [
    { id: 'claude-code', name: 'Claude Code', path: '~/.claude/skills/' },
    { id: 'codex', name: 'CodeX', path: '~/.codex/skills/' },
  ],
  dataStore: {
    getPushTargets: vi.fn(),
    getCentralSkills: vi.fn(),
    isPushed: vi.fn(),
    pushSkills: vi.fn(),
    unpushSkills: vi.fn(),
    // ManagePage 现在通过 useTagManagement 加载标签数据，补齐相关方法避免 mock 缺失
    getTags: vi.fn(),
    getSkillTags: vi.fn(),
    setSkillTag: vi.fn(),
    removeSkillTag: vi.fn(),
    createTag: vi.fn(),
    renameTag: vi.fn(),
    deleteTag: vi.fn(),
  },
}))

/**
 * 刷新微任务队列
 * @returns {Promise<void>}
 */
async function flushMicrotasks() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
    }
  })
}

describe('ManagePage V0.4 Interaction (Integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dataStore.getPushTargets.mockResolvedValue(['claude-code', 'codex'])
    dataStore.getCentralSkills.mockResolvedValue([
      { id: 'alpha', name: 'alpha', displayName: 'Alpha Skill', desc: 'git commit helper' },
      { id: 'beta', name: 'beta', displayName: 'Beta Skill', desc: 'review workflow' },
    ])
    dataStore.isPushed.mockImplementation(async (_toolId, skillName) => skillName === 'beta')
    dataStore.pushSkills.mockResolvedValue({ success: true, pushedCount: 1, errors: null })
    dataStore.unpushSkills.mockResolvedValue({ success: true, unpushedCount: 1, errors: null })
    dataStore.getTags.mockResolvedValue([])
    dataStore.getSkillTags.mockResolvedValue({})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('IT-MANAGE-01: 搜索应按名称/描述过滤列表', async () => {
    render(<ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} />)
    await flushMicrotasks()

    const searchInput = screen.getByPlaceholderText('搜索 skill...')
    fireEvent.change(searchInput, { target: { value: 'commit' } })
    await flushMicrotasks()

    expect(screen.getByText('Alpha Skill')).toBeTruthy()
    expect(screen.queryByText('Beta Skill')).toBeNull()
  })

  it('IT-MANAGE-02: 全选应联动批量栏显示与选中数量', async () => {
    render(<ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} />)
    await flushMicrotasks()

    fireEvent.click(screen.getByTitle('全选/取消全选'))
    await flushMicrotasks()

    expect(screen.getByText(/已选/)).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('IT-MANAGE-03: 无推送目标时批量推送应提示并阻止调用', async () => {
    dataStore.getPushTargets.mockResolvedValue([])

    render(<ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} />)
    await flushMicrotasks()

    fireEvent.click(screen.getByText('Alpha Skill'))
    await flushMicrotasks()
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    await flushMicrotasks()

    expect(screen.getByText('未配置推送目标，请先点击右上角”配置”')).toBeTruthy()
    expect(dataStore.pushSkills).toHaveBeenCalledTimes(0)
  })

  it('IT-MANAGE-04: 单条未推送状态点击后应推送到所有启用目标', async () => {
    render(<ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} />)
    await flushMicrotasks()

    const alphaCard = screen.getByText('Alpha Skill').closest('.skill-card-v4')
    const statusTag = alphaCard.querySelector('.status-tag.not-pushed')
    fireEvent.click(statusTag)
    await flushMicrotasks()

    expect(dataStore.pushSkills).toHaveBeenCalledWith('claude-code', ['alpha'])
    expect(dataStore.pushSkills).toHaveBeenCalledWith('codex', ['alpha'])
  })

  it('IT-MANAGE-05: 单条已推送状态点击后应从所有启用目标停用', async () => {
    render(<ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} />)
    await flushMicrotasks()

    const betaCard = screen.getByText('Beta Skill').closest('.skill-card-v4')
    const statusTag = betaCard.querySelector('.status-tag.pushed')
    fireEvent.click(statusTag)
    await flushMicrotasks()

    expect(dataStore.unpushSkills).toHaveBeenCalledWith('claude-code', ['beta'])
    expect(dataStore.unpushSkills).toHaveBeenCalledWith('codex', ['beta'])
  })

  it('IT-MANAGE-06: 搜索无结果时应展示空结果提示', async () => {
    render(<ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} />)
    await flushMicrotasks()

    fireEvent.change(screen.getByPlaceholderText('搜索 skill...'), { target: { value: 'not-exist' } })
    await flushMicrotasks()

    expect(screen.getByText('没有找到匹配的 skill')).toBeTruthy()
  })

  it('IT-MANAGE-07: 自动刷新后应保持已有顺序并将新增项追加到末尾', async () => {
    dataStore.getCentralSkills
      .mockResolvedValueOnce([
        { id: 'alpha', name: 'alpha', displayName: 'Alpha Skill', desc: 'git commit helper' },
        { id: 'beta', name: 'beta', displayName: 'Beta Skill', desc: 'review workflow' },
      ])
      .mockResolvedValueOnce([
        { id: 'gamma', name: 'gamma', displayName: 'Gamma Skill', desc: 'new incoming skill' },
        { id: 'alpha', name: 'alpha', displayName: 'Alpha Skill', desc: 'git commit helper' },
        { id: 'beta', name: 'beta', displayName: 'Beta Skill', desc: 'review workflow' },
      ])

    const { container, rerender } = render(
      <ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} refreshSignal={0} />
    )
    await flushMicrotasks()

    const initialOrder = Array.from(container.querySelectorAll('.skill-name')).map((node) => node.textContent)
    expect(initialOrder).toEqual(['Alpha Skill', 'Beta Skill'])

    rerender(<ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} refreshSignal={1} />)
    await flushMicrotasks()

    const refreshedOrder = Array.from(container.querySelectorAll('.skill-name')).map((node) => node.textContent)
    expect(refreshedOrder).toEqual(['Alpha Skill', 'Beta Skill', 'Gamma Skill'])
  })
})
