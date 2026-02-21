/**
 * V0.7 供应商切换后端行为测试
 *
 * 负责：
 * - 验证三档切换写入规则（official/kimi/aicodemirror）
 * - 验证备份生成与原子写结果可读
 * - 验证 dry-run 与异常输入（损坏 JSON）
 *
 * @module 自动化测试/V0.7/tests/unit/backend/claudeProviderSwitch.v07.behavior.test
 */

// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * 读取 JSON 文件
 * @param {string} filePath - 文件路径
 * @returns {Record<string, any>} 解析后的对象
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

/**
 * 创建临时 settings 文件
 * @param {Record<string, any>} initialConfig - 初始配置
 * @returns {{tmpDir: string, settingsPath: string}} 临时目录与文件路径
 */
function createTempSettings(initialConfig) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v07-provider-switch-'))
  const settingsPath = path.join(tmpDir, 'settings.json')
  fs.writeFileSync(settingsPath, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf-8')
  return { tmpDir, settingsPath }
}

/**
 * 执行切换脚本命令
 * @param {string[]} args - 额外命令参数
 * @returns {{status: number | null, stdout: string, stderr: string}} 命令输出
 */
function runSwitchScript(args) {
  const scriptPath = path.resolve(process.cwd(), '../scripts/claude_provider_switch.py')
  const result = spawnSync('python3', [scriptPath, ...args], {
    encoding: 'utf-8',
  })

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

describe('V0.7 Backend Provider Switch Behavior', () => {
  let fixture

  beforeEach(() => {
    fixture = createTempSettings({
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
    })
  })

  it('TC-S3-BE-01/04/05: 切换 kimi 后应写入供应商字段并保留无关字段', () => {
    const result = runSwitchScript([
      '--settings-path',
      fixture.settingsPath,
      'switch',
      'kimi',
    ])

    expect(result.status).toBe(0)

    const config = readJson(fixture.settingsPath)
    expect(config.env.ANTHROPIC_API_KEY).toContain('sk-kimi-')
    expect(config.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(config.env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding/')
    expect(config.model).toBe('opus')
    const canonicalTmpDir = fs.realpathSync(fixture.tmpDir)
    expect(config.apiKeyHelper).toBe(path.join(canonicalTmpDir, 'skill-manager-api-key-helper.sh'))

    // 无关字段不得被误改
    expect(config.env.FOO).toBe('BAR')
    expect(config.permissions).toEqual({ allow: ['mcp__pencil'] })
    expect(config.extra).toEqual({ x: 1 })

    const helperScriptPath = path.join(fixture.tmpDir, 'skill-manager-api-key-helper.sh')
    expect(fs.existsSync(helperScriptPath)).toBe(true)

    const backupsDir = path.join(fixture.tmpDir, 'backups')
    const backups = fs.readdirSync(backupsDir)
    expect(backups.length).toBeGreaterThan(0)
  })

  it('TC-S3-BE-04: 切换 official 后应清空认证相关字段', () => {
    // 先切到 aicodemirror，确保 token/base_url 存在
    const preSwitch = runSwitchScript([
      '--settings-path',
      fixture.settingsPath,
      'switch',
      'aicodemirror',
    ])
    expect(preSwitch.status).toBe(0)

    const officialSwitch = runSwitchScript([
      '--settings-path',
      fixture.settingsPath,
      'switch',
      'official',
    ])

    expect(officialSwitch.status).toBe(0)

    const config = readJson(fixture.settingsPath)
    expect(config.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(config.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(config.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(config.model).toBe('opus')
    expect(config.apiKeyHelper).toBeUndefined()
    // 无关 env 字段仍在
    expect(config.env.FOO).toBe('BAR')
  })

  it('TC-S3-BE-02: dry-run 不应修改文件内容', () => {
    const before = fs.readFileSync(fixture.settingsPath, 'utf-8')

    const result = runSwitchScript([
      '--settings-path',
      fixture.settingsPath,
      'switch',
      'aicodemirror',
      '--dry-run',
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[DRY RUN]')

    const after = fs.readFileSync(fixture.settingsPath, 'utf-8')
    expect(after).toBe(before)
  })

  it('TC-S3-BE-08: 仅残留 apiKeyHelper 时应识别为 custom，避免误判 official', () => {
    fs.writeFileSync(
      fixture.settingsPath,
      `${JSON.stringify({
        env: {},
        model: 'opus',
        apiKeyHelper: '/tmp/skill-manager-api-key-helper.sh',
      }, null, 2)}\n`,
      'utf-8'
    )

    const result = runSwitchScript([
      '--settings-path',
      fixture.settingsPath,
      'current',
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('当前档位: custom')
  })

  it('TC-S3-BE-07: 配置 JSON 损坏时应返回失败并不覆盖文件', () => {
    fs.writeFileSync(fixture.settingsPath, '{invalid json', 'utf-8')

    const result = runSwitchScript([
      '--settings-path',
      fixture.settingsPath,
      'switch',
      'kimi',
    ])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('JSON 解析失败')
    expect(fs.readFileSync(fixture.settingsPath, 'utf-8')).toBe('{invalid json')
  })
})
