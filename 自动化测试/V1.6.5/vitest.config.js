/**
 * V1.6.5 测试配置
 *
 * 覆盖：statusLine 第二行 Git 信息（git:<分支>@<最近tag><脏标记>）
 * - 资格地基：渲染无残留占位符 / SCRIPT_VERSION=7 / Python 语法 / 输出点关系 / 版本重写链路
 * - 能力：cwd 取值 / 分支 / detached / tag / 脏 / 非 git / git 不可用 / 颜色 / 耦合4态 / 超时
 * - 端到端：双层 git 命中最近 .git
 * - 贯穿安全：第一行零改动回归 / 事前隔离不污染
 *
 * 纯 Node 端（spawn bash 跑渲染脚本），不需要 jsdom。
 *
 * @module 自动化测试/V1.6.5/vitest.config
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
    include: ['自动化测试/V1.6.5/**/*.{test,spec}.{js,jsx}'],
    css: false,
    testTimeout: 30000,
  },
})
