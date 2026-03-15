# CodePal — AI 编程工具管理中心

Electron 桌面应用，统一管理 Claude Code、Cursor、CodeX、Trae 等 AI 编程工具的技能、配置和运维，一个面板搞定。

---

## 功能一览

### 1. 技能管理 — 写一次，到处用

不用在每个工具里重复配置 Skills。从任意工具导入技能到中央仓库，一键推送到所有工具，改一处自动同步。MCP 服务也能可视化管理，不用手动编辑 JSON 配置文件。

- **Skills 导入**：从 Claude Code / CodeX / Cursor / Trae 扫描并导入，支持自定义路径和团队共享目录
- **推送与停用**：一键批量推送或停用到多个工具，支持搜索和标签筛选
- **双向同步**：中央仓库与工具目录自动同步，改一处全局生效
- **MCP 服务管理**：可视化管理 MCP 服务的启用/停用状态，告别手动编辑配置文件

### 2. 运维监测 — Token 花了多少，一目了然

不用翻日志文件算用量。自动聚合 Claude 和 CodeX 的使用数据，按日/周/月统计，模型分布和成本趋势直接看图。Claude Code 本身的版本、健康状态、网络连通性也能一键检查。

- **用量监测**：按日/周/月统计 Token 用量，查看模型分布，辅助成本分析
- **Claude Code 管理**：查看版本、一键更新、Doctor 健康检查、认证状态、网络诊断

### 3. Claude Code 配置 — 命令行的事，GUI 里搞定

不用记命令行参数，不用手动编辑 settings.json。供应商切换、权限模式、默认模型、推理等级，全部可视化配置，选完下次启动自动生效。

- **API 供应商切换**：在 Claude Official / Kimi / AICodeMirror 等供应商之间一键切换，保存 API Key
- **启动模式**：一键切换 4 种权限模式（只读规划 / 每次询问 / 自动编辑 / 全自动）
- **模型与推理等级**：配置默认模型（opus / sonnet / haiku 等）和推理等级（低 / 中 / 高）

### 4. 项目工具 — 新项目，一键起步

不用每次新建项目都手动创建 CLAUDE.md、.gitignore 等文件。选好模板，一键生成标准项目结构，可选 Git 初始化。

- **新建项目初始化**：一键创建项目目录，自动生成模板文件，开箱即用

---

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发环境
npm run dev
```

`npm run dev` 会同时启动 Vite 开发服务器和 Electron 主进程。

### 环境要求

- Node.js 18+（建议 20 LTS）
- npm 9+
- macOS / Linux

---

## 技术栈

- **Electron** ^40.2.1
- **React** ^19.2.4
- **Vite** ^7.3.1

## 项目结构

```
skill-manager/
├── electron/                  # 主进程
│   ├── main.js                # 入口 + IPC 注册
│   ├── preload.js             # IPC bridge
│   ├── handlers/              # 按模块拆分的 IPC 处理器
│   └── services/              # 可复用业务逻辑
├── src/                       # 渲染进程
│   ├── App.jsx                # 根组件 + 路由
│   ├── pages/                 # 页面组件
│   ├── components/            # 通用组件库
│   └── styles/                # 样式文件
└── 自动化测试/                 # 分版本测试用例
```

## 构建

```bash
npm run build
```

构建产物在 `dist/`。当前未配置 `electron-builder`，不会直接产出安装包。

## License

ISC
