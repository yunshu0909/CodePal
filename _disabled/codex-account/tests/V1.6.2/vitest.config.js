/**
 * V1.6.2 测试配置
 *
 * 覆盖：
 * - codexTokenRefresher（主动续签 + sweep + crash recovery + inflight 去重）
 * - codexJwtUtils（V1.6.2 新增：fail-closed + mtime 兜底）
 * - codexAccountService（V1.6.2 新增：sync 失败拦截 + lazy refresh）
 * - codexProcessService（切换前完整退出 / 重启 Codex）
 *
 * @module 自动化测试/V1.6.2/vitest.config
 */

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const configDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(configDir, '../..')

export default defineConfig({
  root: projectRoot,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['自动化测试/V1.6.2/setup.js'],
    include: ['自动化测试/V1.6.2/**/*.{test,spec}.{js,jsx}'],
    css: false,
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
    },
  },
})
