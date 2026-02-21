# TEST_PLAN（V0.12）- 启动模式

## 1. 测试范围
- PRD：`/Users/wuhaoyang/Documents/trae_projects/skills/docs/prd/PRD-Skill-Manager-V0.12-启动模式.md`
- 设计稿：
  - `/Users/wuhaoyang/Documents/trae_projects/skills/设计/v0.12-启动模式/启动模式-设计稿.html`
  - `/Users/wuhaoyang/Documents/trae_projects/skills/设计/v0.12-启动模式/启动模式-全状态设计参考.html`
- 范围内：
  - 页面 6 态：加载态、正常态、未配置态、未知模式态、读取失败态、切换中态
  - IPC：`get-permission-mode-config` / `set-permission-mode`
  - 配置文件：`~/.claude/settings.json` 的读取、写入、备份
  - 前端切换反馈：按钮禁用、Spinner、成功/失败 Toast
  - Electron 真实链路：页面交互触发真实落盘
- 非范围：
  - `dontAsk` 模式的正式支持
  - 从页面直接启动 Claude Code
  - 样式像素级视觉比对

## 2. 完成门槛
1. 后端测试全部通过（P0 100%）
2. 前端集成测试全部通过（P0 100%）
3. Electron E2E 主链路全部通过（P0 100%）
4. 无阻断级缺陷遗留

## 3. 自动化边界（A/H/A+H）
- A（全自动）：
  - settings.json 读取分支（已知/未配置/未知/损坏）
  - setPermissionMode 参数校验、写入、备份与恢复
  - 页面状态切换与 IPC 调用参数
  - Electron 环境中的真实文件落盘
- H（人工补测）：
  - 视觉一致性（颜色、阴影、间距、字体）
  - 动效体感（Toast 动画、按钮切换动画）
- A+H（联合）：
  - 错误态文案可读性（技术错误 + 用户理解）

## 4. 分层测试编排
- Backend（Vitest / Node）
  - 文件：`自动化测试/V0.12/tests/backend/permissionModeHandlers.v12.behavior.test.js`
  - 关注点：读取契约、错误码、写入与备份、参数校验
- Integration（Vitest / jsdom）
  - 文件：`自动化测试/V0.12/tests/integration/PermissionModePage.v12.formal-flow.test.jsx`
  - 关注点：6 态渲染、重试链路、切换成功/失败、幂等保护
- E2E（Playwright / Electron）
  - 文件：`自动化测试/V0.12/tests/e2e/permission-mode.v12.formal-electron.spec.js`
  - 关注点：真实页面交互、未知模式警告、读取失败重试、写入 settings.json

## 5. 执行顺序
1. `npm run test:v12:backend`
2. `npm run test:v12:integration`
3. `npm run test:e2e:v12`
4. `npm run test:v12:all`

## 6. 输出产物
- `TEST_CASES.md`
- `TEST_REPORT.md`
- `DECISION_LOG.md`
