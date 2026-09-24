/**
 * Vitest 测试配置文件
 *
 * 负责：
 * - 单元测试配置
 * - 覆盖率报告设置
 * - 测试环境配置
 *
 * @module vitest.config
 */

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.{test,spec}.{js,jsx}'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './tests/coverage',
      // 主进程（文件读写、配置写入）才是风险集中处，覆盖率要算上
      include: ['src/**/*.{js,jsx}', 'electron/**/*.{js,mjs}'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/.*',
        'dist/',
        '**/*.config.*',
        'src/main.jsx',
        'src/App.jsx'
      ]
    },
    reporters: ['default', 'html'],
    outputFile: {
      html: './tests/report/index.html'
    }
  },
  resolve: {
    alias: {
      '@': '/src'
    }
  }
})
