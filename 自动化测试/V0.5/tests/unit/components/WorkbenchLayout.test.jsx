import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import WorkbenchLayout from '@/components/WorkbenchLayout.jsx'

describe('WorkbenchLayout (V0.5)', () => {
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

  it('默认高亮技能管理导航', () => {
    act(() => {
      root.render(
        <WorkbenchLayout activeModule="skills" onModuleChange={() => {}}>
          <div>内容区域</div>
        </WorkbenchLayout>
      )
    })

    const buttons = container.querySelectorAll('.nav-item')
    // 技能导航标签由历史的 "技能管理" 改为当前的 "Skills 管理"
    const skillsButton = [...buttons].find((button) => button.textContent.includes('Skills 管理'))
    const usageButton = [...buttons].find((button) => button.textContent.includes('用量监测'))

    expect(skillsButton).toBeTruthy()
    expect(usageButton).toBeTruthy()
    expect(skillsButton.classList.contains('active')).toBe(true)
    expect(usageButton.classList.contains('active')).toBe(false)
  })

  it('点击非当前导航会触发切换', () => {
    const onModuleChange = vi.fn()

    act(() => {
      root.render(
        <WorkbenchLayout activeModule="skills" onModuleChange={onModuleChange}>
          <div>内容区域</div>
        </WorkbenchLayout>
      )
    })

    const buttons = container.querySelectorAll('.nav-item')
    const usageButton = [...buttons].find((button) => button.textContent.includes('用量监测'))

    act(() => {
      usageButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onModuleChange).toHaveBeenCalledTimes(1)
    expect(onModuleChange).toHaveBeenCalledWith('usage')
  })

  it('点击当前已激活导航不重复触发切换', () => {
    const onModuleChange = vi.fn()

    act(() => {
      root.render(
        <WorkbenchLayout activeModule="skills" onModuleChange={onModuleChange}>
          <div>内容区域</div>
        </WorkbenchLayout>
      )
    })

    const buttons = container.querySelectorAll('.nav-item')
    // 技能导航标签由历史的 "技能管理" 改为当前的 "Skills 管理"
    const skillsButton = [...buttons].find((button) => button.textContent.includes('Skills 管理'))

    act(() => {
      skillsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onModuleChange).not.toHaveBeenCalled()
  })
})
