/**
 * V0.8 测试配置
 *
 * 负责：
 * - 指定 V0.8 测试的运行根目录与匹配范围
 * - 复用 V0.6 测试环境初始化
 * - 配置前端源码别名以便测试引用
 *
 * @module 自动化测试/V0.8/vitest.config
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
    setupFiles: ['自动化测试/V0.6/tests/setup.js'],
    include: ['自动化测试/V0.8/tests/**/*.{test,spec}.{js,jsx}'],
    exclude: ['自动化测试/V0.8/tests/e2e/**']
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src')
    }
  }
})
