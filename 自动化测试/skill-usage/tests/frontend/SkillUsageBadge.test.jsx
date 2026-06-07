/**
 * SkillUsageBadge — 前端渲染测试（5 个分支 + 999+ 封顶）
 *
 * 999+ 封顶逻辑只活在前端这个组件里（后端返原始数），故重点守它。
 *
 * @module 自动化测试/skill-usage/tests/frontend/SkillUsageBadge.test
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import SkillUsageBadge from '@/components/skillUsage/SkillUsageBadge'

describe('SkillUsageBadge', () => {
  it('加载中 → 骨架', () => {
    const { container } = render(<SkillUsageBadge loading />)
    expect(container.querySelector('.usage-skel')).toBeTruthy()
  })

  it('读取失败 → 「—」', () => {
    const { container } = render(<SkillUsageBadge error />)
    const dash = container.querySelector('.usage-dash')
    expect(dash).toBeTruthy()
    expect(dash.textContent).toBe('—')
  })

  it('0 次 → 灰 Tag(default)', () => {
    const { container } = render(<SkillUsageBadge usage={{ total: 0 }} />)
    const tag = container.querySelector('.tag')
    expect(tag.textContent).toBe('0 次')
    expect(tag.className).toContain('tag--default')
  })

  it('N 次 → 蓝 Tag(info)', () => {
    const { container } = render(<SkillUsageBadge usage={{ total: 18 }} />)
    const tag = container.querySelector('.tag')
    expect(tag.textContent).toBe('18 次')
    expect(tag.className).toContain('tag--info')
  })

  it('≥1000 → 「999+ 次」封顶', () => {
    const { container } = render(<SkillUsageBadge usage={{ total: 1234 }} />)
    expect(container.querySelector('.tag').textContent).toBe('999+ 次')
  })

  it('usage 缺省(无记录) → 0 次', () => {
    const { container } = render(<SkillUsageBadge />)
    expect(container.querySelector('.tag').textContent).toBe('0 次')
  })
})
