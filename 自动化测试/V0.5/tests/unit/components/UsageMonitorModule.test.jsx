import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import UsageMonitorModule from '@/components/UsageMonitorModule.jsx'

describe('UsageMonitorModule (V0.5)', () => {
  let container
  let root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('渲染真实用量监测页', () => {
    // 用量监测已从占位页演进为真实用量页（UsageMonitorPage）。
    // 这些文案在无 electronAPI 时也会同步渲染，校验页面骨架已正确挂载。
    act(() => {
      root.render(<UsageMonitorModule />)
    })

    expect(container.textContent).toContain('用量监测')
    expect(container.textContent).toContain('追踪 Token 消耗与预算执行情况')
    expect(container.textContent).toContain('总 Token')
    expect(container.textContent).toContain('预估费用')
  })
})
