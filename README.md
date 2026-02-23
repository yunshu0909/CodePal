# Coding Assistant

一个面向日常开发的桌面编程助手（Electron + React），统一管理多个 AI 编程工具的 Skills、MCP 配置、用量监控和 API 供应商。

支持工具：**Claude Code** · **CodeX** · **Cursor** · **Trae** · **Droid (Factory/Kiro)**

## 功能模块

### 1. Skills 管理

- 扫描 Claude Code、CodeX、Cursor、Trae、Droid 的 Skills 目录
- 导入到中央仓库统一管理，支持自定义导入路径
- 一键批量推送或停用到多个工具
- 每 5 分钟自动增量刷新（仅新增，不覆盖）

### 2. MCP 管理

- 集中展示所有工具的 MCP 配置
- 一键启用/停用 MCP 到各工具
- 搜索过滤，统计各工具启用数量
- 支持 Claude Code、CodeX、Cursor、Droid

### 3. 新建项目

- 项目初始化向导（名称、路径、Git 模式、模板选择）
- 实时预览目录结构
- 模板：AGENTS.md、CLAUDE.md、design-system

### 4. 用量监测

- 按 今日 / 近 7 天 / 近 30 天 查看 Token 用量
- 自动聚合 Claude、CodeX、Droid 日志
- 模型分布和明细，辅助成本与使用行为分析

### 5. API 配置

- Claude 供应商切换：Official / Kimi / AICodeMirror / MCP 动态注册
- 模型分级配置（modelTiers）：每个模型可设置 Sonnet/Haiku 降级
- Droid 多服务商管理：按 base_url + api_key 分组，支持模板生成和 JSON 导入导出
- 保存 API Key 到 `.env`，统一维护接入配置

### 6. 启动模式

- 配置 Claude Code 的权限模式
- 模式选项：plan (只读) → default (询问) → acceptEdits (自动编辑) → bypassPermissions (全自动)
- 直接修改 `~/.claude/settings.json`

### 7. MCP Provider Registry

通过 MCP 动态注册/查询 API 渠道：

- `register_provider`：注册或更新渠道定义
- `list_providers`：查询当前可用渠道（内置 + 自定义）

```bash
npm run mcp:provider-registry        # 启动 MCP 服务器
npm run mcp:provider-registry:smoke   # 快速自检
```

## 技术栈

| Tech | Version |
|------|---------|
| Electron | 40.2.1 |
| React | 19.2.4 |
| Vite | 7.3.1 |
| Testing | Vitest + Playwright |
| Packaging | electron-builder (DMG) |

## 安装与启动

```bash
npm install
npm run dev
```

`npm run dev` 同时启动 Vite 开发服务器和 Electron 主进程。

## 构建与打包

```bash
npm run build          # 仅前端构建
npm run dist:mac       # 打包 macOS DMG
npm run pack           # 打包但不生成安装包（调试用）
```

## 目录结构

```
Coding-Assistant/
├── electron/          # 主进程、IPC handler、日志扫描
├── src/               # 渲染进程
│   ├── pages/         # 各功能页面
│   ├── components/    # 共享组件
│   └── store/         # 状态管理、数据聚合
├── mcp/               # MCP Provider Registry 服务
├── 自动化测试/         # V0.4 ~ V0.12 分版本测试
└── .env.example       # API 配置示例
```

## 环境变量

参考 `.env.example`：

```env
KIMI_API_KEY=your_kimi_api_key_here
KIMI_BASE_URL=https://api.kimi.com/coding/
AICODEMIRROR_API_KEY=your_aicodemirror_api_key_here
AICODEMIRROR_BASE_URL=https://api.aicodemirror.com/api/claudecode
```

## 数据文件

| 文件 | 位置 |
|------|------|
| 中央仓库 | `~/Documents/SkillManager/` |
| 仓库配置 | `~/Documents/SkillManager/.config.json` |
| 供应商注册表 | `~/Documents/SkillManager/.provider-manifests.json` |
| Claude 日志 | `~/.claude/projects/**/*.jsonl` |
| CodeX 日志 | `~/.codex/sessions/**/*.jsonl` |
| Droid 日志 | `~/.factory/sessions/**/*.settings.json` |

## 测试

```bash
npm run test:v07       # 单元测试（V0.7）
npm run test:e2e:v07   # E2E 测试（V0.7）
npm run test:v12:all   # 最新版全量测试
```

## License

ISC
