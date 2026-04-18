/**
 * V1.4.4 前端单元测试配置
 *
 * 负责：
 * - 覆盖 usageHistoryUtils / ClaudeUsageTrendCard 异常周期相关逻辑
 * - 复用 V1.4.1 同款 jsdom + react 配置
 *
 * @module 自动化测试/V1.4.4/vitest.config
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
    setupFiles: ['自动化测试/V1.4.4/setup.js'],
    include: ['自动化测试/V1.4.4/**/*.{test,spec}.{js,jsx}'],
    css: false,
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
    },
  },
})
