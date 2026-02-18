/**
 * V0.9 前端集成测试配置
 *
 * 负责：
 * - 指定页面集成测试运行范围
 * - 使用 jsdom 执行 React 交互测试
 * - 配置源码别名与测试初始化脚本
 *
 * @module 自动化测试/V0.9/vitest.integration.config
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
    include: ['自动化测试/V0.9/tests/integration/**/*.{test,spec}.{js,jsx}'],
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
    },
  },
})
