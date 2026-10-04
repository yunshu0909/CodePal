/**
 * Skills 只留一套引擎（specs/v2.1.9-Skills只留一套引擎）：顺带清扫
 *
 * 负责：
 * - （两处换新颜色有可见变化，2026-10-02 用户选择挪到 #62 和设计确认一起做，本版不改样式）
 * - TC-009：claudeSettingsService 里只有已停用代码在调的 API 配置残留函数删掉，其余导出照常
 * - TC-019（v2.1.11 起）：产品版本三处一致，当前 2.1.12
 *
 * @module tests/oneEngineCleanup.test
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf-8')

describe('顺带清扫', () => {
  it('TC-009 API_CONFIG_RESIDUE API 配置残留函数删掉，其余导出照常', () => {
    const source = read('electron/services/claudeSettingsService.js')
    for (const name of ['ensureClaudeApiKeyHelperScript', 'applyProviderProfileToSettings']) {
      expect(source.includes(name), `API_CONFIG_RESIDUE claudeSettingsService 仍有 ${name}`).toBe(false)
    }
    const service = require('../electron/services/claudeSettingsService')
    expect(typeof service.mutateClaudeSettingsFile).toBe('function')
    expect(typeof service.createClaudeSettingsService).toBe('function')
  })

  // 产品版本随每个任务升号（specs/v2.1.11-Skills要处理-实现 起由 TC-019 守着；原 TC-011 的 2.1.9 断言随之改为当前版本）
  it('SC-001 TC-050 TC-019 VERSION_2112 package.json、package-lock.json 与 README 徽章都是 2.1.12', () => {
    const pkg = JSON.parse(read('package.json'))
    const lock = JSON.parse(read('package-lock.json'))
    expect(pkg.version, 'VERSION_2112 package.json').toBe('2.1.12')
    expect(lock.version, 'VERSION_2112 package-lock.json').toBe('2.1.12')
    expect(lock.packages[''].version).toBe('2.1.12')
    expect(read('README.md'), 'VERSION_2112 README 徽章').toContain('version-v2.1.12-blue')
  })
})
