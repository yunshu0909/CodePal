# API 配置（供应商切换）— 已断接线隔离

> 隔离时间：2026-07-12（v1.9.8 安全收口）
> 隔离原因：① 巡检 P0——`get-provider-env-config` / `get-claude-provider` 把**真实 API token 回传渲染层**，且页面自 v1.5.0 从侧栏隐藏后仍路由可达；② 用户 2026-04-13 表态「API 设置倾向删（自己不需要多模型切换）」。
> 隔离方式：照 `_disabled/codex-account/` 先例——断接线 + 整体搬出打包范围（`_disabled/` 不在 electron-builder files 与 Vite 构建路径内），代码完整保留、随时可恢复。

## 本目录内容（保持原相对路径结构）

| 文件 | 原位置 |
|---|---|
| `src/pages/ApiConfigPage.jsx` | `src/pages/` |
| `src/styles/api-config.css` | `src/styles/` |
| `electron/handlers/registerProviderHandlers.js` | `electron/handlers/` |
| `electron/services/providerSwitchService.js` | `electron/services/` |
| `自动化测试/V0.7/tests/integration/ApiConfigPage.v07.formal-flow.test.jsx` | `自动化测试/V0.7/tests/integration/` |
| `自动化测试/V0.7/tests/e2e/api-config.v07.formal-electron.spec.js` | `自动化测试/V0.7/tests/e2e/` |

注意：搬出后本目录内文件的相对 import 是断的（不参与构建，无影响）。

## 断接线点清单（恢复时逆向操作）

1. `electron/main.js`：删除了 `registerProviderHandlers` 的 require 与调用块（原实参：`ipcMain, pathExists, envFilePath: ENV_FILE_PATH, providerRegistryFilePath: PROVIDER_REGISTRY_FILE_PATH`；两个常量仍在 main.js 中，dotenv 与内置 MCP ensure 还在用）
2. `electron/preload.js`：删除了 6 个 API——`getClaudeProvider` / `listProviderDefinitions` / `registerProviderManifest` / `getProviderEnvConfig` / `saveProviderToken` / `switchClaudeProvider`
3. `src/App.jsx`：删除了 `ApiConfigPage` import、`activeModule === 'api'` 路由行、`VALID_ACTIVE_MODULES` 中的 `'api'`（含 JSDoc 联合类型）
4. `src/components/WorkbenchLayout.jsx`：侧栏项 v1.5.0 起就是隐藏的（仅注释），恢复时在「工具设置」组补 `{ id: 'api', label: 'API 配置', icon: '🔑' }`

## 未随隔离移动（其他模块仍依赖）

- `electron/services/providerRegistryService.js`——当时 `providerRegistryPathService` 与 `mcp/provider_registry_mcp.js` 依赖；**2026-09-24 已随 MCP 下线搬进 `_disabled/mcp-manager/electron/services/`**，恢复本模块时从那里一并取回
- `electron/services/envFileService.js`——`claudeSettingsService` 依赖
- `electron/services/claudeSettingsService.js`——v1.9.8 起是 settings.json 唯一写 broker
- `src/components/ApiKeyField`——K28 状态灯页复用
- 用户的 `.env` 文件与既有 token、`~/.claude/backups/` 备份——未做任何改动

## 恢复步骤

1. 本目录 6 个文件 `git mv` 回原位。
2. 按「断接线点清单」逆向补回 4 处接线。
3. 注意：恢复后若要继续暴露 token 给渲染层，先做脱敏改造（返回 `hasToken` + 掩码，保存走只写通道）——不要原样恢复 P0。
4. 跑 `npm test` + `npm run test:v198`（v198 的 providerTokenCutoff 静态守卫会红，恢复时同步更新该测试的预期）。
