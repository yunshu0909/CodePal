# 架构重构计划

> 目标：将所有超红线文件降到合规范围内（JS/JSX < 800 行，页面组件 < 650 行）
> 原则：只做结构拆分，不改业务逻辑，不改数据格式，不改 IPC 接口名

---

## 任务总览

| # | 文件 | 现状 | 红线 | 难度 | 状态 |
|---|------|------|------|------|------|
| T1 | `electron/handlers/registerProjectInitHandlers.js` | 804→784 | 800 | 低 | 已完成 |
| T2 | `src/pages/ConfigPage.jsx` | 724→478 | 650 | 中 | 已完成 |
| T3 | `src/pages/UsageMonitorPage.jsx` | 898→636 | 650 | 中 | 已完成 |
| T4 | `src/store/data.js` | 969→782 | 800 | 中 | 已完成 |
| T5 | `electron/aggregateUsageRangeHandler.js` | 953→337 | 800 | 中 | 已完成 |
| T6 | `electron/handlers/registerProviderHandlers.js` | 1284→303 | 800 | 高 | 已完成 |

---

## T1: registerProjectInitHandlers.js (804 → < 800)

**只超 4 行，做最小拆分即可。**

### T1.1 抽出模板常量到独立文件

- 新建 `electron/config/projectInitConfig.js`
- 将 TEMPLATE_DEFINITIONS、TEMPLATE_KEYS 等常量块（约 35 行）移入
- 原文件改为 `require('./config/projectInitConfig')`

### 验收标准
- [ ] 原文件 < 800 行
- [ ] `npm run dev` 能正常启动，新建项目功能正常

---

## T2: ConfigPage.jsx (724 → < 650)

**需减少约 80 行。拆两个 Section 子组件即可。**

### T2.1 抽出自定义路径列表为子组件

- 新建 `src/pages/config/CustomPathSection.jsx`
- 迁入：自定义路径列表渲染 + 删除按钮 + 空态提示（JSX 部分）
- 父组件通过 props 传入 `customPaths`、`onDelete`、`onAdd`

### T2.2 抽出推送目标选择为子组件

- 新建 `src/pages/config/PushTargetSection.jsx`
- 迁入：推送目标 toggle 列表渲染
- 父组件通过 props 传入 `targets`、`selectedTargets`、`onToggle`

### 验收标准
- [ ] ConfigPage.jsx < 650 行
- [ ] 配置页面：自定义路径增删、推送目标勾选、保存功能正常
- [ ] `npm run build` 通过

---

## T3: UsageMonitorPage.jsx (898 → < 650)

**需减少约 250 行。抽 hook + 子组件。**

### T3.1 抽出日期工具函数

- 新建 `src/pages/usage/usageDateUtils.js`
- 迁入：`getBeijingDayKey`、`getBeijingDayStart`、`getDailyRefreshKey`、`getTimeRangeForPeriod` 等纯函数（约 100 行）
- 原文件改为 import

### T3.2 抽出缓存逻辑为 hook

- 新建 `src/pages/usage/useUsageCache.js`
- 迁入：`createEmptyCache`、`readUsageCache`、`writeUsageCache`、缓存新鲜度判断（约 80 行）
- 导出 `useUsageCache()` hook

### T3.3 抽出自定义日期弹窗为子组件

- 新建 `src/pages/usage/components/DatePickerModal.jsx`
- 迁入：自定义日期选择相关的 state + 校验 + JSX（约 120 行）
- 父组件通过 props 传入 `onConfirm`、`onClose`

### 验收标准
- [ ] UsageMonitorPage.jsx < 650 行
- [ ] 用量页面：切换时段、自定义日期、图表展示、自动刷新正常
- [ ] `npm run build` 通过

---

## T4: data.js (969 → < 800)

**需减少约 170 行。将自定义路径管理和仓库路径管理抽出。**

### T4.1 抽出自定义路径管理

- 新建 `src/store/services/customPathManager.js`
- 工厂函数 `createCustomPathManager(deps)` 接收 `getConfig`、`saveConfig`、`scanCustomPath`、`selectFolder`
- 迁入：`getCustomPaths`、`addCustomPath`（含串行队列）、`deleteCustomPath`、`selectAndAddCustomPath`（约 130 行）
- data.js 的 dataStore 对应方法改为委托

### T4.2 抽出仓库路径管理

- 新建 `src/store/services/repoPathManager.js`
- 工厂函数 `createRepoPathManager(deps)` 接收 `getConfig`、`saveConfig`、`ensureDir`、`selectFolder`
- 迁入：`setRepoPath`、`selectAndSetRepoPath`（约 70 行）
- data.js 的 dataStore 对应方法改为委托

### 验收标准
- [ ] data.js < 800 行
- [ ] 导入/配置/管理页面功能正常（自定义路径增删、仓库路径切换）
- [ ] `npm run build` 通过

---

## T5: aggregateUsageRangeHandler.js (953 → < 800)

**需减少约 160 行。核心日志扫描逻辑抽 service。**

### T5.1 抽出日志解析与扫描逻辑

- 新建 `electron/services/usageLogScanService.js`
- 迁入：
  - `parseClaudeLine` / `parseCodexTokenSnapshot` 等解析函数（约 70 行）
  - `scanClaudeLogs` / `scanCodexLogs` 扫描函数（约 120 行）
  - Codex session 辅助函数（约 50 行）
- 原文件 `require` 并委托调用

### T5.2 抽出每日汇总缓存逻辑

- 新建 `electron/services/dailySummaryService.js`
- 迁入：`readDailySummary`、`writeDailySummary`、`normalizeDailySummary`、`mergeDailySummaries`（约 130 行）
- 原文件委托调用

### 验收标准
- [ ] aggregateUsageRangeHandler.js < 800 行
- [ ] 用量统计页面：今日/7天/30天/自定义日期范围正常
- [ ] 主进程 `node -e "require('./electron/aggregateUsageRangeHandler')"` 不报错

---

## T6: registerProviderHandlers.js (1284 → < 800)

**最复杂的一个，需减少约 500 行。按职责拆成 service 模块。**

### T6.1 抽出 .env 文件操作

- 新建 `electron/services/envFileService.js`
- 迁入：
  - `readProjectEnvFile` — 读取 .env 并解析为 key-value
  - `loadMergedProviderEnv` — 合并多来源环境变量
  - `.env` 变量更新/写入逻辑
- 约 150 行

### T6.2 抽出 Claude settings 文件操作

- 新建 `electron/services/claudeSettingsService.js`
- 迁入：
  - `readClaudeSettingsFile` — 读取并解析 ~/.claude/settings.json
  - `backupClaudeSettingsRaw` — 备份 settings
  - `ensureClaudeApiKeyHelperScript` — 确保辅助脚本存在
  - `patchClaudeSettings` — 修改 settings
- 约 200 行

### T6.3 抽出供应商切换逻辑

- 新建 `electron/services/providerSwitchService.js`
- 迁入：
  - `switchProviderInEnv` — 切换 .env 中的供应商
  - `switchProviderInClaudeSettings` — 切换 Claude settings 中的供应商
  - `restoreEnvSnapshot` — 回滚逻辑
  - `buildProviderTokenMap` — 构建 token 映射
- 约 180 行
- 依赖 envFileService 和 claudeSettingsService

### 验收标准
- [ ] registerProviderHandlers.js < 800 行
- [ ] API 配置页面：查看当前供应商、切换供应商、保存 Token 正常
- [ ] 主进程 `node -e "require('./electron/handlers/registerProviderHandlers')"` 不报错

---

## 执行顺序

```
T1 (最简单，热身)
 → T2 (前端页面，独立)
 → T3 (前端页面，独立)
 → T4 (前端 store，需谨慎)
 → T5 (主进程，独立)
 → T6 (主进程，最复杂)
```

每完成一个任务：
1. 验证构建通过
2. 更新本文档状态列
3. 继续下一个
