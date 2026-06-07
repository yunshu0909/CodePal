/**
 * V1.9.3 兼容测试配置（Codex 会员额度）
 *
 * 负责：
 * - 运行 Codex 额度读取服务的后端行为测试（node 环境，纯函数 + 依赖注入）
 *
 * @module 自动化测试/V1.9.3/vitest.config
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
    include: ['自动化测试/V1.9.3/tests/**/*.{test,spec}.{js,jsx}'],
  },
})
