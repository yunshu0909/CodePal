# 产品需求文档：Skill Manager V0.10（MCP 渠道注册中心）

> 文档版本：v0.10-r3  
> 创建日期：2026-02-19  
> 对应模块：`skill-manager/electron/handlers/registerProviderHandlers.js`、`skill-manager/electron/services/providerRegistryService.js`、`skill-manager/electron/services/providerRegistryPathService.js`、`skill-manager/mcp/provider_registry_mcp.js`

---

## 1. 背景与目标

当前“API 配置”页面新增渠道需要改代码发布。  
目标是让多个 Agent 可以通过统一 MCP 规范完成渠道接入，最小化人工改代码频率。

V0.10 只做两个 MCP 能力：

1. `register_provider`：注册/修改一个渠道定义
2. `list_providers`：查询当前可用渠道（内置 + 自定义）

---

## 2. 范围

### 2.1 In Scope（V0.10 必做）

- 定义并实现 `register_provider`、`list_providers` 两个 tool
- 渠道定义持久化到本地注册表
- API 配置页按动态渠道列表渲染
- 渠道定义安全校验（字段格式 + settingsEnv 白名单）
- App 与 MCP 统一读取同一注册表路径（避免“写到 A、读 B”）
- API 配置相关读取动作每次从磁盘刷新渠道定义（确保 MCP 更新后可见）

### 2.2 Out of Scope（V0.10 不做）

- `save_provider_token` MCP 化
- `switch_provider` MCP 化
- 渠道删除接口
- 多注册表来源合并（远端仓库/团队中心）

---

## 3. 核心用户故事

### US-01（Agent 视角）

作为一个接入 Agent，我希望通过一次 `register_provider` 调用就能新增或更新渠道定义，避免修改业务代码。

### US-02（运营视角）

作为产品维护者，我希望通过 `list_providers` 立即看到已生效渠道，确认接入是否成功。

---

## 4. MCP Tool 契约

## 4.1 `register_provider`

### 入参（建议）

```json
{
  "id": "neo-proxy",
  "name": "NeoProxy Gateway",
  "baseUrl": "https://api.neoproxy.dev/anthropic",
  "tokenEnvKey": "NEO_PROXY_API_KEY",
  "baseUrlEnvKey": "NEO_PROXY_BASE_URL",
  "model": "opus",
  "settingsEnv": {
    "ANTHROPIC_MODEL": "neoproxy-opus"
  },
  "icon": "N",
  "color": "#2563eb",
  "uiUrl": "https://api.neoproxy.dev/anthropic"
}
```

### 出参（建议）

```json
{
  "success": true,
  "provider": {
    "id": "neo-proxy",
    "name": "NeoProxy Gateway",
    "url": "https://api.neoproxy.dev/anthropic",
    "icon": "N",
    "color": "#2563eb",
    "supportsToken": true,
    "source": "custom"
  },
  "error": null,
  "errorCode": null
}
```

### 业务语义

- `id` 是唯一主键
- V0.10 目标语义：`upsert`（同 id 可更新）
- 禁止覆盖内置渠道 id：`official`/`qwen`/`kimi`/`aicodemirror`

---

## 4.2 `list_providers`

### 入参

- 无

### 出参（建议）

```json
{
  "success": true,
  "providers": [
    {
      "id": "official",
      "name": "Claude Official",
      "url": "https://www.anthropic.com/claude-code",
      "uiUrl": "https://www.anthropic.com/claude-code",
      "baseUrl": "",
      "tokenEnvKey": null,
      "baseUrlEnvKey": null,
      "model": "opus",
      "settingsEnv": {},
      "icon": "A",
      "color": "#6b5ce7",
      "supportsToken": false,
      "source": "builtin"
    },
    {
      "id": "neo-proxy",
      "name": "NeoProxy Gateway",
      "url": "https://api.neoproxy.dev/anthropic",
      "uiUrl": "https://api.neoproxy.dev/anthropic",
      "baseUrl": "https://api.neoproxy.dev/anthropic",
      "tokenEnvKey": "NEO_PROXY_API_KEY",
      "baseUrlEnvKey": "NEO_PROXY_BASE_URL",
      "model": "opus",
      "settingsEnv": {
        "ANTHROPIC_MODEL": "neoproxy-opus"
      },
      "icon": "N",
      "color": "#2563eb",
      "supportsToken": true,
      "source": "custom"
    }
  ],
  "error": null,
  "errorCode": null
}
```

---

## 5. 校验与安全规则

### 5.1 字段校验

- `id`：`^[a-z][a-z0-9-]{1,31}$`
- `name`：必填，长度 <= 80
- `baseUrl`：必须是 `http/https`
- `tokenEnvKey` / `baseUrlEnvKey`：`^[A-Z][A-Z0-9_]{1,63}$`
- `color`：`#RRGGBB`
- `icon`：长度 <= 2

### 5.2 安全白名单

- `settingsEnv` 仅允许 `ANTHROPIC_*` 前缀
- 非白名单 key 直接拒绝（防止借渠道注册写入任意敏感 env）

---

## 6. 错误码（V0.10）

- `INVALID_MANIFEST`
- `INVALID_PROVIDER_ID`
- `RESERVED_PROVIDER_ID`
- `CONFLICT_ID`（若未启用 upsert）
- `INVALID_BASE_URL`
- `INVALID_TOKEN_ENV_KEY`
- `UNSAFE_SETTINGS_ENV_KEY`
- `REGISTRY_READ_FAILED`
- `REGISTRY_WRITE_FAILED`

---

## 7. 数据存储

- 默认注册表文件：`~/Documents/SkillManager/.provider-manifests.json`
- 可选环境变量覆盖：
  - `SKILL_MANAGER_PROVIDER_REGISTRY_PATH`（直接指定注册表文件路径）
  - `SKILL_MANAGER_SHARED_HOME`（指定共享目录，注册表文件落在该目录下）
- 建议格式：

```json
{
  "schemaVersion": 1,
  "providers": []
}
```

---

## 8. 验收标准（DoD）

1. 调用 `register_provider` 后，`list_providers` 可看到新增渠道。  
2. API 配置页可显示新增渠道卡片（无需新增前端硬编码）。  
3. 非法 `settingsEnv`（如 `OPENAI_API_KEY`）会被拒绝。  
4. 内置渠道不可被覆盖。  
5. 注册表文件写入失败时返回明确错误码。
6. 打包应用与 MCP 使用同一注册表文件路径。  
7. 已发布版本在“不改代码”的前提下，仅通过 MCP 更新注册表即可让渠道在 UI 中可见（页面刷新或重开后）。

---

## 9. 当前 MVP 验证结论（2026-02-19）

已验证：

- 注册新渠道后，列表数量从 4 -> 5
- 新渠道可被 `list` 返回并用于页面展示
- 非白名单 `settingsEnv` 返回 `UNSAFE_SETTINGS_ENV_KEY`
- MCP smoke 通过：`initialize -> tools/list -> register_provider -> list_providers -> register_provider(update)`
- `register_provider` 在 Claude Code / Codex 均可连通并执行
- 注册表路径统一为 `~/Documents/SkillManager/.provider-manifests.json`
- `list_providers` 已对齐写入字段，返回 `baseUrl/tokenEnvKey/baseUrlEnvKey/model/settingsEnv/uiUrl`，并保留 `url` 兼容旧前端

当前差异：

- Electron 内部调试入口 `register-provider-manifest` 仍保持 create-only（`CONFLICT_ID`）
- MCP 正式入口 `register_provider` 已实现 upsert（`mode=created|updated`）

---

## 12. 发版与后续更新规则

### 12.1 何时需要重新 `npm run build`

- 需要 build：修改 App/MCP 代码逻辑（例如校验规则、协议处理、UI 交互）
- 不需要 build：仅新增/更新渠道定义数据（通过 `register_provider` 写注册表）

### 12.2 目标运行形态

- 发版后应用读取共享注册表
- Agent 通过 MCP 写入同一注册表
- 用户无需因“新增渠道”再次发版，只需刷新页面或重开应用会话即可看到新渠道

---

## 10. 什么算“由 MCP 生成”

满足以下条件可判定为“由 MCP 生成”：

1. 渠道定义由 `register_provider`（或其同义 MCP tool）写入注册表，而非手改代码。  
2. 结果可被 `list_providers` 读取并返回。  
3. API 配置页显示该渠道来源为 `custom`，且在应用重启后仍存在。  

不算 MCP 生成的情况：

- 直接改 `ApiConfigPage.jsx` 或 `registerProviderHandlers.js` 硬编码渠道  
- 只改内存态、未写入注册表文件  
- 只改 `.env` 或 `~/.claude/settings.json`，没有注册渠道定义

---

## 11. MCP 调用示例（给 Agent）

### 11.1 `list_providers` 示例

请求：

```json
{
  "method": "tools/call",
  "params": {
    "name": "list_providers",
    "arguments": {}
  }
}
```

返回（节选）：

```json
{
  "success": true,
  "providers": [
    {
      "id": "official",
      "name": "Claude Official",
      "url": "https://www.anthropic.com/claude-code",
      "uiUrl": "https://www.anthropic.com/claude-code",
      "baseUrl": "",
      "tokenEnvKey": null,
      "baseUrlEnvKey": null,
      "model": "opus",
      "settingsEnv": {},
      "icon": "A",
      "color": "#6b5ce7",
      "supportsToken": false,
      "source": "builtin"
    },
    {
      "id": "neo-proxy",
      "name": "NeoProxy Gateway",
      "url": "https://api.neoproxy.dev/anthropic",
      "uiUrl": "https://api.neoproxy.dev/anthropic",
      "baseUrl": "https://api.neoproxy.dev/anthropic",
      "tokenEnvKey": "NEO_PROXY_API_KEY",
      "baseUrlEnvKey": "NEO_PROXY_BASE_URL",
      "model": "opus",
      "settingsEnv": {
        "ANTHROPIC_MODEL": "neoproxy-opus"
      },
      "icon": "N",
      "color": "#2563eb",
      "supportsToken": true,
      "source": "custom"
    }
  ]
}
```

### 11.2 `register_provider` 示例

请求：

```json
{
  "method": "tools/call",
  "params": {
    "name": "register_provider",
    "arguments": {
      "id": "neo-proxy",
      "name": "NeoProxy Gateway",
      "baseUrl": "https://api.neoproxy.dev/anthropic",
      "tokenEnvKey": "NEO_PROXY_API_KEY",
      "model": "opus",
      "settingsEnv": {
        "ANTHROPIC_MODEL": "neoproxy-opus"
      },
      "icon": "N",
      "color": "#2563eb"
    }
  }
}
```

返回（创建）：

```json
{
  "success": true,
  "mode": "created",
  "provider": {
    "id": "neo-proxy",
    "source": "custom"
  }
}
```

返回（更新同 id）：

```json
{
  "success": true,
  "mode": "updated",
  "provider": {
    "id": "neo-proxy",
    "source": "custom"
  }
}
```

返回（安全拦截）：

```json
{
  "success": false,
  "errorCode": "UNSAFE_SETTINGS_ENV_KEY",
  "error": "settingsEnv key 不在白名单内: OPENAI_API_KEY"
}
```
