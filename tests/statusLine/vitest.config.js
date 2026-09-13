/**
 * statusLine 回归套件配置
 *
 * 覆盖：statusLine 上下文占比的窗口来源修正（原 V1.9.14 单元，随旧 自动化测试/ 目录一起下线后迁入 tests/）
 * - 资格地基：渲染无残留占位符 / SCRIPT_VERSION / Python 语法
 * - 权威字段优先：payload.context_window 的窗口与比例压倒模型名启发式
 * - 老版本回退：无 context_window 字段时仍走 transcript + 启发式，行为不变
 * - 健壮性：字段类型异常不崩、无 usage 不出上下文段
 * - 贯穿安全：事前 HOME 沙箱 + 路径重定向，绝不污染真实 ~/.claude
 *
 * 纯 Node 端（spawn bash 跑渲染脚本），不需要 jsdom。
 *
 * @module tests/statusLine/vitest.config
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
    include: ['tests/statusLine/**/*.{test,spec}.{js,jsx}'],
    css: false,
    testTimeout: 30000,
  },
})
