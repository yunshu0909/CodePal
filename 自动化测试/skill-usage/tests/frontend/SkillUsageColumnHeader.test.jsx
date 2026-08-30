/**
 * SkillUsageColumnHeader — 新调用口径与 source 状态测试
 *
 * @module 自动化测试/skill-usage/tests/frontend/SkillUsageColumnHeader.test
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SkillUsageColumnHeader from '@/components/skillUsage/SkillUsageColumnHeader'

describe('SkillUsageColumnHeader', () => {
  it('说明层展示已记录口径、上次扫描、双源状态与诚实边界', () => {
    render(
      <SkillUsageColumnHeader
        sort="desc"
        onToggleSort={() => {}}
        helpOpen
        onToggleHelp={() => {}}
        scanMeta={{
          lastScannedAt: '2026-07-26T12:00:00.000Z',
          sources: { claude: 'ok', codex: 'missing' },
          migrationFailed: false,
        }}
      />
    )

    expect(screen.getByText(/CodePal 已记录的近 30 天有效调用/)).toBeTruthy()
    expect(screen.getByText(/同一会话触发两次记 2 次/)).toBeTruthy()
    expect(screen.getByText(/Claude 已读取 · Codex 未找到/)).toBeTruthy()
    expect(screen.getByText(/0 次不等于一定没用过/)).toBeTruthy()
  })

  it('迁移失败有明确提示，排序与说明按钮行为不退化', () => {
    const onToggleSort = vi.fn()
    const onToggleHelp = vi.fn()
    render(
      <SkillUsageColumnHeader
        sort="asc"
        onToggleSort={onToggleSort}
        helpOpen
        onToggleHelp={onToggleHelp}
        scanMeta={{
          sources: { claude: 'error', codex: 'error' },
          migrationFailed: true,
        }}
      />
    )

    fireEvent.click(screen.getByText(/调用·近30天/))
    fireEvent.click(screen.getByTitle('调用数说明'))
    expect(onToggleSort).toHaveBeenCalledTimes(1)
    expect(onToggleHelp).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/账本升级失败/)).toBeTruthy()
  })

  it.each([
    [{ claude: 'ok', codex: 'ok' }, 'Claude 已读取 · Codex 已读取'],
    [{ claude: 'missing', codex: 'error' }, 'Claude 未找到 · Codex 读取失败'],
    [{ claude: 'error', codex: 'missing' }, 'Claude 读取失败 · Codex 未找到'],
  ])('完整映射双源状态 %#', (sources, expected) => {
    render(
      <SkillUsageColumnHeader
        sort="desc"
        onToggleSort={() => {}}
        helpOpen
        onToggleHelp={() => {}}
        scanMeta={{ sources }}
      />
    )
    expect(screen.getByText(expected)).toBeTruthy()
  })
})
