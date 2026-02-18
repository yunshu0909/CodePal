/**
 * V0.4 历史回归集成测试（应用入口）
 *
 * 负责：
 * - 验证 V0.1~V0.2 的启动分流逻辑
 * - 验证 V0.4 的首次进入推送目标初始化触发链路
 *
 * @module auto-test/v04/integration/app-entry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App.jsx'
import { dataStore } from '@/store/data.js'

vi.mock('@/store/data.js', () => ({
  dataStore: {
    hasCentralSkills: vi.fn(),
    isFirstEntryAfterImport: vi.fn(),
    getLastImportedToolIds: vi.fn(),
    initPushTargetsAfterImport: vi.fn(),
    setFirstEntryAfterImport: vi.fn(),
    autoIncrementalRefresh: vi.fn(),
  },
}))

vi.mock('@/components/SkillManagerModule.jsx', () => ({
  default: ({ initialPage, onAfterImport }) => (
    <div data-testid="skills-module">
      <div>技能管理模块</div>
      <div data-testid="skills-initial-page">{initialPage}</div>
      {initialPage === 'import' && (
        <button onClick={onAfterImport}>完成导入</button>
      )}
    </div>
  ),
}))

vi.mock('@/pages/ImportPage.jsx', () => ({
  default: () => <div data-testid="import-page">导入页</div>,
}))

async function waitUntil(assertion, timeoutMs = 1200) {
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

describe('App 历史回归入口流 (V0.4)', () => {
  let container
  let root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    vi.clearAllMocks()
    dataStore.hasCentralSkills.mockResolvedValue(true)
    dataStore.isFirstEntryAfterImport.mockResolvedValue(false)
    dataStore.getLastImportedToolIds.mockReturnValue(['claude-code'])
    dataStore.initPushTargetsAfterImport.mockResolvedValue({ success: true })
    dataStore.setFirstEntryAfterImport.mockResolvedValue({ success: true })
    dataStore.autoIncrementalRefresh.mockResolvedValue({
      success: true,
      added: 0,
      skipped: 0,
      scannedSources: 0,
      errors: null,
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('IT-01: 中央仓库有数据时进入 workbench', async () => {
    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('技能管理模块')
    })
  })

  it('IT-02: 中央仓库无数据时进入导入页，导入完成后切换到 workbench', async () => {
    dataStore.hasCentralSkills.mockResolvedValue(false)

    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(container.querySelector('[data-testid="skills-initial-page"]')?.textContent).toBe('import')
    })

    const importButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('完成导入')
    )

    await act(async () => {
      importButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitUntil(() => {
      expect(container.querySelector('[data-testid="skills-initial-page"]')?.textContent).toBe('manage')
    })
  })

  it('IT-03: 导入后首次进入时初始化推送目标并清理标记', async () => {
    dataStore.isFirstEntryAfterImport.mockResolvedValue(true)
    dataStore.getLastImportedToolIds.mockReturnValue(['custom-1'])

    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(dataStore.initPushTargetsAfterImport).toHaveBeenCalledWith(['custom-1'])
    })
    expect(dataStore.setFirstEntryAfterImport).toHaveBeenCalledWith(false)
  })

  it('IT-04: 进入 workbench 后应触发自动增量刷新', async () => {
    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(dataStore.autoIncrementalRefresh).toHaveBeenCalledTimes(1)
    })
  })
})
