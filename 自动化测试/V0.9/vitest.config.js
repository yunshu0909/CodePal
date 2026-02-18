/**
 * V0.9 兼容测试配置（聚合入口）
 *
 * 负责：
 * - 提供单配置运行 V0.9 backend + integration 的兼容入口
 * - 默认使用 jsdom，配合前端集成测试运行
 *
 * @module 自动化测试/V0.9/vitest.config
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
    setupFiles: ['自动化测试/V0.9/tests/setup.js'],
    include: ['自动化测试/V0.9/tests/**/*.{test,spec}.{js,jsx}'],
    exclude: ['自动化测试/V0.9/tests/e2e/**'],
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
    },
  },
})
