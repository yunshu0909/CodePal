/**
 * V0.4 历史回归单元测试
 *
 * 负责：
 * - 验证 V0.1~V0.4 的核心数据层行为
 * - 覆盖导入、推送、配置与增量导入规则
 *
 * @module auto-test/v04/unit/data-regression
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dataStore, toolDefinitions } from '@/store/data.js'

vi.mock('@/store/fs.js', () => ({
  scanToolDirectory: vi.fn(),
  copySkill: vi.fn(),
  deleteSkill: vi.fn(),
  ensureDir: vi.fn(),
  pathExists: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  selectFolder: vi.fn(),
  scanCustomPath: vi.fn(),
  compareSkillContent: vi.fn(),
}))

import {
  scanToolDirectory,
  copySkill,
  deleteSkill,
  ensureDir,
  pathExists,
  readConfig,
  writeConfig,
  scanCustomPath,
} from '@/store/fs.js'

function makeBaseConfig(overrides = {}) {
  return {
    version: '0.4',
    repoPath: '~/Documents/SkillManager/',
    customPaths: [],
    pushStatus: {},
    pushTargets: [],
    importSources: [],
    firstEntryAfterImport: false,
    ...overrides,
  }
}

describe('dataStore V0.4 历史回归', () => {
  beforeEach(() => {
    dataStore.clearConfigCache()
    dataStore.clearPushStatusCache()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('UT-01: getPushTargets 在空配置时回退到全部预设工具', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeBaseConfig({ pushTargets: [] }),
    })
    writeConfig.mockResolvedValue({ success: true })

    const targets = await dataStore.getPushTargets()

    expect(targets).toEqual(toolDefinitions.map((tool) => tool.id))
    expect(writeConfig).toHaveBeenCalledTimes(1)
  })

  it('UT-02: initPushTargetsAfterImport 在有预设工具时仅保存预设工具', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeBaseConfig({ pushTargets: ['cursor'] }),
    })
    writeConfig.mockResolvedValue({ success: true })

    const result = await dataStore.initPushTargetsAfterImport(['claude-code', 'custom-1001'])

    expect(result.success).toBe(true)
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.pushTargets).toEqual(['claude-code'])
  })

  it('UT-03: initPushTargetsAfterImport 在仅自定义路径时回退到全部预设工具', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeBaseConfig({ pushTargets: ['cursor'] }),
    })
    writeConfig.mockResolvedValue({ success: true })

    const result = await dataStore.initPushTargetsAfterImport(['custom-2001'])

    expect(result.success).toBe(true)
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.pushTargets).toEqual(toolDefinitions.map((tool) => tool.id))
  })

  it('UT-04: importSkills 使用强制覆盖并设置首次进入标记', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeBaseConfig(),
    })
    writeConfig.mockResolvedValue({ success: true })
    ensureDir.mockResolvedValue({ success: true })
    scanToolDirectory.mockResolvedValue({
      success: true,
      skills: [{ name: 'commit-helper', displayName: 'Commit Helper', desc: 'desc' }],
      error: null,
    })
    copySkill.mockResolvedValue({ success: true })

    // 只验证导入流程逻辑，避免在本用例里重复测试 setFirstEntryAfterImport 内部实现
    const setFirstEntrySpy = vi
      .spyOn(dataStore, 'setFirstEntryAfterImport')
      .mockResolvedValue({ success: true, error: null })

    const result = await dataStore.importSkills(['claude-code'])

    expect(result.success).toBe(true)
    expect(result.copiedCount).toBe(1)
    expect(copySkill).toHaveBeenCalledWith(
      '~/.claude/skills/commit-helper',
      '~/Documents/SkillManager/commit-helper',
      { force: true }
    )
    expect(setFirstEntrySpy).toHaveBeenCalledWith(true)
    expect(dataStore.getLastImportedToolIds()).toEqual(['claude-code'])
  })

  it('UT-05: unpushSkills 对 SOURCE_NOT_FOUND 做静默成功处理', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeBaseConfig({
        pushStatus: {
          'claude-code': ['commit-helper'],
        },
      }),
    })
    writeConfig.mockResolvedValue({ success: true })
    deleteSkill.mockResolvedValue({ success: false, error: 'SOURCE_NOT_FOUND' })

    const result = await dataStore.unpushSkills('claude-code', ['commit-helper'])

    expect(result.success).toBe(true)
    expect(result.unpushedCount).toBe(1)
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.pushStatus['claude-code']).toEqual([])
  })

  it('UT-06: incrementalImport 对已存在技能跳过，对新增技能执行仅新增复制', async () => {
    vi.spyOn(dataStore, 'getCentralSkills').mockResolvedValue([{ name: 'existing-skill' }])
    readConfig.mockResolvedValue({
      success: true,
      data: makeBaseConfig({
        customPaths: [{ id: 'cp-1', path: '/workspace/team-skills', skills: {} }],
      }),
    })
    writeConfig.mockResolvedValue({ success: true })
    ensureDir.mockResolvedValue({ success: true })
    scanCustomPath.mockResolvedValue({
      success: true,
      skills: {
        'claude-code': 2,
      },
      error: null,
    })
    scanToolDirectory.mockResolvedValue({
      success: true,
      skills: [{ name: 'existing-skill' }, { name: 'new-skill' }],
      error: null,
    })
    copySkill.mockResolvedValue({ success: true })

    const result = await dataStore.incrementalImport(['cp-1'])

    expect(result.success).toBe(true)
    expect(result.added).toBe(1)
    expect(result.skipped).toBe(1)
    expect(copySkill).toHaveBeenCalledTimes(1)
    expect(copySkill).toHaveBeenCalledWith(
      '/workspace/team-skills/.claude/skills/new-skill',
      '~/Documents/SkillManager/new-skill',
      { force: false }
    )
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.pushStatus['custom-cp-1-claude-code']).toEqual(['new-skill'])
  })

  it('UT-07: pushSkills 在中央仓库缺失时返回失败且不执行复制', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeBaseConfig({ pushStatus: {} }),
    })
    writeConfig.mockResolvedValue({ success: true })
    pathExists.mockResolvedValue({ success: true, exists: false, error: null })

    const result = await dataStore.pushSkills('claude-code', ['missing-skill'])

    expect(result.success).toBe(false)
    expect(result.pushedCount).toBe(0)
    expect(copySkill).not.toHaveBeenCalled()
  })

  it('UT-08: saveImportSources 对非法入参返回 INVALID_SOURCES', async () => {
    const result = await dataStore.saveImportSources('not-array')
    expect(result.success).toBe(false)
    expect(result.error).toBe('INVALID_SOURCES')
  })
})
