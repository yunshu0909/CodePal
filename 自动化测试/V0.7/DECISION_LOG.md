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
