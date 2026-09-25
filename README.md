# CodePal — AI 编程的幕后助手

> AI 编程工具负责写代码，CodePal 负责写代码之外的一切 —— 用量与订阅、会话状态、对话回顾、新项目初始化与 Skills / Plugins 跨工具管理。专为 **Claude Code / Codex / Cursor / Trae** 用户打造。

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple)](https://github.com/yunshu0909/CodePal/releases) [![version](https://img.shields.io/badge/version-v2.0.0-blue)](https://github.com/yunshu0909/CodePal/releases/latest) [![license](https://img.shields.io/badge/license-ISC-green)](#license)

---

## 为什么需要 CodePal？

用 AI 写代码是起点，写代码之外的"管理"才是日常摩擦：

- 几十个 **Skills** 要在 Claude Code / Codex / Cursor 多个工具之间同步 —— 改一处要到处改
- AI 在终端里跑完了、卡在等你确认，切走就不知道
- 想知道这个月 **Token 用了多少**、订阅到底值不值
- 找不到上次和 AI 聊过的某条历史对话，翻不到 Session 目录
- 新项目想要标准的 `CLAUDE.md` / `.gitignore`，每次手动抄

**没有一个 AI 工具会帮你做跨工具的事** —— Claude Code 不管 Codex，Codex 不管 Cursor。CodePal 做的就是它们之间的**连接层**，让 AI 工具各自专注写代码，其他的交给 CodePal。

---

## 功能一览

CodePal 按用途分 4 组：**用量账单 · 项目开发 · 技能中心 · 环境配置**。每项都是独立模块，按需使用。

### 💰 用量账单

#### 用量监测 · 按月历看每天用了多少

- 自然月月历，每天一格，点开看当天的模型构成
- 合并 Claude Code、Codex、DeepSeek Harness 三个来源的 Token 用量
- 可设每日目标，按目标分三档显示
- 某天统计失败会明确标出、可以单独重试，不会悄悄算成 0

#### 订阅管理 · 订阅值不值

- Claude Code、Codex 各一张卡：本订阅周期的等价 API 费用、订阅费、倍数、省了多少、还剩几天
- 设置价格、账单日、自动续费；可往回翻看历史周期
- 按当时的模型价格计算，缺价格时可以补

---

### 🧑‍💻 项目开发

#### 新建项目 · 一键生成 AI 可接管的项目骨架

从一个空目录生成可被 AI 直接接管的托管 Coding 框架：

- 同构的 `AGENTS.md` / `CLAUDE.md` 协作协议，分别供 Codex / Claude Code 读取
- `MEMORY.md` + 最近 7 天每日记忆协议
- `ISSUES.md` 唯一需求入口与 `specs/<工作单元>/` 全链路归档
- 通用 `.gitignore`、可选 Git 初始化

先看生成后的完整目录、教学案例与 skill 来源：[CodePal Managed Project Example](https://github.com/yunshu0909/codepal-managed-project-example)。配套 skills 的公开源码在 [云舒的 Skills Hub](https://github.com/yunshu0909/yunshu_skillshub)。

#### 会话状态 · 终端里的 AI 干完活会通知你

- 实时列出 Claude Code、Codex 正在进行的会话：进行中 / 等你确认 / 完成了 / 已停止
- 完成或需要你处理时发 macOS 系统通知，点通知回到 CodePal
- 自动为两个工具装好所需的钩子，关掉开关即删除

#### 对话回顾 · 找得到也接得上

- 跨项目按时间倒序浏览 Claude Code 历史对话，全文搜索
- 点进去看完整对话；一键复制 `claude --resume` 命令，或直接在新终端接着聊

#### 文档查阅 · 多目录 Markdown 浏览

添加多个文件夹作为根目录，展开目录树，内置 Markdown 渲染。

---

### 🛠 技能中心

#### Skills 管理 · 两个工具各自启用了什么，一目了然

- 中央仓库统一存放 Skill，分别查看、开关 Claude Code 与 Codex 里的启用状态
- 按标签筛选、搜索；显示近 30 天调用次数，帮你精简不用的
- 改 Codex 配置时只动目标那一行，保留你的注释和格式

#### Plugins 管理

统一查看 Claude Code、Codex 已安装的 Plugin：版本、来源、启用状态、包含哪些能力；可以安装、启用、停用、卸载（Codex 的启用 / 停用直接改 `config.toml` 里对应的一项，其余操作走官方 CLI）。

---

### ⚙️ 环境配置

#### Claude Code 设置

- 默认启动模式，6 档：全自动 / 自动审批 / 自动编辑 / 每次询问 / 仅预先授权 / 只读规划，下次启动生效
- 底部状态栏显示内容的设置

#### 网络诊断 · 出口 IP 变了第一时间知道

查看当前出口 IP；可开后台监控，IP 变化或连续测不到时发系统通知，挂 VPN 时排查用。

---

## 快速开始

### 🚀 下载使用（推荐）

从 [Releases](https://github.com/yunshu0909/CodePal/releases/latest) 下载最新 `.dmg` 安装包：

- **macOS Apple Silicon (M 系列)** — 当前支持
- **Windows (x64)** — 随版本自动构建安装包，作者日常不在 Windows 上使用，可能有未发现的问题
- Intel macOS — 暂未打包，如需请自行本地构建

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
- **Node.js 20.19+**（建议 LTS）
- **npm 9+**

---

## 技术栈

| 技术 | 版本 | 用途 |
|---|---|---|
| Electron | ^40.2.1 | 桌面容器 |
| React | ^19.2.4 | 渲染层 |
| Vite | ^7.3.1 | 前端构建 |
| Vitest | ^4.0.18 | 单元测试 |
| chokidar | ^4.0.3 | 文件监听（Skills 中央仓库） |
| smol-toml | ^1.9.0 | 按 TOML 语义读写 Codex 配置 |

---

## 项目结构

```
skill-manager/
├── electron/                  # 主进程（Node.js 环境）
│   ├── main.js                # 入口 + 窗口 + IPC 注册
│   ├── preload.js             # contextBridge 暴露 electronAPI
│   ├── handlers/ · ipc/       # 按领域拆分的 IPC handlers
│   └── services/              # 可复用业务服务（可测试）
├── src/                       # 渲染进程（React）
│   ├── App.jsx                # 根组件 + 模块路由
│   ├── pages/                 # 各功能页面
│   ├── components/            # 通用组件库
│   ├── hooks/                 # 自定义 hook
│   └── store/                 # 数据层
├── tests/                     # 自动化测试（Vitest）
├── templates/                 # 新建项目模板、会话状态钩子脚本
└── package.json               # build 配置、scripts、依赖
```

提交前跑 `npm run lint && npm test`，CI 也会跑同样的检查。

---

## 版本历史 & Release

完整版本信息见 [GitHub Releases](https://github.com/yunshu0909/CodePal/releases)。

**最新版本：[v2.0.0](https://github.com/yunshu0909/CodePal/releases/tag/v2.0.0)**

- 🎨 界面换成 macOS 原生风格：用量监测、订阅管理、会话状态、对话回顾、Claude Code 设置、网络诊断 6 页重做，窗口外壳与侧栏换新
- 📅 用量监测改为月历，并接入 DeepSeek Harness 用量；「会员额度」改为订阅管理，看订阅值不值
- 🔔 新增会话状态：Claude Code / Codex 干完活或等你确认时发系统通知
- 🧩 Skills / Plugins 管理：分别查看、开关两个工具里的启用状态
- 🛡️ 安全与稳定：Codex 配置改为按 TOML 语义读写、保留注释；文件操作按用途校验；退出时统一清理后台任务
- 🧹 下线：MCP 管理、Codex 多账户切换、DeepSeek Harness 管理、满载率趋势；旧版本写进 Claude / Codex 配置的 MCP 条目会在首次启动时自动清理（先备份）

之前的里程碑版本：
- **v1.9.11** — 修正 Codex 额度窗口口径
- **v1.9.10** — 网络诊断默认零公网请求；新建项目使用托管 Coding 协议 v3.1
- **v1.5.2** — 稳定版发布 + 配置打包兜底 + 对话回顾恢复链路
- **v1.4.5** — 对话回顾支持「启动历史对话」（复制 resume / 新终端启动）
- **v1.2.6** — 对话回顾页上线

---

## 贡献

CodePal 目前是作者自用驱动的产品，**不提前规划功能列表**，遵循"用 → 痛 → 解决 → 沉淀"的飞轮。如果你有痛点，欢迎提 Issue；如果想贡献代码，建议先开 Issue 讨论。

---

## License

ISC — by [云舒](https://github.com/yunshu0909)
