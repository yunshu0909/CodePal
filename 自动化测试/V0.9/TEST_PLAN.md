# TEST_PLAN（V0.9）- 新建项目一键初始化

## 1. 测试范围
- PRD：`/Users/wuhaoyang/Documents/trae_projects/skills/docs/prd/PRD-Skill-Manager-V0.9-新建项目一键初始化.md`
- 设计稿：`/Users/wuhaoyang/Documents/trae_projects/skills/设计/v0.9-新建项目/项目初始化-双栏布局-v0.9.html`
- 范围内：
  - 新建项目页面（字段输入、模板勾选、Git 模式、覆盖开关）
  - 后端 `project-init-validate` 校验与冲突检测
  - 后端 `project-init-execute` 执行、Git 初始化与安全回滚
  - Electron 端真实落盘（目录/模板/.git）
- 非范围：
  - 自动提交（auto commit）与分支创建
  - PRD/design/code 子仓自动初始化为独立 Git
  - 设计稿视觉像素级比对

## 2. 完成门槛
1. 后端测试全部通过（P0 100%）
2. 前端集成测试全部通过（P0 100%）
3. Electron E2E 主链路全部通过（P0 100%）
4. 无阻断级缺陷遗留

## 3. 自动化边界（A/H/A+H）
- A（全自动）：
  - 参数校验、冲突识别、覆盖语义、执行结果、回滚结果
  - 页面交互与 IPC 调用参数
  - 真实文件系统落盘结果
- H（人工补测）：
  - 双栏视觉细节（间距、阴影、字体渲染）
  - 页面操作流畅度与动画体感
- A+H（联合）：
  - 创建成功后的可读反馈（结果区 + Toast）

## 4. 分层测试编排
- Backend（Vitest / Node）
  - 文件：`自动化测试/V0.9/tests/backend/projectInitHandlers.test.js`
  - 关注点：校验、冲突、覆盖、Git 失败回滚
- Integration（Vitest / jsdom）
  - 文件：`自动化测试/V0.9/tests/integration/ProjectInitPage.v09.formal-flow.test.jsx`
  - 关注点：表单联动、validate/execute 链路、失败展示
- E2E（Playwright / Electron）
  - 文件：`自动化测试/V0.9/tests/e2e/project-init.v09.formal-electron.spec.js`
  - 关注点：真实创建目录/模板/.git、冲突与覆盖行为

## 5. 执行顺序
1. `npm run test:v09:backend`
2. `npm run test:v09:integration`
3. `npm run test:e2e:v09`
4. `npm run test:v09:all`

## 6. 输出产物
- `TEST_CASES.md`
- `TEST_REPORT.md`
- `DECISION_LOG.md`
