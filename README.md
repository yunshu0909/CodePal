# CodePal — AI 编程的幕后助手

> AI 编程工具负责写代码，CodePal 负责写代码之外的一切 —— Skills 调度、账户切换、额度监控、对话回顾、跨工具统一管理。专为 **Claude Code / Codex / Cursor / Trae** 用户打造。

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple)](https://github.com/yunshu0909/CodePal/releases) [![version](https://img.shields.io/badge/version-v1.6.3-blue)](https://github.com/yunshu0909/CodePal/releases/latest) [![license](https://img.shields.io/badge/license-ISC-green)](#license)

---

## 为什么需要 CodePal？

用 AI 写代码是起点，写代码之外的"管理"才是日常摩擦：

- 几十个 **Skills** 要在 Claude Code / Codex / Cursor 多个工具之间同步 —— 改一处要到处改
- **多个 Codex 账户**额度用完就得重新登录（手工 1-2 分钟，一天切 N 次）
- 想知道这个月 **Token 花了多少钱**、哪个模型最费
- 找不到上次和 AI 聊过的某条历史对话，翻不到 Session 目录
- 新项目想要标准的 `CLAUDE.md` / `.gitignore`，每次手动抄

**没有一个 AI 工具会帮你做跨工具的事** —— Claude Code 不管 Codex，Codex 不管 Cursor。CodePal 做的就是它们之间的**连接层**，让 AI 工具各自专注写代码，其他的交给 CodePal。

---

## 功能一览

CodePal 按使用场景分 4 组：**账户与用量 · 文档 · 技能中心 · 工具设置**。每项都是独立模块，按需使用。

### 🔋 账户与用量

监控 AI 工具的用量、额度和多账户状态，触顶前就知道。

#### Codex 账户 · 多账户切换并重启 <sup>✨ v1.5.0 新增 / v1.6.3 Debug 加固</sup>

![Codex Accounts](docs/screenshots/codex-accounts.png)

**痛点**：Codex Plus / Pro 按 5 小时 + 7 天双窗口限额，一触顶就得 Logout → 换邮箱 → 重登 → 二次验证，1-2 分钟还得记密码。

**能做**：
- 切换已保存账户时自动完整退出并重新打开 Codex，确保新账户立即生效
- 登录新账户时 CodePal 自动检测并提示保存（chokidar 监听 `~/.codex/auth.json`）
- **v1.6.3 起：重启切换加固**——识别 Codex.app 主进程、Helper、app-server 及子进程，退出失败会取消切换，避免旧进程把旧账号写回
- **v1.6.2 起：凭证主动保活**——每 24h 后台续签躺着的账户 token，切回去不再 401
- 5h / 7d 窗口**本地倒计时**估算 + 套餐标签 + 上次切入时间
- 重命名 / 删除（自动留 7 天冷备份）

**关于凭证保活的隐私声明（v1.6.2 起）**：

为了避免 Codex 账户长时间不用导致 token 过期，CodePal 自 v1.6.2 起会**在你本机**调 OpenAI 官方 codex CLI 同款的 OAuth refresh endpoint（`auth.openai.com/oauth/token`）来续签账户 token。**只用你本地 `~/.codex-switcher/accounts/` 里的 refresh_token、不上传任何凭证、不代理任何模型推理**。请求 User-Agent 显式标识为 `CodePal/<version>`，不伪装成官方 CLI。如果你不需要这项能力或者你的环境对外网请求敏感，可以在登录失效时点卡片上的「重新登录」手动恢复。

#### Claude 会员额度 · 状态栏双向同步

![Claude Usage](docs/screenshots/claude-usage.png)

自动接入 Claude Code 官方 `rate_limits`，展示 5h / 7d 剩余额度 + 距重置时间 + 满载率趋势，可配置到 Claude Code 底部状态栏。

- 色阶断点：&lt;60% 绿 / 60-85% 黄 / ≥85% 红
- 满载率趋势：基于最近 4 周完成的 7d 周期峰值
- 状态栏显示模式：总是显示 / 达阈值才显示 / 关闭

#### 用量监测 · 花了多少一目了然

![Usage Monitor](docs/screenshots/usage-monitor.png)

聚合 Claude Code 的 Token 用量 + 费用估算，按日/周/月统计，按模型和按项目分布可视化。

- 按模型/按项目分布图
- **预估费用**基于 pricing.json（内置定价表，远程可更新）
- 日期范围自定义

---

### 📚 文档

### 对话回顾 · 找得到也重启得了

![Session Browser](docs/screenshots/sessions.png)

浏览 Claude Code 的所有历史 Session，按项目分组 + 全文搜索。v1.4.5 起支持：

- 📋 **复制 resume 参数**：一键复制 `cd "..." && claude --resume <uuid>`，粘到任意终端接着聊
- ⚡ **新终端启动**：osascript 直接起 macOS Terminal 打开原项目目录 + `claude --resume`

每条消息支持 Markdown 渲染（包括代码块、链接、图片引用）。

### 文档查阅 · 多目录 Markdown 浏览

![Doc Browser](docs/screenshots/doc-browser.png)

添加多个文件夹作为根目录，展开成 N 层目录树，内置 Markdown 渲染器，拖拽分栏调宽度。

---

### 🛠 技能中心

#### Skills 管理 · 写一次，到处用

![Skills](docs/screenshots/skills.png)

从任意工具扫描导入到中央仓库，一键推送到所有工具，改一处全局生效。

- 扫描 `~/.claude/skills/` / `~/.codex/skills/` / `~/.cursor/skills/` + 自定义路径
- 按标签筛选（编程 / 内容 / 自定义）+ 搜索
- 批量推送 / 停用 / 标签管理
- **自动增量刷新**：每 5 分钟检测新增 skill 自动同步

#### MCP 管理

按工具查看和管理 MCP 服务的启用/停用状态，不用手动编辑 JSON。

---

### ⚙️ 工具设置

#### 启动模式 · 4 种权限一键切

![Permission Modes](docs/screenshots/permission-modes.png)

配置 Claude Code 的默认权限和推理等级，下次启动自动生效：

| 模式 | 行为 |
|---|---|
| 只读规划 | 只读文件不执行任何操作 |
| 每次询问 | 每次执行前都要确认（默认） |
| 自动编辑 | 自动接受文件改动，但网络访问仍确认 |
| 全自动 | 所有操作无需确认（谨慎使用） |

#### 新建项目 · 标准模板一键起步

选好模板 → 一键生成 `CLAUDE.md` / `.gitignore` / 记忆系统 / 可选 `git init`。不用每次从零抄。

#### 网络诊断

IP 监控（后台常驻）+ Anthropic / OpenAI 等 API 连通性检测，挂 VPN 时排查问题用。

---

## 快速开始

### 🚀 下载使用（推荐）

从 [Releases](https://github.com/yunshu0909/CodePal/releases/latest) 下载最新 `.dmg` 安装包：

- **macOS Apple Silicon (M 系列)** — 当前支持
- Windows / Intel macOS — 暂未打包，如需请自行本地构建

### 🧑‍💻 本地开发

```bash
git clone https://github.com/yunshu0909/CodePal.git
cd CodePal
npm install
npm run dev
```

`npm run dev` 会同时启动 Vite 开发服务器和 Electron 主进程，支持热重载。

### 📦 自行打包

```bash
npm run dist:mac    # macOS (arm64) .dmg
npm run dist:win    # Windows (x64) NSIS 安装包
```

产物在 `release/` 目录。

---

## 环境要求

- **macOS**（Apple Silicon 优先，Intel 能跑但未打包发布）
- **Node.js 20+**（建议 LTS）
- **npm 9+**

---

## 技术栈

| 技术 | 版本 | 用途 |
|---|---|---|
| Electron | ^40.2.1 | 桌面容器 |
| React | ^19.2.4 | 渲染层 |
| Vite | ^7.3.1 | 前端构建 |
| Vitest | ^4.0.18 | 单元测试 |
| Playwright | ^1.58.2 | E2E 测试 |
| chokidar | ^4.0.3 | 文件监听（Codex auth.json / Skills 目录） |

---

## 项目结构

```
skill-manager/
├── electron/                  # 主进程（Node.js 环境）
│   ├── main.js                # 入口 + window + IPC 注册
│   ├── preload.js             # contextBridge 暴露 electronAPI
│   ├── handlers/              # 按领域拆分的 IPC handlers
│   └── services/              # 可复用业务服务（可测试）
├── src/                       # 渲染进程（React）
│   ├── App.jsx                # 根组件 + 模块路由
│   ├── pages/                 # 各功能页面
│   ├── components/            # 通用组件库（PageShell / Modal / Button 等）
│   ├── hooks/                 # 自定义 hook
│   └── store/                 # 数据层
├── 自动化测试/                 # 按版本分目录的测试用例
│   ├── V1.5.0/                # Codex 账户切换（96 tests）
│   ├── V1.4.5/                # 启动历史对话
│   └── ...
├── docs/
│   ├── prd/                   # 产品需求文档
│   ├── research/              # 技术调研
│   └── screenshots/           # README 截图
└── package.json               # build 配置、scripts、依赖
```

---

## 版本历史 & Release

完整版本信息见 [GitHub Releases](https://github.com/yunshu0909/CodePal/releases)。

**最新版本：[v1.5.3](https://github.com/yunshu0909/CodePal/releases/tag/v1.5.3)**

- 🛡️ 修复远程配置防退化：旧 `pricing.cache.json` 不再覆盖新版安装包配置
- 🔁 修复远程源 fallback：jsDelivr 返回旧版本时会继续尝试 GitHub Raw
- 💰 补齐 GPT-5.5 定价命中链路，避免费用列因旧缓存继续显示 `--`
- 🧪 新增 V1.5.3 专项自动化测试与 PRD/测试报告

之前的里程碑版本：
- **v1.5.2** — 稳定版发布 + 配置打包兜底 + 对话回顾恢复链路
- **v1.5.0** — Codex 多账户切换 + 侧栏分组调整
- **v1.4.5** — 对话回顾支持"启动历史对话"（复制 resume / 新终端启动）
- **v1.4.1** — 满载率趋势（7d 周期峰值 + 最近 4 周）
- **v1.3.4** — Claude 会员额度状态栏集成（statusLine rate_limits）
- **v1.2.6** — 对话回顾页上线
- **v1.2.4** — 网络诊断模块

---

## 贡献

CodePal 目前是作者自用驱动的产品，**不提前规划功能列表**，遵循"用 → 痛 → 解决 → 沉淀"的飞轮。如果你有痛点，欢迎提 Issue；如果想贡献代码，建议先开 Issue 讨论。

---

## License

[ISC](./LICENSE) — by [云舒](https://github.com/yunshu0909)
