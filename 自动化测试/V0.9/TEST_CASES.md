# TEST_CASES（V0.9）- 新建项目一键初始化

## 1. 文档目标
- 目标：将 V0.9 “新建项目”从页面原型升级到可发布的自动化验证闭环。
- 依据 PRD：`/Users/wuhaoyang/Documents/trae_projects/skills/docs/prd/PRD-Skill-Manager-V0.9-新建项目一键初始化.md`
- 依据 UI：`/Users/wuhaoyang/Documents/trae_projects/skills/设计/v0.9-新建项目/项目初始化-双栏布局-v0.9.html`

## 2. 阶段一：后端校验与执行（BE）

### TC-BE-01（P0）空项目名校验拦截
- 类型：Backend Unit
- 覆盖：`project-init-validate`
- 断言：
  - 返回 `valid=false`
  - 错误码包含 `INVALID_PROJECT_NAME`

### TC-BE-02（P0）目录冲突拦截
- 类型：Backend Unit
- 覆盖：`project-init-validate`
- 前置：`design/design-system.html` 位置被目录占用
- 断言：
  - 返回 `valid=false`
  - 冲突包含 `DIRECTORY_CONFLICT`

### TC-BE-03（P0）未覆盖时文件冲突拦截
- 类型：Backend Unit
- 覆盖：`project-init-validate`
- 前置：目标 `AGENTS.md` 已存在
- 断言：
  - 返回 `valid=false`
  - 冲突包含 `FILE_EXISTS`

### TC-BE-04（P0）开启覆盖后可继续
- 类型：Backend Unit
- 覆盖：`project-init-validate`
- 前置：目标 `AGENTS.md` 已存在，`overwrite=true`
- 断言：
  - 返回 `valid=true`
  - 告警包含 `WILL_OVERWRITE_TARGET_FILE`

### TC-BE-05（P0）none 模式创建目录与模板
- 类型：Backend Integration
- 覆盖：`project-init-execute`
- 断言：
  - 创建 `prd/design/code`
  - 复制 `AGENTS.md` / `CLAUDE.md` / `design-system.html`

### TC-BE-06（P0）覆盖执行应替换文件内容
- 类型：Backend Integration
- 覆盖：`project-init-execute`
- 前置：目标 `AGENTS.md` 已存在，`overwrite=true`
- 断言：
  - 执行成功
  - `summary.overwrittenFiles` 包含目标文件
  - 文件内容与模板一致

### TC-BE-07（P1）code 模式遇已存在 .git 跳过
- 类型：Backend Integration
- 覆盖：`project-init-execute`
- 前置：`code/.git` 已存在
- 断言：
  - 执行成功
  - `INIT_GIT` 步骤为 `skipped`
  - 错误码为 `GIT_ALREADY_INITIALIZED`

### TC-BE-08（P0）Git 初始化失败触发回滚
- 类型：Backend Integration
- 覆盖：`project-init-execute`
- 注入：PATH 置空导致 `git` 不可执行
- 断言：
  - 返回 `GIT_NOT_INSTALLED`
  - `rollback.attempted=true`
  - 项目根目录被清理

## 3. 阶段二：页面交互链路（FE Integration）

### TC-FE-01（P0）默认态与禁用态
- 类型：Frontend Integration
- 覆盖：页面初始渲染
- 断言：
  - 双栏容器存在
  - 默认路径 `~/Documents/projects/`
  - 创建按钮禁用
  - 覆盖开关默认关闭

### TC-FE-02（P0）Git/模板切换联动预览
- 类型：Frontend Integration
- 覆盖：页面状态编排
- 断言：
  - 项目名修改实时反映在预览树
  - Git root/code 切换时 `.git` 节点切换
  - 取消 design 模板后隐藏 `design-system.html`

### TC-FE-03（P1）浏览目录更新路径
- 类型：Frontend Integration
- 覆盖：`selectFolder`
- 断言：
  - 点击浏览触发 IPC
  - 返回路径后输入框更新

### TC-FE-04（P0）validate 失败阻断 execute
- 类型：Frontend Integration
- 覆盖：创建流程
- 断言：
  - 调用 validate
  - 不调用 execute
  - 展示校验失败与错误码

### TC-FE-05（P0）成功链路参数正确并展示结果
- 类型：Frontend Integration
- 覆盖：创建流程
- 断言：
  - validate/execute 均被调用
  - 参数包含 `overwrite=true`、模板选择结果、Git 模式
  - 显示成功结果区

### TC-FE-06（P0）execute 失败展示回滚信息
- 类型：Frontend Integration
- 覆盖：失败分支
- 断言：
  - 显示失败结果区
  - 展示步骤错误码
  - 展示“回滚状态：成功/部分失败”

## 4. 阶段三：Electron 全链路（E2E）

### TC-E2E-01（P0）none 模式真实创建
- 类型：E2E
- 断言：
  - 页面显示初始化成功
  - 真实文件系统包含 `prd/design/code` 与模板文件

### TC-E2E-02（P0）root 模式真实创建 .git
- 类型：E2E
- 前置：系统已安装 Git
- 断言：
  - 页面显示初始化成功
  - 项目根目录生成 `.git`

### TC-E2E-03（P0）冲突且未覆盖
- 类型：E2E
- 前置：预先写入 `AGENTS.md`
- 断言：
  - 页面显示校验失败
  - 旧文件内容保持不变

### TC-E2E-04（P0）冲突且开启覆盖
- 类型：E2E
- 前置：预先写入 `AGENTS.md`
- 断言：
  - 页面显示初始化成功
  - 目标文件内容变为模板内容
