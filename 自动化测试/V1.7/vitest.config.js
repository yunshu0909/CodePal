/**
 * V1.7 测试配置 · Codex 账户管理重写
 *
 * 覆盖：
 * - 模块 A 数据迁移与目录构建（TC-001 ~ TC-013）
 * - 模块 B OAuth 错误分类与状态机（TC-014 ~ TC-021）
 * - 模块 C CODEX_HOME 注入 + symlink 透明性（TC-022 ~ TC-027，真 Key）
 * - 模块 D 切换、保活与调度（TC-028 ~ TC-040）
 * - 模块 E 复杂长链路（TC-100、TC-101，真 Key）
 * - 贯穿安全（TC-S01 ~ TC-S05）
 *
 * 测试隔离：每个用例通过 CODEX_SWITCHER_HOME 覆盖路径，避免污染真实 ~/.codex-switcher/
 * 详见 setup/testEnv.js
 *
 * @module 自动化测试/V1.7/vitest.config
 */

import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const configDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(configDir, '../..')

export default defineConfig({
  root: projectRoot,
  test: {
    environment: 'node',
    globals: true,
    include: ['自动化测试/V1.7/**/*.{test,spec}.{js,jsx}'],
    css: false,
    testTimeout: 30000,
    hookTimeout: 15000,
  },
})
