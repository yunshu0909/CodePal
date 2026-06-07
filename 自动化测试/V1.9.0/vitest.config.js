/**
 * V1.9.0 新建项目生成器升级 测试配置
 *
 * 负责：运行 V1.9.0 backend 测试（specs 工作单元、目录拷贝、回滚、通用化硬验收）
 *
 * @module 自动化测试/V1.9.0/vitest.config
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
    include: ['自动化测试/V1.9.0/tests/**/*.{test,spec}.{js,jsx}'],
  },
})
