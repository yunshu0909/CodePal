/**
 * 死代码清理守护（架构优化 B2-2）
 *
 * 负责：
 * - 生产入口（main.js / preload.js / src/main.jsx / DSH worker）走不到的渲染层文件已删除，且不再回来
 * - preload 不再暴露渲染层没人调用的接口（暴露面越小越好）
 * - 旧模板、下线功能的脚本与过期文档不再随仓库 / 安装包分发
 *
 * 判据是「从生产入口沿 require / import 走不到」，不是 grep 名字（k28 模板曾因分段拼接路径被 grep 误判）。
 * 主进程旧用量接口（aggregate-usage-period / range、scan-log-files）仍被测试用来覆盖日志扫描核心，留给统计引擎迁移（路线 6）一并处理。
 *
 * @module tests/safety/deadCode.test
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..', '..')

const REMOVED_FILES = [
  'src/components/ApiKeyField/ApiKeyField.jsx',
  'src/components/ConfigModal.jsx',
  'src/hooks/useAsyncData.js',
  'src/pages/UsagePlaceholderPage.jsx',
  'src/pages/usage/components/BudgetProgress.jsx',
  'src/pages/usage/components/DatePickerModal.jsx',
  'src/pages/usage/components/DistributionBar.jsx',
  'src/pages/usage/components/GoalSettingModal.jsx',
  'src/pages/usage/components/UsageDisplayComponents.jsx',
  'src/pages/usage/usageDateUtils.js',
  'src/pages/usage/useUsageCache.js',
  'src/pages/usage/useUsageData.js',
  'src/pages/usage/useUsageHeavyPeriods.js',
  'src/store/logParser.js',
  'src/store/usageAggregator.js',
  'templates/project-init-v0.9',
  'templates/project-init-v1.2.5',
  'templates/project-init-v2',
  'scripts/repair-v17.js',
  'scripts/make-v17-test-snapshot.js',
  'scripts/network/runVpnDiagnosticsDemo.js',
  'docs/refactoring-plan.md',
  'docs/VPN_STABILITY_DEMO.md',
  'docs/prd-v1.3.0-auto-update.md',
  'docs/research/V1.5.0-codex-impl-details.md',
]

// 注：getModelConfig / setModelConfig / resetModelConfig / resetPermissionMode / restorePermissionMode 当前也没人调，
// 但「Claude 设置重做」时明确决定保留（tests/claudeSettingsWiring.test.js TC-024），不在清理范围
const UNUSED_PRELOAD_APIS = [
  'scanPresetTools', 'checkPathExists', 'scanDshUsage', 'aggregateUsageRange', 'aggregateUsagePeriod',
  'getUsageStatisticsStatus', 'deploySkillToTool', 'getEarliestLogDate', 'getModelRegistry', 'checkAppUpdate',
]

describe('B2-2 死代码清理', () => {
  it('D-1 生产入口走不到的文件、旧模板、下线脚本与过期文档已删除', () => {
    const still = REMOVED_FILES.filter((rel) => existsSync(path.join(root, rel)))
    expect(still).toEqual([])
  })

  it('D-2 仍在用的保留：k28 模板、组件预览页、分段控件', () => {
    for (const keep of ['templates/k28-status-light', 'templates/project-init-v3', 'src/pages/ComponentPreviewPage.jsx', 'src/components/SegmentedControl/SegmentedControl.jsx']) {
      expect(existsSync(path.join(root, keep))).toBe(true)
    }
  })

  it('D-3 preload 不再暴露渲染层没人调用的接口', () => {
    const preload = readFileSync(path.join(root, 'electron', 'preload.js'), 'utf-8')
    const exposed = UNUSED_PRELOAD_APIS.filter((name) => new RegExp(`^\\s{2}${name}\\s*:`, 'm').test(preload))
    expect(exposed).toEqual([])
  })
})

// B2-7：统计引擎基线实测后不搬进程（见 specs/arch-b2-7-统计引擎基线），只清掉已没有渲染层入口的旧用量接口
const LEGACY_USAGE_CHANNELS = ['scan-log-files', 'aggregate-usage-range', 'aggregate-usage-period', 'scan-dsh-usage', 'get-earliest-log-date', 'usage-aggregate:progress']
const LEGACY_USAGE_FILES = ['electron/aggregateUsagePeriodHandler.js', 'electron/aggregateUsageRangeHandler.js', 'electron/scanLogFilesHandler.js']

describe('B2-7 旧用量接口下线', () => {
  it('D-4 主进程与 preload 不再注册 / 暴露旧用量通道；日历通道保留', () => {
    const sources = ['electron/main.js', 'electron/preload.js', 'electron/handlers/registerUsageAggregationHandlers.js']
      .map((rel) => readFileSync(path.join(root, rel), 'utf-8')).join('\n')
    expect(LEGACY_USAGE_CHANNELS.filter((ch) => sources.includes(`'${ch}'`))).toEqual([])
    expect(sources).toContain("'aggregate-usage-calendar'")
    expect(sources).toContain("'usage-calendar:progress'")
  })

  it('D-5 旧用量 handler 文件与渲染层包装已删除', () => {
    expect(LEGACY_USAGE_FILES.filter((rel) => existsSync(path.join(root, rel)))).toEqual([])
    const fsStore = readFileSync(path.join(root, 'src', 'store', 'fs.js'), 'utf-8')
    expect(fsStore).not.toMatch(/scanLogFiles/)
    const preload = readFileSync(path.join(root, 'electron', 'preload.js'), 'utf-8')
    expect(preload).not.toMatch(/^\s{2}(scanLogFiles|onUsageAggregationProgress)\s*:/m)
  })
})

// 2026-09-25 发 v2.0.0：README 只介绍 dev 上真实存在的功能
describe('README 与代码一致', () => {
  it('D-6 README 不再介绍已下线模块，也不引用已删的旧截图', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf-8')
    expect(readme).not.toMatch(/^#{2,4} .*MCP 管理/m)
    expect(readme).not.toMatch(/docs\/screenshots\//)
    expect(readme).not.toMatch(/#### 启动模式/)
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')).version
    expect(readme).toContain(`version-v${version}-blue`)
  })
})
