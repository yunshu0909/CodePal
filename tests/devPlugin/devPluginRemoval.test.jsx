/** v2.1.25 · 插件管理的连带改动：侧栏新增「开发流程 › 插件管理」；模型汇总 › 审核规则页签去掉 dev 插件状态行（后-21、B-012）
 * 审核规则页签的界面断言在 tests/models/modelHubTabs.test.jsx 的 TC-101，主进程断言在 tests/models/reviewCenter.test.js 的 TC-101。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WorkbenchLayout from '../../src/components/WorkbenchLayout'
import { SIDEBAR_ICONS } from '../../src/components/sidebarIcons'
import { VALID_ACTIVE_MODULES } from '../../src/App'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

beforeEach(() => {
  window.electronAPI = { onShowAbout: vi.fn(() => () => {}), openExternalLink: vi.fn() }
})
afterEach(() => cleanup())

it('TC-101 侧栏分组依次是用量账单、项目开发、技能中心、开发流程、环境配置；开发流程下只有插件管理（青色图标），点它切到 devPlugin', () => {
  const onModuleChange = vi.fn()
  const { container } = render(<WorkbenchLayout activeModule="usage" onModuleChange={onModuleChange}><div /></WorkbenchLayout>)
  const groups = [...container.querySelectorAll('.nav-group')]
  expect(groups.map((g) => g.querySelector('.nav-group-label').textContent)).toEqual(['用量账单', '项目开发', '技能中心', '开发流程', '环境配置'])
  const dev = groups[3]
  const items = [...dev.querySelectorAll('.nav-label')].map((el) => el.textContent)
  expect(items).toEqual(['插件管理'])
  expect(SIDEBAR_ICONS.devPlugin.color).toBe('var(--ic-teal)')
  fireEvent.click(dev.querySelector('.nav-label'))
  expect(onModuleChange).toHaveBeenCalledWith('devPlugin')
  expect(VALID_ACTIVE_MODULES.has('devPlugin')).toBe(true)
})

it('TC-101 插件状态只由 devPlugin 模块读：旧 devStatus 模块不再被引用，审核配置读取不再带 dev（后-21-例2、后-23-例1、B-012）', () => {
  // 旧模块文件在合并后的收尾提交里删除（任务内不能删文件，D42）；这里只断言引用已断开，引用扫描见 tests/models/devStatus.test.js
  expect(fs.existsSync(path.join(root, 'electron/modules/devPlugin/state.js'))).toBe(true)
  const reviewCenter = fs.readFileSync(path.join(root, 'electron/modules/models/reviewCenter.js'), 'utf8')
  expect(reviewCenter).not.toMatch(/devStatus|readDevStatus/)
  const rulesTab = fs.readFileSync(path.join(root, 'src/features/modelHub/RulesTab.jsx'), 'utf8')
  expect(rulesTab).not.toMatch(/DEV_TEXT|data-rules="dev"/)
})
