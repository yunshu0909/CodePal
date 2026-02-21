# TEST_CASES（V0.12）- 启动模式

## 1. 文档目标
- 目标：对 V0.12 启动模式提供“后端 + 前端 + Electron”闭环自动化验证。
- 依据 PRD：`/Users/wuhaoyang/Documents/trae_projects/skills/docs/prd/PRD-Skill-Manager-V0.12-启动模式.md`
- 依据 UI：
  - `/Users/wuhaoyang/Documents/trae_projects/skills/设计/v0.12-启动模式/启动模式-设计稿.html`
  - `/Users/wuhaoyang/Documents/trae_projects/skills/设计/v0.12-启动模式/启动模式-全状态设计参考.html`

## 2. 阶段一：后端读写契约（BE）

### TC-BE-01（P0）settings.json 不存在时返回未配置
- 类型：Backend Unit
- 覆盖：`get-permission-mode-config`
- 断言：
  - `success=true`
  - `isConfigured=false`
  - `mode=null`

### TC-BE-02（P0）已知模式读取成功
- 类型：Backend Unit
- 覆盖：`get-permission-mode-config`
- 前置：`permissions.defaultMode=acceptEdits`
- 断言：
  - `success=true`
  - `isConfigured=true`
  - `mode=acceptEdits`
  - `isKnownMode=true`

### TC-BE-03（P0）未知模式读取进入未知分支
- 类型：Backend Unit
- 覆盖：`get-permission-mode-config`
- 前置：`permissions.defaultMode=dontAsk`
- 断言：
  - `success=true`
  - `isConfigured=true`
  - `isKnownMode=false`

### TC-BE-04（P0）JSON 损坏返回解析错误
- 类型：Backend Unit
- 覆盖：`get-permission-mode-config`
- 前置：`settings.json` 非法 JSON
- 断言：
  - `success=false`
  - `errorCode=JSON_PARSE_ERROR`

### TC-BE-05（P0）非法模式写入被拦截
- 类型：Backend Unit
- 覆盖：`set-permission-mode`
- 输入：`mode=invalid-mode`
- 断言：
  - `success=false`
  - `errorCode=INVALID_MODE`

### TC-BE-06（P0）首次写入应创建 settings.json
- 类型：Backend Integration
- 覆盖：`set-permission-mode`
- 前置：文件不存在
- 断言：
  - `success=true`
  - 文件创建成功
  - `permissions.defaultMode` 为目标值

### TC-BE-07（P0）写入时保留其他字段并生成备份
- 类型：Backend Integration
- 覆盖：`set-permission-mode`
- 前置：原文件包含其他配置
- 断言：
  - `success=true`
  - 返回 `backupPath`
  - 其他字段保持不变
  - 目标模式更新成功

### TC-BE-08（P1）原文件损坏时自动恢复并完成写入
- 类型：Backend Integration
- 覆盖：`set-permission-mode`
- 前置：原文件为损坏 JSON
- 断言：
  - `success=true`
  - 可重新解析新文件
  - 新文件包含目标模式

### TC-BE-09（P0）IPC 参数非字符串应返回参数错误
- 类型：Backend Unit
- 覆盖：`set-permission-mode` IPC 包装
- 输入：`mode=123`
- 断言：
  - `success=false`
  - `errorCode=INVALID_ARGUMENT`

## 3. 阶段二：页面状态与交互（FE Integration）

### TC-FE-01（P0）已知模式加载后高亮当前项
- 类型：Frontend Integration
- 覆盖：正常态渲染
- 断言：
  - 状态卡片显示当前模式中文名
  - 当前模式展示“当前使用”标签

### TC-FE-02（P0）未配置态高亮 default 并展示当前使用标签
- 类型：Frontend Integration
- 覆盖：未配置态渲染
- 断言：
  - 状态卡片显示“每次询问”
  - `default` 项展示“当前使用”标签

### TC-FE-03（P0）未知模式态展示警告 Banner 且无当前标签
- 类型：Frontend Integration
- 覆盖：未知模式态渲染
- 断言：
  - 警告 Banner 可见
  - 不存在“当前使用”标签

### TC-FE-04（P0）读取失败态可重试并恢复正常态
- 类型：Frontend Integration
- 覆盖：错误态 + 重试链路
- 断言：
  - 首次进入错误态
  - 点击“重试”后二次读取成功

### TC-FE-05（P0）切换成功时显示切换中状态并更新结果
- 类型：Frontend Integration
- 覆盖：切换中态 + 成功分支
- 断言：
  - 目标按钮显示“切换中...”
  - 切换中期间所有按钮 disabled
  - 成功后显示成功 Toast

### TC-FE-06（P0）切换失败时显示错误 Toast 且保持旧模式
- 类型：Frontend Integration
- 覆盖：失败分支
- 断言：
  - 显示错误 Toast
  - 当前模式不变

### TC-FE-07（P0）当前模式不暴露启用按钮避免重复触发
- 类型：Frontend Integration
- 覆盖：防重交互
- 断言：
  - 当前模式项不显示“启用”按钮
  - 不触发 `setPermissionMode`

## 4. 阶段三：Electron 全链路（E2E）

### TC-E2E-01（P0）未配置态进入页面并完成模式切换落盘
- 类型：E2E
- 断言：
  - 初始状态显示未配置态
  - 切换后出现成功提示
  - `~/.claude/settings.json` 写入目标模式

### TC-E2E-02（P0）未知模式配置应显示警告态
- 类型：E2E
- 前置：`defaultMode=dontAsk`
- 断言：
  - 警告 Banner 可见
  - 不显示“当前使用”标签

### TC-E2E-03（P0）JSON 解析错误可通过重试恢复
- 类型：E2E
- 前置：`settings.json` 损坏
- 断言：
  - 首次进入显示错误态
  - 修复文件后点击“重试”恢复正常
