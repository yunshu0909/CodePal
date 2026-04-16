# CC Switch 迁移调研报告

## 1. 执行摘要

- `CC Switch` 不是单点的“Claude 供应商切换器”，而是一套围绕多 CLI 工具的配置中台。
- 它的核心不是 UI，而是三层底座：`SQLite 单一事实源`、`按 app_type 的配置适配器`、`本地代理/故障转移执行层`。
- 当前 `CodePal` 已经有 Skills、MCP、用量、会话浏览、项目初始化、网络诊断等产品骨架，但“配置中心”仍然偏向 `Claude-first`，还不是统一状态中台。
- 如果目标是“尽量完整搬进 CodePal”，建议迁移的是实现模式和能力边界，而不是直接把 Tauri/Rust 源码逐文件搬进 Electron。

## 2. 调研对象与来源

- 官方仓库：[`farion1231/cc-switch`](https://github.com/farion1231/cc-switch)
- 关键说明文档：
  - [`README_ZH.md`](https://github.com/farion1231/cc-switch/blob/main/README_ZH.md)
  - [`docs/working-directory-plan.md`](https://github.com/farion1231/cc-switch/blob/main/docs/working-directory-plan.md)
- 本地重点阅读文件：
  - `CC Switch`
    - `/tmp/cc-switch/src/App.tsx`
    - `/tmp/cc-switch/src-tauri/src/lib.rs`
    - `/tmp/cc-switch/src-tauri/src/database/schema.rs`
    - `/tmp/cc-switch/src-tauri/src/commands/provider.rs`
    - `/tmp/cc-switch/src-tauri/src/commands/mcp.rs`
    - `/tmp/cc-switch/src-tauri/src/services/skill.rs`
    - `/tmp/cc-switch/src-tauri/src/proxy/server.rs`
    - `/tmp/cc-switch/src-tauri/src/session_manager/mod.rs`
  - `CodePal`
    - [skill-manager/src/App.jsx](/Users/yunshu/Documents/trae_projects/skills/skill-manager/src/App.jsx)
    - [skill-manager/electron/main.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/main.js)
    - [skill-manager/electron/preload.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/preload.js)
    - [skill-manager/electron/handlers/registerProviderHandlers.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/handlers/registerProviderHandlers.js)
    - [skill-manager/electron/services/providerSwitchService.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/services/providerSwitchService.js)
    - [skill-manager/electron/handlers/registerMcpHandlers.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/handlers/registerMcpHandlers.js)
    - [skill-manager/electron/services/sessionBrowserService.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/services/sessionBrowserService.js)

## 3. CC Switch 的真实实现逻辑

### 3.1 产品层

`CC Switch` 管的是 5 类 CLI：Claude Code、Codex、Gemini CLI、OpenCode、OpenClaw。它把以下能力收拢成一个桌面中台：

- 供应商管理与切换
- 本地代理、故障转移、健康检测
- MCP 统一管理
- Prompts / Skills 统一管理
- 用量与成本日志
- Session 浏览与删除
- Deep Link 导入
- 云同步、托盘、自动更新、轻量模式

### 3.2 技术层

它的核心栈是：

- 前端：React + TypeScript
- 桌面容器：Tauri
- 核心业务：Rust
- 状态中心：SQLite

不是前端直接改配置文件，而是：

1. 先把 Provider / MCP / Skills / Prompts / Proxy 配置落在 SQLite
2. 再由服务层按 `app_type` 同步到各 CLI 的真实配置文件
3. 对需要运行时介入的能力，再由代理层或托盘层接管

### 3.3 数据模型

从 `/tmp/cc-switch/src-tauri/src/database/schema.rs` 能看出它的设计重点：

- `providers`：主键是 `(id, app_type)`，天然支持多工具分域
- `mcp_servers`：统一表，启用状态按 app 列展开
- `prompts`：按 `(id, app_type)` 存储
- `skills`：统一技能表 + 仓库表 + 启用状态
- `proxy_config` / `provider_health` / `proxy_request_logs`：代理、熔断、健康、成本日志全在库里
- `settings`：设备偏好配置

这意味着它不是“配置文件浏览器”，而是“配置数据库 + 配置投影器”。

### 3.4 配置切换逻辑

从 `/tmp/cc-switch/src-tauri/src/commands/provider.rs` 看，供应商域是完整 CRUD + switch + import + usage query：

- 获取当前 app 的 provider 列表
- 新增 / 编辑 / 删除 provider
- 切换当前 provider
- 导入默认 live config
- 查询套餐/配额/余额

关键点是：所有动作都显式带 `app` / `app_type`，不是默认围绕某一个工具。

### 3.5 Skills 逻辑

`/tmp/cc-switch/src-tauri/src/services/skill.rs` 的重点不是简单复制目录，而是：

- 有 SSOT（单一事实源）目录：`~/.cc-switch/skills/`
- 安装先落 SSOT
- 再按同步策略分发到各应用目录
- 支持 symlink / copy / auto 三种同步方法
- 有 repo 管理、备份、更新检测

这和你当前“中央仓库 + 推送到工具目录”的思路最接近，是最容易借鉴的一块。

### 3.6 MCP 逻辑

`/tmp/cc-switch/src-tauri/src/commands/mcp.rs` 显示它已经把 MCP 从“分应用文件编辑”抽象成统一实体：

- 统一表管理所有 MCP server
- 每个 server 对不同 app 有独立启用状态
- 可从各应用配置导入，再反向同步回去

这比当前 `CodePal` 的双配置文件读写更进一步，因为它已经有中间层模型。

### 3.7 Proxy / Failover 逻辑

`/tmp/cc-switch/src-tauri/src/proxy/server.rs` 表明代理不是附属功能，而是独立运行时：

- 本地 HTTP 代理服务
- 请求头大小写保持、流式响应处理
- 路由到当前 provider
- 熔断与自动故障转移
- 使用日志、延迟、错误统计

这一层是 `CC Switch` 和当前 `CodePal` 最大的能力差。

### 3.8 Session 逻辑

`/tmp/cc-switch/src-tauri/src/session_manager/mod.rs` 说明它不是只读 Claude：

- 并行扫描 Codex / Claude / Gemini / OpenCode / OpenClaw
- 统一输出 SessionMeta / SessionMessage
- 统一删除接口

当前 `CodePal` 的 session browser 只覆盖 `~/.claude/projects`，是单工具实现。

## 4. 当前 CodePal 的现状

### 4.1 现有能力

从 [skill-manager/src/App.jsx](/Users/yunshu/Documents/trae_projects/skills/skill-manager/src/App.jsx) 看，当前已经有这些模块入口：

- Skills
- MCP
- Usage
- Claude Usage
- API Config
- Project Init
- Permission
- Network
- Sessions
- Doc Browser

这说明产品方向和 `CC Switch` 是重叠的，不是从零开始。

### 4.2 当前底座

从 [skill-manager/electron/main.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/main.js) 和 [skill-manager/electron/preload.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/preload.js) 看：

- 桌面壳是 Electron
- 主要能力通过 `ipcMain.handle` + `contextBridge` 暴露
- 偏好状态主要靠 `electron-store`
- 真实业务多数直接读写 CLI 配置文件

换句话说，`CodePal` 更像“多模块工具箱 + 文件操作器”，还不是“统一配置状态中心”。

### 4.3 供应商域现状

[registerProviderHandlers.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/handlers/registerProviderHandlers.js) 和 [providerSwitchService.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/services/providerSwitchService.js) 已经做了不少事：

- 支持内置 + 自定义 provider manifest
- 支持把 token 存到 `.env`
- 支持把 profile 写入 Claude settings
- 有回滚、备份、原子写入

但核心仍是：

- API 名是 `get-claude-provider` / `switch-claude-provider`
- 运行时仍以 Claude settings 为主
- `activeProviderEnvKey` 是 `CLAUDE_CODE_PROVIDER`

所以它的供应商域是“多 provider，单主工具”。

### 4.4 MCP 域现状

[registerMcpHandlers.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/handlers/registerMcpHandlers.js) 已经支持：

- Claude JSON 配置读写
- Codex TOML 配置读写
- 原子写入
- 版本检测

但当前模型还是：

- 直接面向配置文件
- 统一实体层很薄
- 没有中间数据库

### 4.5 Skills 域现状

`CodePal` 当前最强的域是 Skills：

- 中央仓库 + 多工具推送
- 自动增量导入
- 中央仓库变化自动同步
- 已支持 Claude / Codex / Cursor / Trae

这块和 `CC Switch` 的 SSOT 思路天然兼容，迁移成本最低。

### 4.6 Session 域现状

[sessionBrowserService.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/services/sessionBrowserService.js) 目前：

- 只读 Claude `~/.claude/projects`
- 以 JSONL 扫描、解析、摘要为主

和 `CC Switch` 的多 provider session manager 相比，差在“范围”而不是“方向”。

## 5. 差异结论

### 5.1 不是“功能少几个页面”，而是“底层建模不同”

`CC Switch` 的核心抽象：

- 先建统一实体
- 再按 app_type 做 live config 投影

当前 `CodePal` 的核心抽象：

- 先读写具体工具文件
- 再在 UI 上把它们组织成模块

这两者都能工作，但如果你要“完整搬 CCSwitch”，就必须往前者靠。

### 5.2 最重要的差距是 4 层

1. `统一状态层`
   - `CC Switch` 有 SQLite SSOT
   - `CodePal` 目前没有跨域统一存储
2. `多应用 provider 适配器`
   - `CC Switch` 以 `app_type` 为一等公民
   - `CodePal` 目前 provider 仍是 Claude-first
3. `运行时执行层`
   - `CC Switch` 有 proxy / failover / health / usage logs
   - `CodePal` 只有网络诊断，没有请求接管层
4. `统一跨工具会话/提示词/工作目录模型`
   - `CC Switch` 已经连 working directory 方案都在设计
   - `CodePal` 还主要是各模块独立长出来

### 5.3 也有很强的可复用基础

你不是从零开始，当前仓库里已经具备这些迁移优势：

- 已有桌面端外壳和多模块 UI
- 已有 Skills 中央仓库模型
- 已有 MCP 配置读写能力
- 已有 Provider registry 与 manifest 安全校验
- 已有会话浏览雏形
- 已有网络诊断与用量聚合

所以最现实的路线不是“重写一个 CC Switch”，而是“让 CodePal 长成自己的配置中台”。

## 6. 是否适合直接把 CC Switch 源码搬进来

### 6.1 法律上

- `CC Switch` 当前仓库 `package.json` 标注为 `MIT`，原则上可以参考和复用。

### 6.2 技术上

不建议做“硬搬”：

- 你现在是 Electron + JS/React
- 对方核心能力在 Rust/Tauri
- 直接搬源码会变成双技术栈并存，维护成本非常高
- 你当前仓库已有文件接近红线：
  - [main.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/main.js) 724 行
  - [preload.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/preload.js) 615 行

如果直接往现有壳里硬塞 `CC Switch` 逻辑，很容易把旧问题放大。

### 6.3 更好的理解方式

建议把 “搬 CC Switch” 理解成三件事：

1. 搬产品边界
2. 搬数据模型
3. 搬关键能力

不必搬技术栈。

## 7. 推荐迁移路线

### Phase 1：把 Provider 域改造成多应用 SSOT

目标：

- 从 `switch-claude-provider` 升级为 `switch-provider(appType, providerId)`
- 引入统一 `providers` 存储层
- 让 Claude / Codex / Gemini 的 provider 配置都走一套中间模型

这是第一刀，因为它是后续 Proxy、Usage、Working Directory 的前提。

### Phase 2：把 MCP / Skills / Prompts 纳入统一实体层

目标：

- Skills 保持现有中央仓库，但增加“启用状态”的统一管理
- MCP 从“两个文件编辑器”升级为“统一实体 + 按 app 投影”
- Prompts 增加统一模型，不再只靠静态模板或单页配置

这一步做完，`CodePal` 的中台味道就出来了。

### Phase 3：补运行时层

目标：

- 本地代理
- provider health
- failover queue
- 请求日志和成本日志

这一块是 `CC Switch` 最重的部分，也最适合最后上。

### Phase 4：补高级体验层

目标：

- Session 多工具统一浏览
- Working directory profile
- Deep Link 导入
- WebDAV / 云同步
- 托盘快速切换

这些是放大器，不是第一性依赖。

## 8. 具体建议：什么值得搬，什么不要搬

### 值得优先借鉴

- `按 app_type 建模` 的 provider / session / prompt / mcp 设计
- `SQLite 作为统一状态层`
- `Skill SSOT + sync method` 思路
- `统一实体 -> live config 投影` 模式
- `session manager` 的多工具解析接口

### 不建议原样照抄

- Tauri/Rust 目录结构本身
- 249 个 `tauri::command` 的命令面
- 代理实现里的所有 wire-level 细节
- 一次性覆盖全部 5 个 CLI 的产品范围

## 9. 实施优先级判断

如果你的目标是“让 CodePal 尽快像 CC Switch”，建议优先级这样排：

1. 多应用 Provider 中台
2. 统一 MCP / Skills / Prompts 实体层
3. 多工具 Session manager
4. Proxy / Failover
5. Working directory / Deep Link / Cloud sync

因为前 3 项能最快形成产品感知上的跨工具统一，而第 4 项才是工程最重的一层。

## 10. 反方理由

- 反方 1：直接继续在现有模块上补页面，也能逐步接近 `CC Switch`
  - 反驳：会越补越依赖具体文件格式，后续统一成本更高。
- 反方 2：既然 `CC Switch` 已经成熟，不如直接换壳或 fork
  - 反驳：你现有产品已有 Skills / 项目初始化 / 文档浏览等自己的路线，直接 fork 会丢产品主线。
- 反方 3：先上 Proxy 才最有“像 CC Switch”的感觉
  - 反驳：没有统一 provider / app 状态层，Proxy 会先把复杂度引爆。

## 11. 方法论局限

- 本轮是源码级静态调研，没有启动 `CC Switch` 做运行时抓包。
- 没有对 `CC Switch` 全量 249 个命令逐个溯源，只阅读了关键模块。
- 对你后续要不要把 `Prompt` / `Workspace` / `OpenClaw` 也纳入产品主线，还需要你自己的产品取舍。

## 12. 下一步建议

- 先看 [PHASE-1-BLUEPRINT.md](/Users/yunshu/Documents/trae_projects/skills/skill-manager/docs/research/cc-switch-migration/PHASE-1-BLUEPRINT.md)，确认你是否接受“先把 Provider 域改成多应用中台”这个第一刀。
- 如果你点头，下一轮我建议直接开始改造：
  - 新建 provider SSOT 服务层
  - 拆现有 `switch-claude-provider`
  - 给 Codex / Gemini 预留 live config adapter 接口

## 13. 可复用的方法论

以后你再想“把某个成熟桌面工具搬进 CodePal”，可以继续用这个顺序：

1. 先识别它的 SSOT 是什么
2. 再识别它的 live config adapter 是什么
3. 再识别它的运行时执行层是可选还是必需
4. 最后才决定 UI 怎么抄、功能怎么排期

这比按页面抄更稳。
