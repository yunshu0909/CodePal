/**
 * V0.7 API 配置正式版 E2E 测试
 *
 * 负责：
 * - 在真实 Electron 环境验证 API 配置页面交互
 * - 验证前端点击后主进程写入 ~/.claude/settings.json
 * - 验证切换时备份生成与 Official 清理语义
 *
 * @module 自动化测试/V0.7/tests/e2e/api-config.v07.formal-electron.spec
 */

const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const dotenv = require('dotenv')

/**
 * 读取项目 .env 里的供应商参数（缺失时回退到测试默认值）
 * @returns {{kimi: {token: string, baseUrl: string}, aicodemirror: {token: string, baseUrl: string}}}
 */
function loadProviderFixturesFromProjectEnv() {
  const defaults = {
    kimi: {
      token: 'sk-kimi-test-key-for-e2e-testing-only',
      baseUrl: 'https://api.kimi.com/coding/',
    },
    aicodemirror: {
      token: 'sk-ant-test-key-for-e2e-testing-only',
      baseUrl: 'https://api.aicodemirror.com/api/claudecode',
    },
  }

  try {
    const envPath = path.resolve(__dirname, '../../../../.env')
    if (!fsSync.existsSync(envPath)) return defaults

    const env = dotenv.parse(fsSync.readFileSync(envPath, 'utf-8'))
    return {
      kimi: {
        token: env.KIMI_API_KEY || defaults.kimi.token,
        baseUrl: env.KIMI_BASE_URL || defaults.kimi.baseUrl,
      },
      aicodemirror: {
        token: env.AICODEMIRROR_API_KEY || defaults.aicodemirror.token,
        baseUrl: env.AICODEMIRROR_BASE_URL || defaults.aicodemirror.baseUrl,
      },
    }
  } catch {
    return defaults
  }
}

const PROVIDER_FIXTURES = loadProviderFixturesFromProjectEnv()

/**
 * 构建 settings.json 夹具
 * @param {'official'|'kimi'|'aicodemirror'} profile - 初始供应商档位
 * @returns {Record<string, any>} 配置对象
 */
function buildSettings(profile) {
  const settings = {
    env: {
      FOO: 'BAR',
    },
    model: 'opus',
    permissions: {
      allow: ['mcp__pencil'],
    },
    extra: {
      x: 1,
    },
  }

  if (profile !== 'official') {
    settings.env.ANTHROPIC_API_KEY = PROVIDER_FIXTURES[profile].token
    settings.env.ANTHROPIC_BASE_URL = PROVIDER_FIXTURES[profile].baseUrl
  }

  return settings
}

/**
 * 向测试 HOME 写入 Claude 配置
 * @param {string} homeDir - 测试 HOME 路径
 * @param {Record<string, any>} settings - 配置对象
 * @returns {Promise<string>} settings.json 路径
 */
async function writeClaudeSettings(homeDir, settings) {
  const claudeDir = path.join(homeDir, '.claude')
  const settingsPath = path.join(claudeDir, 'settings.json')
  await fs.mkdir(claudeDir, { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
  return settingsPath
}

/**
 * 读取测试 HOME 下的 Claude 配置
 * @param {string} settingsPath - settings.json 路径
 * @returns {Promise<Record<string, any>>} 配置对象
 */
async function readClaudeSettings(settingsPath) {
  const raw = await fs.readFile(settingsPath, 'utf-8')
  return JSON.parse(raw)
}

/**
 * 预置中央仓库 skill，确保应用可进入 workbench
 * @param {string} homeDir - 测试 HOME 路径
 * @returns {Promise<void>}
 */
async function seedCentralRepo(homeDir) {
  const skillDir = path.join(homeDir, 'Documents', 'SkillManager', 'seed-skill')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Seed Skill\n用于 E2E 启动工作台\n', 'utf-8')
}

/**
 * 进入 API 配置页面
 * @param {import('@playwright/test').Page} page - 当前窗口
 * @returns {Promise<void>}
 */
async function openApiConfigPage(page) {
  await page.getByRole('button', { name: 'API 配置' }).click()
  await expect(page.getByRole('heading', { name: 'API 配置' })).toBeVisible()
}

test.describe('V0.7 API Config Formal E2E (Electron)', () => {
  let electronApp
  let page
  let tempHome
  let settingsPath

  test.beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'v07-formal-e2e-'))
    await seedCentralRepo(tempHome)
    settingsPath = await writeClaudeSettings(tempHome, buildSettings('kimi'))

    test.setTimeout(90000)
    electronApp = await electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOME: tempHome,
        KIMI_API_KEY: PROVIDER_FIXTURES.kimi.token,
        KIMI_BASE_URL: PROVIDER_FIXTURES.kimi.baseUrl,
        AICODEMIRROR_API_KEY: PROVIDER_FIXTURES.aicodemirror.token,
        AICODEMIRROR_BASE_URL: PROVIDER_FIXTURES.aicodemirror.baseUrl,
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
    // 每个用例重置为 Kimi，避免上个用例状态污染
    await writeClaudeSettings(tempHome, buildSettings('kimi'))
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openApiConfigPage(page)
  })

  test('E2E-01: 启动后应识别当前 Kimi 配置', async () => {
    await expect(page.locator('.status-value')).toHaveText('Kimi For Coding')
    await expect(page.locator('.provider-item.is-selected .provider-name')).toHaveText('Kimi For Coding')
  })

  test('E2E-02: 切换到 AICodeMirror 后应写入 settings 与备份', async () => {
    const targetCard = page
      .locator('.provider-item')
      .filter({ has: page.locator('.provider-name', { hasText: /^AICodeMirror$/ }) })
    await targetCard.getByRole('button', { name: '启用' }).click()

    await expect(page.locator('.status-value')).toHaveText('AICodeMirror')

    const settings = await readClaudeSettings(settingsPath)
    expect(settings.env.ANTHROPIC_API_KEY).toBe(PROVIDER_FIXTURES.aicodemirror.token)
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(PROVIDER_FIXTURES.aicodemirror.baseUrl)
    expect(settings.apiKeyHelper).toBe(path.join(tempHome, '.claude', 'skill-manager-api-key-helper.sh'))
    expect(settings.model).toBe('opus')
    expect(settings.env.FOO).toBe('BAR')
    expect(settings.extra).toEqual({ x: 1 })

    const backupDir = path.join(tempHome, '.claude', 'backups')
    const backupFiles = await fs.readdir(backupDir)
    expect(backupFiles.length).toBeGreaterThan(0)
  })

  test('E2E-03: 切回 Official 应清理托管认证字段且保留无关字段', async () => {
    const officialCard = page
      .locator('.provider-item')
      .filter({ has: page.locator('.provider-name', { hasText: /^Claude Official$/ }) })
    await officialCard.getByRole('button', { name: '启用' }).click()

    await expect(page.locator('.status-value')).toHaveText('Claude Official')

    const settings = await readClaudeSettings(settingsPath)
    expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(settings.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(settings.apiKeyHelper).toBeUndefined()
    expect(settings.model).toBe('opus')
    expect(settings.env.FOO).toBe('BAR')
    expect(settings.permissions).toEqual({ allow: ['mcp__pencil'] })
  })
})
