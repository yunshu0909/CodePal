/**
 * V0.12 E2E 测试配置
 *
 * 负责：
 * - 指定 Electron E2E 用例目录
 * - 串行执行确保文件系统断言稳定
 *
 * @module 自动化测试/V0.12/playwright.config
 */

const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'electron',
      use: {
        browserName: 'chromium',
      },
    },
  ],
})
