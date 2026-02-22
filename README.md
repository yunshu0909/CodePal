# CodePal — 你的 AI 编程搭档

一个桌面应用，帮你把 Claude Code、Cursor、CodeX 等 AI 编程工具从"能用"变成"好用"。统一管理 Skills、监控用量、切换 API 供应商、配置 MCP 服务，一个面板搞定。

## 核心功能

### 1) Skills 管理（导入 / 推送 / 停用）

- 扫描 Claude Code、CodeX、Cursor、Trae 的 Skills
- 导入到中央仓库统一管理
- 一键批量推送或停用到多个工具
- 支持自定义路径和自动增量刷新（仅新增）

### 2) 用量监测（Token 统计）

- 按 今日 / 近 7 天 / 近 30 天查看 Token 用量
- 自动聚合 Claude 与 CodeX 日志
- 查看模型分布和明细，辅助成本与使用行为分析

### 3) API 配置（供应商切换）

- 在 Claude Official / Kimi / AICodeMirror 之间切换
- 保存第三方 API Key 到 `.env`
- 统一维护当前接入配置，减少手动改环境变量的成本
- 支持通过 MCP 动态注册/查询渠道（V0.10）

## 这个工具能做什么

- 把多个来源的 Skills 导入到一个中央仓库
- 在一个页面里批量推送/停用 Skills 到多个工具
- 支持自定义导入路径（例如团队共享目录）
- 自动增量刷新导入来源（只新增，不覆盖、不删除）
- 统计 Claude / CodeX 的 Token 用量（今日 / 近 7 天 / 近 30 天）
- 切换 Claude API 供应商（Official / Kimi / AICodeMirror）

## 技术栈

- Electron `^40.2.1`
- React `^19.2.4`
- Vite `^7.3.1`

## 目录结构

```text
skill-manager/
├── electron/                  # 主进程与 IPC
│   ├── main.js
│   ├── preload.js
│   ├── logScanner.js
│   └── scanLogFilesHandler.js
├── src/                       # 渲染进程
│   ├── App.jsx
│   ├── components/
│   ├── pages/
│   └── store/
├── 自动化测试/                 # 分版本测试计划与配置
├── .env.example               # API 供应商示例配置
└── package.json
```

## 环境要求

- Node.js 18+（建议 20 LTS）
- npm 9+
- macOS / Linux（路径默认使用 `~/...` 形式）

## 安装与启动

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动：

- Vite 开发服务器
- Electron 主进程（自动加载前端页面）

## 构建

```bash
npm run build
```

构建产物在 `dist/`。  
注意：当前仓库只包含前端构建脚本，没有配置 `electron-builder` / `electron-forge`，不会直接产出 `.dmg/.exe` 安装包。

## 使用说明（从 0 到 1）

### 1. 首次打开：导入页面

当中央仓库没有任何 Skill 时，应用会进入“导入”页。

你可以选择导入来源：

- 预设工具目录：
  - `~/.claude/skills/`
  - `~/.codex/skills/`
  - `~/.cursor/skills/`
  - `~/.trae/skills/`
- 自定义路径（通过弹窗添加）

### 2. 添加自定义路径（可选）

自定义路径不是直接指向 `skills` 目录，而是一个“根目录”，工具会自动扫描以下子目录：

- `.claude/skills/`
- `.codex/skills/`
- `.cursor/skills/`
- `.trae/skills/`

示例：

```text
~/team-skills/
  ├── .claude/skills/xxx/SKILL.md
  └── .codex/skills/yyy/SKILL.md
```

### 3. 设置中央仓库（可选）

默认中央仓库路径：

```text
~/Documents/SkillManager/
```

可在导入页修改，工具会尝试迁移已有 Skill。

### 4. 执行导入

- 导入规则：按 Skill 文件夹名去重，后导入覆盖先导入
- 成功后进入管理页
- 首次导入后会自动初始化“推送目标”

### 5. 管理页：推送与停用

在管理页可以：

- 查看中央仓库 Skills（支持搜索）
- 单条切换状态（推送/停用）
- 批量推送、批量停用
- 查看全局推送状态（按已启用推送目标聚合）

### 6. 配置页：导入来源与推送目标

在配置页可以：

- 选择哪些来源用于后续自动增量刷新
- 选择推送目标工具（至少保留 1 个）
- 新增/删除自定义路径

保存配置时，如果新增了自定义路径，会自动执行一次“增量导入（仅新增不覆盖）”。

### 7. 用量监测页

支持统计：

- 今日
- 近 7 天（不含今日）
- 近 30 天（不含今日）

数据来源：

- Claude 日志：`~/.claude/projects/**/*.jsonl`
- CodeX 日志：`~/.codex/sessions/**/*.jsonl`

说明：

- 日志扫描按时间窗口处理，超大目录会触发截断保护（防止卡死）
- “今日”数据会自动刷新；7/30 天按日批次刷新

### 8. API 配置页（Claude Provider）

可切换：

- Claude Official
- Kimi For Coding
- AICodeMirror

第三方供应商可在页面保存 API Key，写入项目根目录 `.env`。

### 9. MCP 渠道注册服务（V0.10）

已提供两个 MCP Tool：

- `register_provider`：注册或更新渠道定义
- `list_providers`：查询当前可用渠道（内置 + 自定义）
- `list_providers` 返回字段已与注册字段对齐：`baseUrl`、`tokenEnvKey`、`baseUrlEnvKey`、`model`、`settingsEnv`、`uiUrl`（同时保留 `url` 兼容字段）

默认注册表文件：

- `~/Documents/SkillManager/.provider-manifests.json`

可选环境变量覆盖：

- `SKILL_MANAGER_PROVIDER_REGISTRY_PATH`：直接指定注册表文件路径
- `SKILL_MANAGER_SHARED_HOME`：指定 SkillManager 共享目录（注册表会落在该目录下）

运行方式：

```bash
npm run mcp:provider-registry
```

快速自检：

```bash
npm run mcp:provider-registry:smoke
```

## 配置与数据文件

### 中央仓库配置文件

配置文件名：`.config.json`  
位置：当前中央仓库路径下（默认 `~/Documents/SkillManager/.config.json`）

典型结构：

```json
{
  "version": "0.4",
  "repoPath": "~/Documents/SkillManager/",
  "customPaths": [],
  "pushStatus": {},
  "pushTargets": ["claude-code", "codex", "cursor", "trae"],
  "importSources": [],
  "firstEntryAfterImport": false
}
```

### API 环境变量（.env）

参考 `.env.example`：

```env
KIMI_API_KEY=your_kimi_api_key_here
KIMI_BASE_URL=https://api.kimi.com/coding/

AICODEMIRROR_API_KEY=your_aicodemirror_api_key_here
AICODEMIRROR_BASE_URL=https://api.aicodemirror.com/api/claudecode
```

切换档位时会写入：

- `CLAUDE_CODE_PROVIDER=official|kimi|aicodemirror`

## 可用脚本

```bash
# 开发
npm run dev

# 构建
npm run build
npm run preview

# 单元测试（分版本）
npm run test:v04
npm run test:v05
npm run test:v06
npm run test:v07

# E2E（分版本）
npm run test:e2e:v04
npm run test:e2e:v05
npm run test:e2e:v06
npm run test:e2e:v07

# 全量组合（示例）
npm run test:v04:all
npm run test:v05:all
npm run test:v06:all
npm run test:v07:all

# MCP（V0.10）
npm run mcp:provider-registry
npm run mcp:provider-registry:smoke
```

## 常见问题

### 1) 导入页显示“目录不存在”

确认对应工具是否真的有该目录，例如：

- `~/.codex/skills/`
- `~/.claude/skills/`

### 2) 自定义路径添加后显示“未找到 skills 目录”

确认你选择的是“根目录”，且内部包含 `.claude/skills` 或 `.codex/skills` 等结构。

### 3) 推送/停用失败（权限问题）

通常是目标目录没有写权限。检查工具目录权限后重试。

### 4) API 供应商切换失败

先在 API 配置页保存对应供应商的 API Key，再执行切换。

## 开发说明

- 渲染进程通过 `window.electronAPI` 调用主进程 IPC
- 主进程负责文件系统操作、日志扫描、环境变量读写
- 关键模块：
  - `src/store/data.js`：导入/推送/配置核心逻辑
  - `electron/main.js`：IPC 实现
  - `src/store/usageAggregator.js`：用量聚合逻辑

## 发 Git 前建议

- 确认 `.env` 未提交（已在 `.gitignore` 中）
- 确认 `dist/`、`node_modules/` 未提交（已在 `.gitignore` 中）
- 至少跑一组核心测试（如 `npm run test:v07`）
- 若要发可安装包，需要额外引入 Electron 打包方案

## License

ISC
