# Phase 1 蓝图：先把 Provider 域迁成多应用中台

## 1. 目标

第一阶段不追求“看起来像 CC Switch”，而追求一个更关键的目标：

- 让 `CodePal` 的 Provider 域不再是 `Claude-first`
- 建立后续 MCP / Prompts / Proxy / Session 都能复用的“统一状态层”

只要这一步做对，后面每新增一个工具，就不会再从 UI 到配置文件整条链重写一次。

## 2. 为什么从 Provider 开刀

因为当前仓库里最明确的单点瓶颈就是：

- [registerProviderHandlers.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/handlers/registerProviderHandlers.js) 的公开 API 仍然是 `get-claude-provider` / `switch-claude-provider`
- [providerSwitchService.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/services/providerSwitchService.js) 的运行时写入目标还是 Claude settings

只要这个域还是单工具中心，其它统一能力都会卡住。

## 3. 设计原则

### 3.1 不直接把状态塞回 `main.js`

[main.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/main.js) 已经 724 行，接近 800 行红线。

所以第一阶段必须新增独立模块，避免继续把逻辑堆在入口层。

### 3.2 先做“统一模型”，后做“统一存储”

第一阶段可以分两小步：

1. 先抽象 Provider Domain Model
2. 再决定持久化先用 JSON 还是直接上 SQLite

如果你希望尽快进入实现，建议直接上 SQLite，省掉一次过渡层重构。

### 3.3 不要求一次覆盖 5 个 CLI

推荐首批覆盖：

- Claude
- Codex
- 预留 Gemini

Cursor / Trae 当前在你的产品里更像 Skills 容器，不必第一阶段强行纳入 Provider 域。

## 4. 目标架构

```text
Renderer(UI)
  -> preload API
  -> provider application service
  -> provider repository (SQLite / local DB)
  -> app-specific live config adapters
       - claude adapter
       - codex adapter
       - gemini adapter
```

关键变化：

- UI 不再直接理解 Claude 配置格式
- 供应商切换先改库，再由 adapter 投影到真实配置文件

## 5. 建议新增模块

### Electron 层

建议新增：

- `electron/services/providerStateStore.js`
  - Provider 实体的持久化与查询
- `electron/services/providerAdapterService.js`
  - 按 appType 调度不同 live config adapter
- `electron/services/providerAdapters/claudeAdapter.js`
  - 承接当前 `claudeSettingsService`
- `electron/services/providerAdapters/codexAdapter.js`
  - 新增 Codex live config 写入
- `electron/services/providerDomainService.js`
  - list / add / update / delete / switch / detect current

建议保留但降级为内部依赖：

- [claudeSettingsService.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/services/claudeSettingsService.js)
- [envFileService.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/services/envFileService.js)
- [providerSwitchService.js](/Users/yunshu/Documents/trae_projects/skills/skill-manager/electron/services/providerSwitchService.js)

### Renderer 层

建议调整：

- [ApiConfigPage.jsx](/Users/yunshu/Documents/trae_projects/skills/skill-manager/src/pages/ApiConfigPage.jsx)

把它从：

- “Claude provider 配置页”

升级成：

- “多应用 provider 配置页”

第一阶段不必重做 UI，可以先增加 `activeApp` 切换和按 app 查询。

## 6. 建议数据模型

如果第一阶段直接上 SQLite，最小可行表结构建议：

```sql
providers (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT,
  token_env_key TEXT,
  base_url_env_key TEXT,
  model TEXT,
  settings_env_json TEXT NOT NULL DEFAULT '{}',
  sort_index INTEGER,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  is_current INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, app_type)
)
```

再配一张：

```sql
provider_secrets (
  provider_id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  token TEXT,
  PRIMARY KEY (provider_id, app_type)
)
```

这样做的好处：

- 配置元信息和敏感 token 分离
- 将来能迁到系统钥匙串或安全存储

## 7. 兼容迁移策略

### 7.1 启动时导入旧状态

首次启动新 Provider 中台时：

1. 读取当前 `.env`
2. 读取当前 Claude settings
3. 读取现有 provider registry
4. 生成默认 provider records
5. 标记当前 app 的 current provider

### 7.2 旧 API 先兼容

第一阶段不要马上删老 API。

做法：

- `switch-claude-provider` 继续保留
- 内部改成调用 `switch-provider('claude', providerId)`

这样可以减少 UI 连带改动范围。

## 8. 第一阶段的明确不做

- 不做本地代理
- 不做 failover queue
- 不做请求日志
- 不做 working directory profile
- 不做 deep link
- 不做云同步

只把 Provider 域从单工具改造成多工具。

## 9. 第一阶段验收标准

- 能按 app 查询 provider 列表
- 能分别切换 Claude / Codex 的当前 provider
- 当前 provider 状态不再依赖单一 `CLAUDE_CODE_PROVIDER`
- UI 可以看到“当前在哪个 app 下管理 provider”
- 旧 Claude 切换链仍可工作
- 所有写入仍保持原子写与回滚

## 10. 建议实施顺序

1. 新增 provider domain model 和 appType 枚举
2. 新增 provider state store
3. 把现有 Claude provider registry 接入 state store
4. 抽 `switch-provider(appType, providerId)` 新 IPC
5. 保留旧 `switch-claude-provider` 作为兼容别名
6. UI 增加 app 维度切换
7. 再补 Codex adapter

## 11. 风险提示

最大的风险不是代码量，而是“过渡期双真源”：

- 一边是旧 `.env + Claude settings`
- 一边是新 provider state store

所以第一阶段一定要明确：

- 新 store 是 SSOT
- 旧配置文件只是 live projection

只要这条不摇摆，后面就好收。
