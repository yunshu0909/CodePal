# Decision Log - 2026-02-15（V0.7 供应商切换：env+settings 双层方案）

## 背景

- 问题：页面切换显示已成功，但 Claude 实际仍走 Official。
- 现状原因：旧实现仅写 `skill-manager/.env`，未同步 `~/.claude/settings.json`。

## 决策

- 继续保留 `.env` 作为密钥来源（开源安全边界不变）。
- 切换时新增同步写 `~/.claude/settings.json`，让 Claude 运行时立即读到正确 `ANTHROPIC_*`。
- 若 `settings` 写失败，则自动回滚 `.env` 到切换前快照，避免双轨状态分裂。
- 页面“当前使用”改为优先按 `settings` 实际生效状态识别。

## 备选方案与取舍

- 方案 A：只写 `settings.json`。
  - 放弃原因：多供应商密钥管理分散，不利于统一维护与开源协作说明。
- 方案 B：只写 `.env`。
  - 放弃原因：Claude 运行时不直接消费该文件，容易出现“UI 成功但实际未生效”。

## 回滚方案

- 代码层：回滚 `electron/main.js` 本次变更即可恢复旧行为。
- 运行态：若切换失败，当前实现会自动回滚 `.env`；`settings` 侧保留备份文件用于手工恢复。

---

## 2026-02-20 增量决策（认证分流升级）

### 背景

- 问题：用户登出 Claude 账号后，切换到第三方供应商仍出现登录向导，影响可用性。
- 根因：CLI 登录判断优先读取运行时 API 来源（环境变量/apiKeyHelper），仅写 `settings.env` 无法稳定绕开登录链路。

### 决策

- 认证分流规则固定：
  - `Claude Official`：只走登录链路。
  - `Kimi / AICodeMirror`：走 API 链路（`ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` + `apiKeyHelper`）。
- 切到第三方时自动写托管 helper：`~/.claude/skill-manager-api-key-helper.sh`。
- 切回 Official 时无条件清理托管 `apiKeyHelper`，避免继续走 API 鉴权。
- settings 同步字段主通道改为 `ANTHROPIC_API_KEY`（兼容读取 `ANTHROPIC_AUTH_TOKEN` 作为历史兜底）。
- 页面 custom 交互调整为“可直接切换”，不再增加确认弹窗。

### 回滚方案

- 若需回退旧行为，可移除“helper 写入/清理”逻辑并恢复 `AUTH_TOKEN` 写入方案。
- 风险提示：回退后会重新出现“第三方已配置但仍触发登录向导”的体验问题。
