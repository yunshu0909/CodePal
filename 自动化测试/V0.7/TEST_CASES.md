# TEST_CASES（V0.7）- 供应商切换（前后端全链路）

## 1. 文档目标
- 目的：将 V0.7 从“设计稿确认 + 脚本验证”升级为“前端落地 + 后端可恢复写入 + 可迭代接入台账”的执行级测试集。
- 依据 PRD：`/Users/wuhaoyang/Documents/trae_projects/skills/docs/prd/PRD-Skill-Manager-V0.7-供应商切换.md`
- 依据 UI：`/Users/wuhaoyang/Documents/trae_projects/skills/设计/v0.7-供应商切换/AI-Workbench-v0.7-供应商切换.html`
- 范围：仅 V0.7 三档供应商切换（Official/Kimi/AICodeMirror）与 API Key 维护。
- 非范围：通用供应商模板化、多应用（Codex/Gemini/OpenCode）、代理接管、故障转移。

## 2. PRD 关键规则（测试基线）
- UI 基线：页面结构、组件文案、交互入口以 v0.7 设计稿为准。
- 切换范围：仅支持 `official`、`kimi`、`aicodemirror` 三档。
- 配置文件：统一落地 `~/.claude/settings.json`。
- Official 语义：切回 official 时清空 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`，并清理 `apiKeyHelper`。
- 第三方语义：切到 Kimi/AICodeMirror 时写入 `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`，并维护托管 `apiKeyHelper`。
- custom 语义：页面显示 `自定义配置 (Custom)` 时，允许直接切换到目标供应商，不再二次确认。
- 保存范围：V0.7 仅编辑第三方 API Key（`API Key` 单字段）；base_url 在 v0.7 不允许前端编辑。
- 写入保障：写入前备份 + 原子替换；失败时保持旧配置可用。
- 生效提示：成功后提示“重启 Claude Code 会话后生效”。

## 3. 自动化边界矩阵（A/H/A+H）
- A（全自动）：字段映射、写入结果、备份生成、错误码与错误提示、状态同步。
- H（人工优先）：视觉对齐（像素级）、按钮触达顺滑度、文案语气与可读性。
- A+H（联合）：全流程切换体验（自动化验证行为，人工确认交互自然度）。

## 4. 固定测试夹具

### 4.1 配置夹具
- `S0`：最小配置
  - `{"env": {}, "model": "opus"}`
- `S1`：带无关字段配置（用于“不可误改”）
  - `{"env": {"FOO":"BAR"}, "model":"opus", "permissions":{"allow":["mcp__pencil"]}, "extra":{"x":1}}`
- `S2`：Kimi 已生效配置
  - `env.ANTHROPIC_API_KEY = sk-kimi-...`
  - `env.ANTHROPIC_BASE_URL = https://api.kimi.com/coding/`
- `S3`：AICodeMirror 已生效配置
  - `env.ANTHROPIC_API_KEY = sk-ant-api03-...`
  - `env.ANTHROPIC_BASE_URL = https://api.aicodemirror.com/api/claudecode`

### 4.2 失败注入夹具
- `F1`：备份目录不可写（权限错误）。
- `F2`：临时文件写入失败（磁盘满/IO error）。
- `F3`：原子替换失败（rename/replace 异常）。
- `F4`：配置文件 JSON 损坏（读取失败）。

### 4.3 测试环境约束
- 系统：macOS（与当前目标一致）。
- 默认配置路径：`~/.claude/settings.json`。
- 执行前清理：每条后端写入用例独立临时目录，避免相互污染。

---

## 5. 阶段一：页面落地（US-01）

### TC-S1-FE-01（P0）页面基础结构与设计稿一致
- 类型：前端 Unit + 人工视觉（A+H）
- 覆盖 PRD：US-01
- 目标：确认页面信息架构与设计稿一致。
- 前置条件：加载 API 配置页。
- 步骤：
  1. 检查标题、副标题、侧边栏激活项。
  2. 检查“当前使用”区块。
  3. 检查供应商列表区域与 3 张卡片。
- 前端断言：
  - 文案存在：`API 配置`、`切换 Claude Code 的 API 接入点`、`选择 API 接入点`。
  - 卡片顺序：Official -> Kimi -> AICodeMirror。
- 后端断言：N/A。
- 失败判定：任一核心区块缺失或供应商卡片数量不是 3。

### TC-S1-FE-02（P0）当前使用状态与卡片状态一致
- 类型：前端 Unit（A）
- 覆盖 PRD：US-01
- 目标：当前供应商名称、卡片高亮、按钮状态一致。
- 输入：当前供应商分别设为 official/kimi/aicodemirror。
- 步骤：逐一加载页面。
- 前端断言：
  - `currentName` 文案对应当前供应商。
  - 当前卡片显示“当前使用”。
  - 非当前卡片显示“启用”。
- 后端断言：N/A。

### TC-S1-FE-03（P0）编辑入口可见性规则
- 类型：前端 Unit（A）
- 覆盖 PRD：US-02 入口规则
- 目标：Official 不显示编辑入口；支持 token 的供应商在“当前使用”或“未配置 token”时可进入编辑。
- 输入：当前供应商分别设为 official、kimi、aicodemirror，并覆盖“未配置 token”场景。
- 前端断言：
  - current=official：无“编辑 API Key”按钮。
  - current=kimi：Kimi 有“编辑 API Key”。
  - current=aicodemirror：AICodeMirror 有“编辑 API Key”。
  - 非当前但 token 为空的第三方卡片显示“编辑 API Key”（引导先配置后启用）。
- 后端断言：N/A。

---

## 6. 阶段二：前端功能接线（US-01/US-02）

### TC-S2-IT-01（P0）点击“启用”触发切换成功链路
- 类型：前后端 Integration（A）
- 覆盖 PRD：US-01
- 目标：点击“启用”后完成切换并刷新状态。
- 前置条件：当前=official，后端切换接口 mock 成功。
- 步骤：点击 Kimi 卡片“启用”。
- 前端断言：
  - 显示成功提示。
  - currentName 更新为 Kimi。
  - Kimi 卡片变为“当前使用”。
- 后端断言：
  - 接口收到 `profile=kimi`。
  - 返回 success。

### TC-S2-IT-02（P0）切换失败保持原状态
- 类型：前后端 Integration（A）
- 覆盖 PRD：US-01 异常处理
- 目标：失败时状态不漂移。
- 前置条件：当前=kimi，切换 official 接口返回失败。
- 步骤：点击 Official“启用”。
- 前端断言：
  - 显示错误提示。
  - currentName 保持 Kimi。
  - 卡片高亮仍在 Kimi。
- 后端断言：
  - 接口错误被前端消费并可见。

### TC-S2-FE-01（P0）编辑 API Key 面板展开/取消
- 类型：前端 Unit（A）
- 覆盖 PRD：US-02
- 目标：编辑面板展开与取消行为正确。
- 前置条件：current=kimi。
- 步骤：
  1. 点击“编辑 API Key”。
  2. 验证输入框与“保存/取消”出现。
  3. 点击“取消”。
- 前端断言：
  - 展开后仅 1 个字段：`API Key`。
  - 取消后面板收起。
- 后端断言：取消操作不发保存请求。

### TC-S2-IT-03（P0）保存 API Key 成功
- 类型：前后端 Integration（A）
- 覆盖 PRD：US-02
- 目标：保存成功后状态正确，数据持久化。
- 前置条件：current=aicodemirror，保存接口成功。
- 步骤：
  1. 展开编辑面板。
  2. 输入新 API Key。
  3. 点击“保存”。
- 前端断言：
  - 成功提示出现。
  - 面板收起。
  - 页面保留当前供应商不变。
- 后端断言：
  - 保存接口收到 `provider=aicodemirror` 与新 token。
  - 返回 success。
  - 随后二次读取返回新 token（脱敏后展示）。

### TC-S2-IT-04（P0）custom 状态直接切换
- 类型：前后端 Integration（A）
- 覆盖 PRD：US-01 custom 语义
- 目标：custom 状态允许直接切换，不弹确认。
- 前置条件：`getClaudeProvider.current = custom`，目标供应商 token 已配置。
- 步骤：点击 Kimi“启用”。
- 前端断言：
  - 不出现确认拦截。
  - currentName 变更为 Kimi。
- 后端断言：
  - 触发 `switch-claude-provider(kimi)`。

### TC-S2-FE-02（P1）防重复提交
- 类型：前端 Unit（A）
- 覆盖 PRD：US-01/US-02 稳定性
- 目标：提交期间防止重复点击。
- 步骤：快速双击“启用”或“保存”。
- 前端断言：
  - 仅发起一次请求。
  - 按钮进入禁用或 loading 态。
- 后端断言：同一动作仅接收一次请求。

---

## 7. 阶段三：稳定性保障（US-03，后端重点）

### TC-S3-BE-01（P0）切换前生成备份
- 类型：后端 Unit/Integration（A）
- 覆盖 PRD：US-03
- 目标：每次写入前生成备份。
- 前置条件：存在原始 `settings.json`。
- 步骤：执行 `switch(kimi)`。
- 后端断言：
  - `~/.claude/backups/` 新增 `settings-*.json`。
  - 备份内容等于切换前配置。
- 前端断言：N/A。

### TC-S3-BE-02（P0）原子写成功不产生半文件
- 类型：后端 Unit（A）
- 覆盖 PRD：US-03
- 目标：写入结果始终为完整 JSON。
- 步骤：执行切换并立即读取目标文件。
- 后端断言：
  - 目标文件可被 JSON 正常解析。
  - 不残留 `.tmp.*` 文件。

### TC-S3-BE-03（P0）原子替换失败时回退
- 类型：后端 Integration（A）
- 覆盖 PRD：US-03 异常处理
- 前置条件：注入 `F3`。
- 步骤：执行切换。
- 后端断言：
  - 返回失败。
  - 原 `settings.json` 内容不变。
- 前端断言：
  - 显示失败提示。
  - 当前供应商状态不变。

### TC-S3-BE-04（P0）Official 切换语义
- 类型：后端 Unit（A）
- 覆盖 PRD：US-03
- 输入：`S2` 或 `S3`。
- 步骤：执行 `switch(official)`。
- 后端断言：
  - `env.ANTHROPIC_API_KEY` 被清空/移除。
  - `env.ANTHROPIC_AUTH_TOKEN` 被清空/移除（兼容历史字段）。
  - `env.ANTHROPIC_BASE_URL` 被清空/移除。
  - 顶层 `apiKeyHelper` 被清理（Official 严格登录）。
  - `model` 按约定保持 `opus`。

### TC-S3-BE-05（P0）无关字段不被误改
- 类型：后端 Unit（A）
- 覆盖 PRD：US-03
- 输入：`S1`。
- 步骤：执行 `switch(kimi)` 与 `switch(official)`。
- 后端断言：
  - `permissions`、`extra`、非托管 env 字段保持不变。

### TC-S3-BE-06（P1）备份失败处理
- 类型：后端 Integration（A）
- 覆盖 PRD：US-03
- 前置条件：注入 `F1`。
- 步骤：执行切换。
- 后端断言：
  - 返回失败并附可读错误。
  - 原配置不变。
- 前端断言：显示失败文案。

### TC-S3-BE-07（P1）配置损坏可感知
- 类型：后端 Integration（A）
- 覆盖 PRD：US-03
- 前置条件：注入 `F4`（settings.json 非法 JSON）。
- 步骤：调用 current/switch/save。
- 后端断言：
  - 返回可识别错误（解析失败）。
  - 不执行破坏性写入。
- 前端断言：错误可见，不白屏。

---

## 8. 阶段四：接入逻辑台账（US-04）

### TC-S4-DOC-01（P0）三档台账完整性
- 类型：文档检查（A）
- 覆盖 PRD：US-04
- 目标：每个 provider 条目齐全。
- 校验项：
  - provider id / display name
  - 字段映射
  - 切换规则
  - 保存规则
  - 校验规则
  - 错误提示
  - 回归用例
- 通过标准：三档均完整。

### TC-S4-DOC-02（P0）台账与实现一致性
- 类型：文档 + 集成（A+H）
- 覆盖 PRD：US-04
- 目标：台账与实际行为无冲突。
- 步骤：按台账规则跑抽样集成用例（official/kimi/aicodemirror 各 1 条）。
- 断言：行为与台账一致；如不一致必须修正台账或实现。

### TC-S4-DOC-03（P1）新增接入方模板可复用性
- 类型：文档演练（A）
- 覆盖 PRD：US-04
- 目标：模拟新增 `provider-x` 时无需改台账结构。
- 断言：可按既有模板补齐条目并生成测试占位用例。

---

## 9. 跨阶段集成与 E2E（端到端）

### TC-E2E-01（P0）完整切换回路：Official -> Kimi -> AICodeMirror -> Official
- 类型：E2E（A+H）
- 目标：验证三档循环切换稳定。
- 步骤：按顺序点击启用并观察状态变化。
- 前端断言：每一步 currentName 与卡片状态正确。
- 后端断言：每一步 settings.json 与目标档一致。

### TC-E2E-02（P0）更新 API Key 后切换生效
- 类型：E2E（A）
- 目标：验证“保存后下一次切换生效”。
- 步骤：
  1. current=kimi，修改 Kimi API Key 保存。
  2. 切到 official。
  3. 再切回 kimi。
- 断言：第二次切回 kimi 使用新 API Key（从配置读取验证）。

### TC-E2E-03（P1）重启后状态与配置一致
- 类型：E2E（A）
- 目标：验证持久化稳定。
- 步骤：切换到 aicodemirror，重启应用，重新进入页面。
- 断言：页面 currentName 与配置文件解析结果一致。

### TC-E2E-04（P1）失败链路用户可感知
- 类型：E2E（A+H）
- 目标：真实错误时用户能理解并恢复。
- 前置：注入写入失败。
- 断言：
  - 出现明确错误提示。
  - 页面无崩溃。
  - 用户可再次尝试或取消。

---

## 10. 人工补测清单（H）
- H-01：视觉一致性（与 v0.7 设计稿的间距、边框、字号、卡片状态）。
- H-02：交互顺滑度（展开/收起编辑区、切换反馈节奏）。
- H-03：文案可读性（成功/失败提示是否明确“需重启会话生效”）。
- H-04：异常体验（错误提示不会遮挡关键操作，用户能快速恢复）。

---

## 11. 用例统计与优先级建议
- 总用例数：30
- P0：17（必须自动化优先）
- P1：13（可阶段补齐）

建议执行顺序：
1. 后端 P0（写入安全 + Official 语义）
2. 前端/集成 P0（切换与保存主链路）
3. E2E P0（完整回路）
4. P1 与人工补测
