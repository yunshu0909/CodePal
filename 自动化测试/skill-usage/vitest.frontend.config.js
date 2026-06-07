/**
 * Skill 使用次数统计 前端测试配置（jsdom + React）
 *
 * 负责：运行 SkillUsageBadge 等前端组件渲染测试
 * 注：版本待定，定版后随目录改名为 Vx.x。
 *
 * @module 自动化测试/skill-usage/vitest.frontend.config
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
    setupFiles: ['自动化测试/skill-usage/tests/setup.js'],
    include: ['自动化测试/skill-usage/tests/frontend/**/*.{test,spec}.{js,jsx}'],
  },
  resolve: {
    alias: { '@': resolve(projectRoot, 'src') },
  },
})
