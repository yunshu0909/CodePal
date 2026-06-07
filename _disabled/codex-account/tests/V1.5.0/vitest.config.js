/**
 * V1.5.0 测试配置
 *
 * 覆盖：
 * - codexJwtUtils（纯函数 JWT 解码）
 * - codexAccountService（文件 IO + execFile mock）
 * - codexAuthWatcher（chokidar 事件触发）
 *
 * @module 自动化测试/V1.5.0/vitest.config
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
    setupFiles: ['自动化测试/V1.5.0/setup.js'],
    include: ['自动化测试/V1.5.0/**/*.{test,spec}.{js,jsx}'],
    css: false,
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
    },
  },
})
