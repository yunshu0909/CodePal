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
    // App 进入工作台后会触发一次自动增量刷新，补齐以避免运行时缺方法
    autoIncrementalRefresh: vi.fn(),
  },
}))

// SkillManagerModule 现在内部托管 manage/import 子页面路由：
// App 仅通过 initialPage 决定初始子页，并在导入完成时收到 onAfterImport 回调。
// mock 据此还原当前真实行为：import 初始页渲染“导入页”并提供“完成导入”入口。
vi.mock('@/components/SkillManagerModule.jsx', () => ({
  default: ({ initialPage, onAfterImport }) => (
    <div data-testid="skills-module">
      {initialPage === 'import' ? (
        <>
          <div data-testid="import-page">导入页</div>
          <button onClick={onAfterImport}>完成导入</button>
        </>
      ) : (
        <div>技能管理模块</div>
      )}
    </div>
  ),
}))

async function waitUntil(assertion, timeoutMs = 1000) {
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

describe('App Workbench Flow (V0.5)', () => {
  let container
  let root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    // App 现在默认进入 permission 模块，并从 localStorage 恢复上次模块。
    // 这些用例验证 skills 模块的启动分流，渲染前先钉到 skills 模块。
    localStorage.setItem('codepal-active-module', 'skills')

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
    localStorage.clear()
  })

  it('有中央仓库数据时默认进入 workbench', async () => {
    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('技能管理模块')
    })
    expect(container.textContent).toContain('技能管理')
    expect(container.textContent).toContain('用量监测')
  })

  it('无中央仓库数据时进入导入页', async () => {
    dataStore.hasCentralSkills.mockResolvedValue(false)

    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('导入页')
    })
  })

  it('初始化检查异常时回退到导入页', async () => {
    dataStore.hasCentralSkills.mockRejectedValue(new Error('scan failed'))

    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('导入页')
    })
  })

  it('支持从技能管理切到用量监测并切回', async () => {
    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('技能管理模块')
    })

    const navButtons = container.querySelectorAll('.nav-item')
    const usageButton = [...navButtons].find((button) =>
      button.textContent.includes('用量监测')
    )
    // 技能导航标签由历史的 "技能管理" 改为当前的 "Skills 管理"
    const skillsButton = [...navButtons].find((button) =>
      button.textContent.includes('Skills 管理')
    )

    await act(async () => {
      usageButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // 用量监测已从占位页演进为真实用量页，校验其特有的“总 Token”概览卡片
    // （该文案只出现在用量页，不会与侧栏导航标签重叠）
    await waitUntil(() => {
      expect(container.textContent).toContain('总 Token')
    })

    await act(async () => {
      skillsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('技能管理模块')
    })
  })

  it('导入完成后可进入 workbench', async () => {
    dataStore.hasCentralSkills.mockResolvedValue(false)

    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('导入页')
    })

    const importButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('完成导入')
    )

    await act(async () => {
      importButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitUntil(() => {
      expect(container.textContent).toContain('技能管理模块')
    })
  })

  it('首次进入 workbench 会初始化推送目标并清理标记', async () => {
    dataStore.isFirstEntryAfterImport.mockResolvedValue(true)
    dataStore.getLastImportedToolIds.mockReturnValue(['claude-code', 'cursor'])

    await act(async () => {
      root.render(<App />)
    })

    await waitUntil(() => {
      expect(dataStore.initPushTargetsAfterImport).toHaveBeenCalledWith([
        'claude-code',
        'cursor',
      ])
    })
    expect(dataStore.setFirstEntryAfterImport).toHaveBeenCalledWith(false)
  })
})
