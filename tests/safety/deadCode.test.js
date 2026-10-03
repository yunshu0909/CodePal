/**
 * 死代码清理守护（架构优化 B2-2 起，v2.0.0 发版前补充）
 *
 * 负责：
 * - 生产入口（main.js / preload.js / src/main.jsx / DSH worker）走不到的渲染层文件已删除，且不再回来
 * - preload 不再暴露渲染层没人调用的接口（暴露面越小越好）
 * - 旧模板、下线功能的脚本与过期文档不再随仓库 / 安装包分发
 * - 主进程旧用量接口已在 B2-7 删除；页面调不到的主进程通道不再注册（D-7）
 * - README 只介绍 dev 上真实存在的功能（D-6）
 *
 * 判据是「从生产入口沿 require / import 走不到」，不是 grep 名字（k28 模板曾因分段拼接路径被 grep 误判）。
 *
 * @module tests/safety/deadCode.test
 *
 * 也是 specs/v2.1.6-新建项目 的守卫行 TC-026：新建项目改造后已删文件不回来、无人调用的通道不注册。
 * 也是 specs/v2.1.9-Skills只留一套引擎 的 TC-001：Skills 旧导入 / 推送引擎退役后，文件、preload API、通道不回来。
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
  // 新建项目重做（2026-10-02，specs/v2.1.6-新建项目）：旧模板与旧组件
  'templates/project-init-v3',
  'src/components/ProjectInitSuccessModal.jsx',
  'src/pages/projectInit/ProjectTreePreview.jsx',
  'src/styles/project-init.css',
  'scripts/repair-v17.js',
  'scripts/make-v17-test-snapshot.js',
  'scripts/network/runVpnDiagnosticsDemo.js',
  'docs/refactoring-plan.md',
  'docs/VPN_STABILITY_DEMO.md',
  'docs/prd-v1.3.0-auto-update.md',
  'docs/research/V1.5.0-codex-impl-details.md',
  // Plugins 管理下线（2026-09-29，specs/plugin-control-offline-3）
  'src/pages/PluginControlPage.jsx',
  'src/hooks/usePluginControl.js',
  'src/styles/plugin-control.css',
  'electron/services/pluginControlService.js',
  'electron/handlers/registerPluginControlHandlers.js',
  'tests/v21/pluginControlService.test.js',
  'tests/v21/PluginControlPage.test.jsx',
  'tests/v21/pluginExplainability.test.jsx',
]

// 注：getModelConfig / setModelConfig / resetModelConfig / resetPermissionMode / restorePermissionMode 当前也没人调，
// 但「Claude 设置重做」时明确决定保留（tests/claudeSettingsWiring.test.js TC-024），不在清理范围
const UNUSED_PRELOAD_APIS = [
  'scanPresetTools', 'checkPathExists', 'scanDshUsage', 'aggregateUsageRange', 'aggregateUsagePeriod',
  'getUsageStatisticsStatus', 'deploySkillToTool', 'getEarliestLogDate', 'getModelRegistry', 'checkAppUpdate',
  'getPluginControlSnapshot', 'executePluginCommand',
]

describe('B2-2 死代码清理', () => {
  it('D-1 生产入口走不到的文件、旧模板、下线脚本与过期文档已删除', () => {
    const still = REMOVED_FILES.filter((rel) => existsSync(path.join(root, rel)))
    expect(still).toEqual([])
  })

  it('D-2 仍在用的保留：k28 模板、组件预览页、分段控件', () => {
    for (const keep of ['templates/k28-status-light', 'templates/project-init-v4', 'src/pages/ComponentPreviewPage.jsx', 'src/components/SegmentedControl/SegmentedControl.jsx']) {
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
    // src/store/fs.js 已随 Skills 旧引擎退役删除（v2.1.9）；还在时仍不许带旧用量包装
    const fsStorePath = path.join(root, 'src', 'store', 'fs.js')
    if (existsSync(fsStorePath)) expect(readFileSync(fsStorePath, 'utf-8')).not.toMatch(/scanLogFiles/)
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

// 2026-09-25 发版前静态审计：页面调不到的主进程通道一并清掉（下线要连 IPC 一起清干净）
const DEAD_MAIN_CHANNELS = ['app-update:check', 'scan-preset-tools', 'check-path-exists', 'model-registry:get', 'skill-control:deploy', 'usage-statistics:status', 'plugin-control:get-snapshot', 'plugin-control:execute']

describe('主进程没有页面调不到的通道', () => {
  it('D-7 主进程不再注册无人调用的通道；preload 不再监听没人发的 plan-resume', () => {

    const handlerDir = path.join(root, 'electron', 'handlers')
    const sources = [path.join(root, 'electron', 'main.js'), ...readdirSync(handlerDir).map((f) => path.join(handlerDir, f))]
      .map((file) => readFileSync(file, 'utf-8')).join('\n')
    expect(DEAD_MAIN_CHANNELS.filter((ch) => sources.includes(`'${ch}'`))).toEqual([])
    expect(readFileSync(path.join(root, 'electron', 'preload.js'), 'utf-8')).not.toMatch(/plan-resume/)
  })
})

// Skills 只留一套引擎（2026-10-02，specs/v2.1.9-Skills只留一套引擎，#61）：旧导入 / 推送引擎整套退役，连同接线与零引用组件
const SKILL_ENGINE_FILES = [
  'src/components/SkillManagerModule.jsx',
  'src/pages/ManagePage.jsx',
  'src/pages/ImportPage.jsx',
  'src/pages/ConfigPage.jsx',
  'src/pages/config/configPageStyles.js',
  'src/components/AddPathModal.jsx',
  'src/store/data.js',
  'src/store/fs.js',
  'src/store/services/importService.js',
  'src/store/services/pushService.js',
  'src/store/services/autoSyncService.js',
  'src/store/services/customPathManager.js',
  'src/store/services/pathService.js',
  'src/store/services/repoPathManager.js',
  'src/store/services/tagService.js',
  'src/components/TagManagementModal/TagManagementModal.jsx',
  'src/components/TagSelector/TagSelector.jsx',
  'src/components/TagFilterChips/TagFilterChips.jsx',
  'src/components/BatchActionBar/BatchActionBar.jsx',
  'src/components/PathPickerField.jsx',
  'src/components/skillUsage/SkillUsageBadge.jsx',
  'src/components/skillUsage/SkillUsageColumnHeader.jsx',
  'src/components/skillUsage/SkillRunSamplesModal.jsx',
  'src/hooks/useTagManagement.js',
  'electron/handlers/registerSkillHandlers.js',
  'electron/handlers/registerImportPageHandlers.js',
  'electron/handlers/registerRepoWatcherHandlers.js',
  'electron/services/repoWatcherService.js',
  'electron/services/skillScanService.js',
  'tests/importService.regression.test.js',
  'tests/lifecycle/repoWatcherReopen.test.js',
]
const SKILL_ENGINE_PRELOAD_APIS = [
  'scanToolDirectory', 'readSkillInfo', 'copySkill', 'deleteSkill', 'ensureDir', 'pathExists', 'readConfig', 'writeConfig',
  'scanCustomPath', 'importSkills', 'getCentralSkills', 'getToolStatus', 'pushSkills', 'unpushSkills', 'incrementalImport',
  'compareSkillContent', 'onCentralRepoChanged', 'acquireSyncLock', 'releaseSyncLock', 'restartRepoWatcher', 'adoptExternalSkill',
]
const SKILL_ENGINE_CHANNELS = [
  'scan-tool-directory', 'read-skill-info', 'copy-skill', 'delete-skill', 'ensure-dir', 'path-exists', 'read-config', 'write-config',
  'scan-custom-path', 'import-skills', 'get-central-skills', 'get-tool-status', 'push-skills', 'unpush-skills', 'incremental-import',
  'compare-skill-content', 'central-repo-changed', 'acquire-sync-lock', 'release-sync-lock', 'restart-repo-watcher', 'skill-control:adopt',
]

describe('Skills 旧引擎退役（v2.1.9）', () => {
  it('TC-001 ONE_ENGINE_REMOVED 旧引擎文件、preload API、通道都不回来；App 不再有后台导入与推送', () => {
    const still = SKILL_ENGINE_FILES.filter((rel) => existsSync(path.join(root, rel)))
    expect(still, 'ONE_ENGINE_REMOVED 旧引擎文件还在').toEqual([])

    const preload = readFileSync(path.join(root, 'electron', 'preload.js'), 'utf-8')
    const exposed = SKILL_ENGINE_PRELOAD_APIS.filter((name) => new RegExp(`^\\s{2}${name}\\s*:`, 'm').test(preload))
    expect(exposed, 'ONE_ENGINE_REMOVED preload 仍暴露旧引擎接口').toEqual([])

    const handlerDir = path.join(root, 'electron', 'handlers')
    const sources = [path.join(root, 'electron', 'main.js'), path.join(root, 'electron', 'preload.js'), ...readdirSync(handlerDir).map((f) => path.join(handlerDir, f))]
      .map((file) => readFileSync(file, 'utf-8')).join('\n')
    expect(SKILL_ENGINE_CHANNELS.filter((ch) => sources.includes(`'${ch}'`)), 'ONE_ENGINE_REMOVED 主进程仍注册旧引擎通道').toEqual([])

    const app = readFileSync(path.join(root, 'src', 'App.jsx'), 'utf-8')
    const leftovers = ['autoIncrementalRefresh', 'handleCentralRepoChanged', 'initPushTargetsIfNeeded', 'acquireSyncLock', 'onCentralRepoChanged', 'store/data']
      .filter((token) => app.includes(token))
    expect(leftovers, 'ONE_ENGINE_REMOVED App 仍有后台导入 / 推送').toEqual([])
  })
})

// Skills 要处理（specs/v2.1.11-Skills要处理-实现）：#61 删掉的标签与用量组件留下的样式文件补登记（#61 延后项）
const REMOVED_CSS_61 = [
  'src/components/TagFilterChips/TagFilterChips.css',
  'src/components/TagManagementModal/TagManagementModal.css',
  'src/components/TagSelector/TagSelector.css',
  'src/components/skillUsage/skillUsage.css',
]

describe('#61 删掉的样式文件不复活', () => {
  it('TC-017 标签与用量组件的 4 个样式文件不存在', () => {
    const still = REMOVED_CSS_61.filter((rel) => existsSync(path.join(root, rel)))
    expect(still).toEqual([])
  })
})
