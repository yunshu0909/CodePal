/**
 * V0.12 启动模式正式版 E2E 测试
 *
 * 负责：
 * - 在真实 Electron 环境验证启动模式页面主流程
 * - 验证 settings.json 在真实文件系统中的写入结果
 * - 验证未知模式与读取失败重试链路
 *
 * @module 自动化测试/V0.12/tests/e2e/permission-mode.v12.formal-electron.spec
 */

const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

/**
 * 预置中央仓库 skill，确保应用稳定进入工作台
 * @param {string} homeDir - 测试 HOME 路径
 * @returns {Promise<void>}
 */
async function seedCentralRepo(homeDir) {
  const skillDir = path.join(homeDir, 'Documents', 'SkillManager', 'seed-skill')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Seed Skill\n用于 V0.12 E2E 启动\n', 'utf-8')
}

/**
 * 判断路径是否存在
 * @param {string} checkPath - 目标路径
 * @returns {Promise<boolean>}
 */
async function pathExists(checkPath) {
  try {
    await fs.access(checkPath)
    return true
  } catch {
    return false
  }
}

/**
 * 写入 settings.json
 * @param {string} settingsPath - settings 文件路径
 * @param {string|object} data - 写入数据
 * @returns {Promise<void>}
 */
async function writeSettings(settingsPath, data) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  const content = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`
  await fs.writeFile(settingsPath, content, 'utf-8')
}

/**
 * 打开启动模式页面
 * @param {import('@playwright/test').Page} page - 当前窗口
 * @returns {Promise<void>}
 */
async function openPermissionModePage(page) {
  await page.getByRole('button', { name: /启动模式/ }).click()
  await expect(page.getByTestId('permission-page-header')).toBeVisible()
}

/**
 * 刷新并进入启动模式页面
 * @param {import('@playwright/test').Page} page - 当前窗口
 * @returns {Promise<void>}
 */
async function reloadAndOpenPermissionModePage(page) {
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await openPermissionModePage(page)
}

test.describe('V0.12 Permission Mode Formal E2E (Electron)', () => {
  let electronApp
  let page
  let tempHome
  let settingsPath

  test.beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'v12-permission-mode-e2e-'))
    settingsPath = path.join(tempHome, '.claude', 'settings.json')

    await seedCentralRepo(tempHome)

    test.setTimeout(90000)
    electronApp = await electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOME: tempHome,
      },
      timeout: 90000,
    })

    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close()
    }
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true })
    }
  })

  test('TC-E2E-01: 未配置态应可切换并写入 settings.json', async () => {
    await fs.rm(settingsPath, { force: true })

    await reloadAndOpenPermissionModePage(page)

    await expect(page.getByTestId('permission-current-mode')).toContainText('每次询问')
    await page.getByTestId('permission-switch-button-acceptEdits').click()

    await expect(page.getByText('已切换至「自动编辑」')).toBeVisible()
    await expect(page.getByTestId('permission-current-mode')).toContainText('自动编辑')

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(parsed.permissions.defaultMode).toBe('acceptEdits')
  })

  test('TC-E2E-02: 未知模式配置应展示警告态', async () => {
    await writeSettings(settingsPath, {
      permissions: {
        defaultMode: 'dontAsk',
      },
    })

    await reloadAndOpenPermissionModePage(page)

    await expect(page.getByTestId('permission-warn-banner')).toBeVisible()
    await expect(page.getByTestId('permission-warn-banner')).toContainText('未知的启动模式')
    await expect(page.locator('.tag--success')).toHaveCount(0)
  })

  test('TC-E2E-03: JSON 解析错误应可通过重试恢复', async () => {
    await writeSettings(settingsPath, '{"permissions": {"defaultMode": "plan", }')

    await reloadAndOpenPermissionModePage(page)

    await expect(page.getByTestId('permission-error-state')).toBeVisible()
    await expect(page.getByTestId('permission-error-code')).toContainText('JSON_PARSE_ERROR')

    // 在点击重试前修复文件，验证重试会重新读取并恢复正常态。
    await writeSettings(settingsPath, {
      permissions: {
        defaultMode: 'plan',
      },
    })

    await page.getByTestId('permission-retry-button').click()
    await expect(page.getByTestId('permission-mode-section')).toBeVisible()
    await expect(page.getByTestId('permission-current-mode')).toContainText('只读规划')

    expect(await pathExists(settingsPath)).toBe(true)
  })
})
