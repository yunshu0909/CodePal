# Provider Registry MCP 服务构成

## 目录说明

- `mcp/provider_registry_mcp.js`
  - MCP 主服务（stdio / JSON-RPC）
  - 暴露 `register_provider`、`list_providers`
- `mcp/provider_registry_mcp_smoke.js`
  - 冒烟测试脚本（initialize/list/register/update）
- `electron/services/providerRegistryService.js`
  - 渠道定义校验与注册表读写逻辑
- `electron/services/providerRegistryPathService.js`
  - 注册表路径解析逻辑（共享路径 / 环境变量覆盖）
- `package.json`
  - MCP 运行命令：`mcp:provider-registry`、`mcp:provider-registry:smoke`
- `README.md`
  - 项目说明与 MCP 运行说明
- `docs/prd/PRD-Skill-Manager-V0.10-MCP-渠道注册中心.md`
  - V0.10 PRD

## 运行入口

```bash
npm run mcp:provider-registry
```

## 健康检查

```bash
npm run mcp:provider-registry:smoke
```
