import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    // 测试报告 / 覆盖率 / 构建产物不是应用代码：跑测试时会写这些目录，
    // 不忽略的话 dev server 会把整页重载（2026-09-13 实测刷了十几次）。
    watch: {
      ignored: ['**/tests/report/**', '**/tests/coverage/**', '**/dist/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
