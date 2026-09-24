# MCP 管理 + 内置 provider_registry MCP — 已下线隔离

> 隔离时间：2026-09-24（架构优化 B2-1，ISSUES #42 / #48）
> 原因：MCP 管理页 v1.7.2 起已从侧栏隐藏，但旧版本每次启动仍把 `provider_registry` MCP 补写进用户的 `~/.claude.json` 与 `~/.codex/config.toml`（整份重写还会丢注释），每个 Claude / Codex 会话都在加载它，用户看不到也关不掉。
> 方式：照 `_disabled/codex-account/`、`_disabled/api-config/` 先例——断接线 + 整体搬出打包范围（`_disabled/` 不在 electron-builder files 与 Vite 构建路径内），代码完整保留、可恢复。
> 配套：`electron/services/legacyMcpCleanup.js` 在新版本首次启动时一次性移除已写入的条目（只动 args 指向 `…/mcp/provider_registry_mcp.js` 的，先备份到 `*.codepal.bak`）。

## 本目录内容（保持原相对路径）

| 文件 | 原位置 |
|---|---|
| `src/pages/McpPage.jsx`、`src/styles/mcp-page.css` | 同名目录 |
| `electron/handlers/registerMcpHandlers.js` | `electron/handlers/` |
| `electron/services/builtinMcpInstallerService.js`、`providerRegistryService.js`、`providerRegistryPathService.js` | `electron/services/` |
| `mcp/`（provider_registry MCP 脚本与 service bundle） | 仓库根 `mcp/` |
| `scripts/mcp/install_provider_registry_mvp.js` | `scripts/mcp/` |

## 断接线点（恢复时逆向）

1. `electron/main.js`：Task 1（`764bb2e`）删了启动时 `ensureBuiltinProviderRegistryInstalled` 调用与 `registerMcpHandlers` 注册；B2-1 加了 `runLegacyProviderRegistryCleanup`（恢复前先删掉它，否则会把刚装的条目当旧条目清掉）。
2. `electron/preload.js`：删了 `electronAPI.mcp`（scanConfigs / toggleMcp / checkToolsInstalled）。
3. `src/App.jsx`：删了 `McpPage` import、`'mcp'` 有效模块与 keep-alive 渲染。
4. `src/components/WorkbenchLayout.jsx` 侧栏注释项、`sidebarIcons.js` 的 `mcp` 图标。
5. `package.json`：删了 `mcp:*` 三个脚本与 `build.files` 的 `mcp/**/*`。

## 恢复注意

- 不要恢复「启动时自动补写」：任何对用户工具配置的写入都要走 Codex 配置负责人（`codexConfigOwner`）/ settings 唯一写入口，并让用户可见、可关。
- `_disabled/api-config` 依赖本目录的 `providerRegistryService` / `providerRegistryPathService`，一并恢复。
