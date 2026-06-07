/**
 * Skill 使用次数统计 测试配置
 *
 * 负责：运行 skill 使用次数后端测试（三信号计数、过滤、时间窗、部分可用）
 * 注：版本号待定，定版后将本目录重命名为对应 Vx.x 并补 package.json 脚本。
 *
 * @module 自动化测试/skill-usage/vitest.config
 */

import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const configDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(configDir, '../..')

export default defineConfig({
  root: projectRoot,
  test: {
    environment: 'node',
    globals: true,
    include: ['自动化测试/skill-usage/tests/backend/**/*.{test,spec}.{js,jsx}'],
  },
})
