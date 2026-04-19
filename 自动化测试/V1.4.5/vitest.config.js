/**
 * V1.4.5 测试配置
 *
 * 负责：
 * - 覆盖 sessionResumeService（Node 环境，读文件 + execFile）
 * - 覆盖 SessionBrowserPage 新增的启动按钮交互（jsdom 环境）
 *
 * @module 自动化测试/V1.4.5/vitest.config
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
    setupFiles: ['自动化测试/V1.4.5/setup.js'],
    include: ['自动化测试/V1.4.5/**/*.{test,spec}.{js,jsx}'],
    css: false,
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
    },
  },
})
