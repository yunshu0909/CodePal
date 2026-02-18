/**
 * V0.9 新建项目正式版 E2E 测试
 *
 * 负责：
 * - 在真实 Electron 环境验证项目初始化页面主流程
 * - 验证创建后目录/模板/Git 落盘结果
 * - 验证冲突校验失败弹窗与重试行为
 *
 * @module 自动化测试/V0.9/tests/e2e/project-init.v09.formal-electron.spec
 */

const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const GIT_AVAILABLE = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0

/**
 * 预置中央仓库 skill，确保应用稳定进入工作台
 * @param {string} homeDir - 测试 HOME 路径
 * @returns {Promise<void>}
 */
async function seedCentralRepo(homeDir) {
  const skillDir = path.join(homeDir, 'Documents', 'SkillManager', 'seed-skill')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Seed Skill\n用于 V0.9 E2E 启动\n', 'utf-8')
}

/**
 * 进入新建项目页面
 * @param {import('@playwright/test').Page} page - 当前窗口
 * @returns {Promise<void>}
 */
async function openProjectInitPage(page) {
  await page.getByRole('button', { name: /新建项目/ }).click()
  await expect(page.getByTestId('project-init-title')).toBeVisible()
}

/**
 * 填写初始化表单
 * @param {import('@playwright/test').Page} page - 当前窗口
 * @param {{projectName: string, targetPath: string, gitMode?: 'root'|'code'|'none'}} params - 表单参数
 * @returns {Promise<void>}
 */
async function fillProjectForm(page, params) {
  const { projectName, targetPath, gitMode = 'root' } = params
  await page.getByTestId('project-name-input').fill(projectName)
  await page.getByTestId('target-path-input').fill(targetPath)

  if (gitMode !== 'root') {
    await page.getByTestId(`git-mode-${gitMode}`).click()
  }
}

/**
 * 断言并确认成功弹窗
 * @param {import('@playwright/test').Page} page - 当前窗口
 * @returns {Promise<void>}
 */
async function assertAndConfirmSuccessModal(page) {
  await expect(page.getByTestId('project-init-success-modal')).toBeVisible()
  await page.getByTestId('project-init-success-confirm-button').click()
  await expect(page.getByTestId('project-init-success-modal')).toBeHidden()
}

/**
 * 断言失败弹窗可见并包含关键信息
 * @param {import('@playwright/test').Page} page - 当前窗口
 * @param {RegExp|string} titleText - 标题文本
 * @param {RegExp|string} messageText - 错误信息文本
 * @returns {Promise<void>}
 */
async function assertErrorModalVisible(page, titleText, messageText) {
  await expect(page.getByTestId('project-init-error-modal')).toBeVisible()
  await expect(page.getByTestId('project-init-error-modal').getByText(titleText)).toBeVisible()
  await expect(page.getByTestId('project-init-error-modal').getByText(messageText)).toBeVisible()
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

test.describe('V0.9 Project Init Formal E2E (Electron)', () => {
  let electronApp
  let page
  let tempHome
  let workspaceRoot

  test.beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'v09-project-init-e2e-'))
    workspaceRoot = path.join(tempHome, 'workspace')

    await fs.mkdir(workspaceRoot, { recursive: true })
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

  test.beforeEach(async () => {
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openProjectInitPage(page)
  })

  test('E2E-01: none 模式应创建目录与模板文件', async () => {
    const projectName = 'v09-e2e-none'
    const projectRoot = path.join(workspaceRoot, projectName)

    await fillProjectForm(page, {
      projectName,
      targetPath: workspaceRoot,
      gitMode: 'none',
    })
    await page.getByTestId('create-project-button').click()

    await assertAndConfirmSuccessModal(page)

    expect(await pathExists(path.join(projectRoot, 'AGENTS.md'))).toBe(true)
    expect(await pathExists(path.join(projectRoot, 'CLAUDE.md'))).toBe(true)
    expect(await pathExists(path.join(projectRoot, 'design', 'design-system.html'))).toBe(true)
    expect(await pathExists(path.join(projectRoot, 'prd'))).toBe(true)
    expect(await pathExists(path.join(projectRoot, 'code'))).toBe(true)
  })

  test('E2E-02: root 模式应在项目根目录初始化 .git', async () => {
    test.skip(!GIT_AVAILABLE, '当前环境未安装 git，跳过 root Git 初始化断言')

    const projectName = 'v09-e2e-root'
    const projectRoot = path.join(workspaceRoot, projectName)

    await fillProjectForm(page, {
      projectName,
      targetPath: workspaceRoot,
      gitMode: 'root',
    })
    await page.getByTestId('create-project-button').click()

    await assertAndConfirmSuccessModal(page)
    expect(await pathExists(path.join(projectRoot, '.git'))).toBe(true)
  })

  test('E2E-03: 冲突场景应展示校验失败弹窗且保留旧文件', async () => {
    const projectName = 'v09-e2e-conflict'
    const projectRoot = path.join(workspaceRoot, projectName)
    const agentsPath = path.join(projectRoot, 'AGENTS.md')

    await fs.mkdir(projectRoot, { recursive: true })
    await fs.writeFile(agentsPath, 'legacy-agents-content\n', 'utf-8')

    await fillProjectForm(page, {
      projectName,
      targetPath: workspaceRoot,
      gitMode: 'none',
    })
    await page.getByTestId('create-project-button').click()

    await assertErrorModalVisible(page, '创建前校验未通过', /目标路径存在冲突|目标文件已存在/)
    await expect(page.getByTestId('project-init-error-retry-button')).toBeVisible()
    await page.getByTestId('project-init-error-close-button').click()
    await expect(page.getByTestId('project-init-error-modal')).toBeHidden()

    const content = await fs.readFile(agentsPath, 'utf-8')
    expect(content).toBe('legacy-agents-content\n')
  })

  test('E2E-04: 冲突修复后点击重试应成功并展示成功弹窗', async () => {
    const projectName = 'v09-e2e-conflict-resolved'
    const projectRoot = path.join(workspaceRoot, projectName)
    const agentsPath = path.join(projectRoot, 'AGENTS.md')

    await fs.mkdir(projectRoot, { recursive: true })
    await fs.writeFile(agentsPath, 'legacy-conflict-content\n', 'utf-8')

    await fillProjectForm(page, {
      projectName,
      targetPath: workspaceRoot,
      gitMode: 'none',
    })
    await page.getByTestId('create-project-button').click()
    await assertErrorModalVisible(page, '创建前校验未通过', /目标路径存在冲突|目标文件已存在/)

    await fs.rm(agentsPath, { force: true })
    await page.getByTestId('project-init-error-retry-button').click()
    await assertAndConfirmSuccessModal(page)

    expect(await pathExists(path.join(projectRoot, 'AGENTS.md'))).toBe(true)
  })
})
