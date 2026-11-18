/** @vitest-environment node
 * #83 第 5 条：业务代码不借别的模块「仅供测试」的接口（__testing），要用就正式导出。
 */
import { expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(__dirname, '..', '..')

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(full)
    return /\.(c?js|jsx|mjs)$/.test(entry.name) ? [full] : []
  })
}

it('#83-5 electron/ 和 src/ 里没有地方读别的模块的 __testing', () => {
  const offenders = ['electron', 'src'].flatMap((dir) => files(path.join(ROOT, dir)))
    .filter((file) => /\.__testing\b/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file))
  expect(offenders).toEqual([])
})

it('#83-5 系统管理设置的候选路径正式导出，插件管理和 Claude 设置看的是同一组', () => {
  const claudeSettings = require('../../electron/services/claudeSettingsService.js')
  expect(typeof claudeSettings.managedSettingsPaths).toBe('function')
  const expected = { darwin: ['/Library/Application Support/ClaudeCode/managed-settings.json'], linux: ['/etc/claude-code/managed-settings.json'] }
  expect(claudeSettings.managedSettingsPaths()).toEqual(expected[process.platform] || [])
})
