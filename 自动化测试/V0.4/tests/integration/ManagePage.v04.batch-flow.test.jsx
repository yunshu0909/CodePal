/**
 * V0.4 历史回归集成测试（管理页批量流）
 *
 * 负责：
 * - 验证混合选中时批量推送仅处理未推送项
 * - 验证混合选中时批量停用仅处理已推送项
 * - 验证配置入口回调可触发
 *
 * @module auto-test/v04/integration/manage-batch-flow
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
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

async function waitUntil(assertion, timeoutMs = 1400) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      assertion()
      return
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  assertion()
}

function findButtonByText(container, text) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === text)
}

function findSkillCard(container, skillName) {
  return [...container.querySelectorAll('.skill-card-v4')].find((card) => card.textContent.includes(skillName))
}

describe('ManagePage 历史回归批量流 (V0.4)', () => {
  let container
  let root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    vi.clearAllMocks()
    dataStore.getPushTargets.mockResolvedValue(['claude-code', 'codex'])
    dataStore.getCentralSkills.mockResolvedValue([
      { id: 'alpha', name: 'alpha', displayName: 'alpha', desc: 'alpha-desc' },
      { id: 'beta', name: 'beta', displayName: 'beta', desc: 'beta-desc' },
    ])
    dataStore.isPushed.mockImplementation(async (_toolId, skillName) => skillName === 'beta')
    dataStore.pushSkills.mockResolvedValue({ success: true, pushedCount: 1, errors: null })
    dataStore.unpushSkills.mockResolvedValue({ success: true, unpushedCount: 1, errors: null })
    dataStore.getTags.mockResolvedValue([])
    dataStore.getSkillTags.mockResolvedValue({})
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('IT-04: 批量推送仅处理未推送项', async () => {
    await act(async () => {
      root.render(<ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} />)
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('Skill (2)')
    })

    const alphaCard = findSkillCard(container, 'alpha')
    const betaCard = findSkillCard(container, 'beta')

    await act(async () => {
      alphaCard.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      betaCard.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const pushButton = findButtonByText(container, '推送')

    await act(async () => {
      pushButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitUntil(() => {
      expect(dataStore.pushSkills).toHaveBeenCalledTimes(2)
    })
    expect(dataStore.pushSkills).toHaveBeenNthCalledWith(1, 'claude-code', ['alpha'])
    expect(dataStore.pushSkills).toHaveBeenNthCalledWith(2, 'codex', ['alpha'])
  })

  it('IT-05: 批量停用仅处理已推送项', async () => {
    await act(async () => {
      root.render(<ManagePage onNavigateToConfig={vi.fn()} onReimport={vi.fn()} />)
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('Skill (2)')
    })

    const alphaCard = findSkillCard(container, 'alpha')
    const betaCard = findSkillCard(container, 'beta')

    await act(async () => {
      alphaCard.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      betaCard.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const deactivateButton = findButtonByText(container, '停用')

    await act(async () => {
      deactivateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitUntil(() => {
      expect(dataStore.unpushSkills).toHaveBeenCalledTimes(2)
    })
    expect(dataStore.unpushSkills).toHaveBeenNthCalledWith(1, 'claude-code', ['beta'])
    expect(dataStore.unpushSkills).toHaveBeenNthCalledWith(2, 'codex', ['beta'])
  })

  it('IT-06: 点击配置按钮触发导航回调', async () => {
    const onNavigateToConfig = vi.fn()

    await act(async () => {
      root.render(<ManagePage onNavigateToConfig={onNavigateToConfig} onReimport={vi.fn()} />)
    })

    await waitUntil(() => {
      // 页面标题由历史的 "Skill Manager" 改为当前的 "Skills 管理"
      expect(container.textContent).toContain('Skills 管理')
    })

    const configButton = findButtonByText(container, '配置')
    await act(async () => {
      configButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onNavigateToConfig).toHaveBeenCalledTimes(1)
  })
})
