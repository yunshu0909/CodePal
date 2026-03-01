/**
 * V0.4 数据层全量回归测试
 *
 * 负责：
 * - 覆盖 V0.1~V0.4 关键后端规则与异常分支
 * - 补齐导入来源、推送目标、路径管理、增量导入等细粒度断言
 * - 提供可回归的前后端契约基线（数据层）
 *
 * @module 自动化测试/V0.4/tests/unit/store/data.v04.full-coverage.test
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
  selectFolder,
} from '@/store/fs.js'

/**
 * 生成基础配置
 * @param {object} overrides - 覆盖字段
 * @returns {object}
 */
function makeConfig(overrides = {}) {
  return {
    version: '0.4',
    repoPath: '~/Documents/SkillManager/',
    customPaths: [],
    pushStatus: {},
    pushTargets: ['claude-code', 'codex'],
    importSources: ['claude-code'],
    firstEntryAfterImport: false,
    ...overrides,
  }
}

describe('dataStore V0.4 Full Coverage (Unit)', () => {
  beforeEach(() => {
    dataStore.clearConfigCache()
    dataStore.clearPushStatusCache()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('UT-BE-01: setRepoPath 传入非法路径时返回 INVALID_PATH', async () => {
    const result = await dataStore.setRepoPath('')
    expect(result).toEqual({ success: false, error: 'INVALID_PATH' })
  })

  it('UT-BE-02: setRepoPath 在 ensureDir 失败时返回失败', async () => {
    readConfig.mockResolvedValue({ success: true, data: makeConfig() })
    ensureDir.mockResolvedValue({ success: false, error: 'PERMISSION_DENIED' })

    const result = await dataStore.setRepoPath('/readonly/repo')

    expect(result.success).toBe(false)
    expect(result.error).toBe('PERMISSION_DENIED')
  })

  it('UT-BE-03: setRepoPath 成功后应更新并持久化 repoPath', async () => {
    readConfig.mockResolvedValue({ success: true, data: makeConfig() })
    ensureDir.mockResolvedValue({ success: true, error: null })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.setRepoPath('/Users/demo/new-repo')

    expect(result.success).toBe(true)
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.repoPath).toBe('/Users/demo/new-repo/')
  })

  it('UT-BE-04: addCustomPath 对重复路径应返回 PATH_ALREADY_EXISTS', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeConfig({
        customPaths: [{ id: 'cp-1', path: '/workspace/team', skills: { 'claude-code': 2 } }],
      }),
    })

    const result = await dataStore.addCustomPath('/workspace/team')

    expect(result.success).toBe(false)
    expect(result.error).toBe('PATH_ALREADY_EXISTS')
  })

  it('UT-BE-05: addCustomPath 扫描无结果应返回 NO_SKILLS_FOUND', async () => {
    readConfig.mockResolvedValue({ success: true, data: makeConfig() })
    scanCustomPath.mockResolvedValue({ success: true, skills: {}, error: null })

    const result = await dataStore.addCustomPath('/workspace/empty')

    expect(result.success).toBe(false)
    expect(result.error).toBe('NO_SKILLS_FOUND')
  })

  it('UT-BE-06: addCustomPath 成功后写入配置并返回 customPath', async () => {
    readConfig.mockResolvedValue({ success: true, data: makeConfig() })
    scanCustomPath.mockResolvedValue({
      success: true,
      skills: { 'claude-code': 2, codex: 1 },
      error: null,
    })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.addCustomPath('/workspace/team-skills')

    expect(result.success).toBe(true)
    expect(result.customPath.path).toBe('/workspace/team-skills')
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.customPaths).toHaveLength(1)
    expect(savedConfig.customPaths[0].skills).toEqual({ 'claude-code': 2, codex: 1 })
  })

  it('UT-BE-06A: addCustomPath 应将带尾斜杠的重复路径判定为已存在', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeConfig({
        customPaths: [{ id: 'cp-1', path: '/workspace/team', skills: { codex: 2 } }],
      }),
    })

    const result = await dataStore.addCustomPath('/workspace/team/')

    expect(result.success).toBe(false)
    expect(result.error).toBe('PATH_ALREADY_EXISTS')
  })

  it('UT-BE-07: deleteCustomPath 对无效 ID 返回 INVALID_ID', async () => {
    const result = await dataStore.deleteCustomPath('')
    expect(result).toEqual({ success: false, error: 'INVALID_ID' })
  })

  it('UT-BE-08: deleteCustomPath 对不存在路径返回 PATH_NOT_FOUND', async () => {
    readConfig.mockResolvedValue({ success: true, data: makeConfig({ customPaths: [] }) })

    const result = await dataStore.deleteCustomPath('cp-missing')

    expect(result.success).toBe(false)
    expect(result.error).toBe('PATH_NOT_FOUND')
  })

  it('UT-BE-09: deleteCustomPath 成功后应从配置中移除路径', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeConfig({
        customPaths: [
          { id: 'cp-1', path: '/a', skills: {} },
          { id: 'cp-2', path: '/b', skills: {} },
        ],
      }),
    })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.deleteCustomPath('cp-1')

    expect(result.success).toBe(true)
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.customPaths.map((path) => path.id)).toEqual(['cp-2'])
  })

  it('UT-BE-10: getPushTargets 应清理无效工具ID并保存合法值', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeConfig({ pushTargets: ['claude-code', 'unknown-tool', 'codex'] }),
    })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const targets = await dataStore.getPushTargets()

    expect(targets).toEqual(['claude-code', 'codex'])
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.pushTargets).toEqual(['claude-code', 'codex'])
  })

  it('UT-BE-11: savePushTargets 非数组参数应返回 INVALID_TARGETS', async () => {
    const result = await dataStore.savePushTargets('invalid')
    expect(result).toEqual({ success: false, error: 'INVALID_TARGETS' })
  })

  it('UT-BE-12: savePushTargets 成功时应持久化 targets', async () => {
    readConfig.mockResolvedValue({ success: true, data: makeConfig() })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.savePushTargets(['cursor'])

    expect(result.success).toBe(true)
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.pushTargets).toEqual(['cursor'])
  })

  it('UT-BE-13: saveImportSources 成功时应持久化 sources', async () => {
    readConfig.mockResolvedValue({ success: true, data: makeConfig() })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.saveImportSources(['claude-code', 'custom-1'])

    expect(result.success).toBe(true)
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.importSources).toEqual(['claude-code', 'custom-1'])
  })

  it('UT-BE-14: importSkills 应支持自定义路径来源导入', async () => {
    ensureDir.mockResolvedValue({ success: true, error: null })
    readConfig.mockResolvedValue({
      success: true,
      data: makeConfig({
        customPaths: [{ id: 'custom-1', path: '/workspace/team', skills: {} }],
        pushStatus: {},
      }),
    })
    writeConfig.mockResolvedValue({ success: true, error: null })
    scanCustomPath.mockResolvedValue({
      success: true,
      skills: { 'claude-code': 1 },
      error: null,
    })
    scanToolDirectory.mockImplementation(async (toolPath) => {
      if (toolPath === '/workspace/team/.claude/skills/') {
        return {
          success: true,
          skills: [{ name: 'team-skill', displayName: 'Team Skill', desc: 'from custom path' }],
          error: null,
        }
      }
      return { success: true, skills: [], error: null }
    })
    copySkill.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.importSkills([], ['custom-1'])

    expect(result.success).toBe(true)
    expect(result.copiedCount).toBe(1)
    expect(copySkill).toHaveBeenCalledWith(
      '/workspace/team/.claude/skills/team-skill',
      '~/Documents/SkillManager/team-skill',
      { force: true }
    )
  })

  it('UT-BE-15: importSkills 部分成功时 success 仍为 true 且包含错误明细', async () => {
    ensureDir.mockResolvedValue({ success: true, error: null })
    readConfig.mockResolvedValue({ success: true, data: makeConfig({ pushStatus: {} }) })
    writeConfig.mockResolvedValue({ success: true, error: null })
    scanToolDirectory.mockResolvedValue({
      success: true,
      skills: [{ name: 'ok-skill' }, { name: 'bad-skill' }],
      error: null,
    })
    copySkill.mockImplementation(async (sourcePath) => {
      if (sourcePath.includes('bad-skill')) {
        return { success: false, error: 'EACCES' }
      }
      return { success: true, error: null }
    })

    const result = await dataStore.importSkills(['claude-code'])

    expect(result.success).toBe(true)
    expect(result.copiedCount).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('bad-skill')
  })

  it('UT-BE-16: incrementalImport 对不存在的 customPathId 应记录错误', async () => {
    vi.spyOn(dataStore, 'getCentralSkills').mockResolvedValue([])
    ensureDir.mockResolvedValue({ success: true, error: null })
    readConfig.mockResolvedValue({ success: true, data: makeConfig({ customPaths: [] }) })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.incrementalImport(['missing-id'])

    expect(result.success).toBe(false)
    expect(result.added).toBe(0)
    expect(result.errors[0]).toContain('PATH_NOT_FOUND')
  })

  it('UT-BE-17: incrementalImport 在复制失败且无新增时返回失败', async () => {
    vi.spyOn(dataStore, 'getCentralSkills').mockResolvedValue([])
    ensureDir.mockResolvedValue({ success: true, error: null })
    readConfig.mockResolvedValue({
      success: true,
      data: makeConfig({
        customPaths: [{ id: 'cp-1', path: '/workspace/team', skills: {} }],
      }),
    })
    writeConfig.mockResolvedValue({ success: true, error: null })
    scanCustomPath.mockResolvedValue({
      success: true,
      skills: { codex: 1 },
      error: null,
    })
    scanToolDirectory.mockResolvedValue({
      success: true,
      skills: [{ name: 'broken-skill' }],
      error: null,
    })
    copySkill.mockResolvedValue({ success: false, error: 'DISK_FULL' })

    const result = await dataStore.incrementalImport(['cp-1'])

    expect(result.success).toBe(false)
    expect(result.added).toBe(0)
    expect(result.errors[0]).toContain('broken-skill')
  })

  it('UT-BE-18: getSkillsWithStatus 应返回技能的 pushed 状态', async () => {
    vi.spyOn(dataStore, 'getCentralSkills').mockResolvedValue([
      { id: 'alpha', name: 'alpha', displayName: 'Alpha', desc: 'desc-a' },
      { id: 'beta', name: 'beta', displayName: 'Beta', desc: 'desc-b' },
    ])
    vi.spyOn(dataStore, 'getToolStatus').mockResolvedValue({})
    vi.spyOn(dataStore, 'isPushed').mockImplementation(async (_toolId, skillName) => skillName === 'beta')

    const skills = await dataStore.getSkillsWithStatus('claude-code')

    expect(skills).toHaveLength(2)
    expect(skills.find((item) => item.name === 'alpha').pushed).toBe(false)
    expect(skills.find((item) => item.name === 'beta').pushed).toBe(true)
  })

  it('UT-BE-19: reimportSkills 应先清空中央仓库再执行导入', async () => {
    vi.spyOn(dataStore, 'getCentralSkills').mockResolvedValue([{ name: 'old-a' }, { name: 'old-b' }])
    vi.spyOn(dataStore, 'importSkills').mockResolvedValue({
      success: true,
      copiedCount: 2,
      errors: null,
    })
    readConfig.mockResolvedValue({ success: true, data: makeConfig() })
    writeConfig.mockResolvedValue({ success: true, error: null })
    deleteSkill.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.reimportSkills(['claude-code'], ['custom-1'])

    expect(result.success).toBe(true)
    expect(deleteSkill).toHaveBeenCalledTimes(2)
    expect(dataStore.importSkills).toHaveBeenCalledWith(['claude-code'], ['custom-1'])
  })

  it('UT-BE-20: getBatchPushStatus 应返回 skill-tool 二维状态映射', async () => {
    vi.spyOn(dataStore, 'isPushed').mockImplementation(async (toolId, skillName) => {
      return toolId === 'claude-code' && skillName === 'alpha'
    })

    const result = await dataStore.getBatchPushStatus(['claude-code', 'codex'], ['alpha', 'beta'])

    expect(result).toEqual({
      alpha: { 'claude-code': true, codex: false },
      beta: { 'claude-code': false, codex: false },
    })
  })

  it('UT-BE-21: selectAndAddCustomPath 在用户取消选择时返回 canceled=true', async () => {
    selectFolder.mockResolvedValue({
      success: false,
      canceled: true,
      path: null,
      error: null,
    })

    const result = await dataStore.selectAndAddCustomPath()

    expect(result.success).toBe(false)
    expect(result.canceled).toBe(true)
  })

  it('UT-BE-22: initPushTargetsAfterImport 在含预设工具时仅保留预设工具', async () => {
    readConfig.mockResolvedValue({ success: true, data: makeConfig() })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.initPushTargetsAfterImport(['custom-1', 'cursor', 'custom-2'])

    expect(result.success).toBe(true)
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.pushTargets).toEqual(['cursor'])
  })

  it('UT-BE-23: getPushTargets 在空配置时应回退全部预设工具', async () => {
    readConfig.mockResolvedValue({ success: true, data: makeConfig({ pushTargets: [] }) })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const targets = await dataStore.getPushTargets()

    expect(targets).toEqual(toolDefinitions.map((tool) => tool.id))
  })

  it('UT-BE-24: getConfig 应自动去重 customPaths 中的重复路径', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeConfig({
        customPaths: [
          { id: 'cp-1', path: '/workspace/team', skills: { codex: 2 } },
          { id: 'cp-2', path: '/workspace/team/', skills: { codex: 2 } },
        ],
      }),
    })

    const config = await dataStore.getConfig()

    expect(config.customPaths).toHaveLength(1)
    expect(config.customPaths[0].path).toBe('/workspace/team')
  })

  it('UT-BE-25: autoIncrementalRefresh 应扫描已配置来源并仅新增新 skill', async () => {
    vi.spyOn(dataStore, 'getCentralSkills').mockResolvedValue([{ name: 'existing-skill' }])
    readConfig.mockResolvedValue({
      success: true,
      data: makeConfig({
        importSources: ['claude-code', 'custom-1'],
        customPaths: [{ id: 'custom-1', path: '/workspace/team', skills: {} }],
        pushStatus: {},
      }),
    })
    ensureDir.mockResolvedValue({ success: true, error: null })
    scanCustomPath.mockResolvedValue({
      success: true,
      skills: { codex: 1 },
      error: null,
    })
    scanToolDirectory.mockImplementation(async (toolPath) => {
      if (toolPath === '~/.claude/skills/') {
        return {
          success: true,
          skills: [{ name: 'existing-skill' }, { name: 'preset-new' }],
          error: null,
        }
      }
      if (toolPath === '/workspace/team/.codex/skills/') {
        return {
          success: true,
          skills: [{ name: 'custom-new' }],
          error: null,
        }
      }
      return { success: true, skills: [], error: null }
    })
    copySkill.mockResolvedValue({ success: true, error: null })
    writeConfig.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.autoIncrementalRefresh()

    expect(result.success).toBe(true)
    expect(result.added).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.scannedSources).toBe(2)
    expect(copySkill).toHaveBeenCalledWith(
      '~/.claude/skills/preset-new',
      '~/Documents/SkillManager/preset-new',
      { force: false }
    )
    expect(copySkill).toHaveBeenCalledWith(
      '/workspace/team/.codex/skills/custom-new',
      '~/Documents/SkillManager/custom-new',
      { force: false }
    )

    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.pushStatus['claude-code']).toEqual(['preset-new'])
    expect(savedConfig.pushStatus['custom-custom-1-codex']).toEqual(['custom-new'])
  })

  it('UT-BE-26: autoIncrementalRefresh 在无可用来源时应直接返回且不写配置', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: makeConfig({ importSources: [], customPaths: [] }),
    })

    const result = await dataStore.autoIncrementalRefresh()

    expect(result).toEqual({
      success: true,
      added: 0,
      skipped: 0,
      scannedSources: 0,
      errors: null,
    })
    expect(writeConfig).toHaveBeenCalledTimes(0)
    expect(copySkill).toHaveBeenCalledTimes(0)
  })

  it('UT-BE-27: getConfig 默认读取应跟随 repoPath 读取真实仓库配置', async () => {
    readConfig.mockImplementation(async (configPath) => {
      if (configPath === '~/Documents/SkillManager/.config.json') {
        return {
          success: true,
          data: makeConfig({
            repoPath: '/Users/demo/new-repo/',
            importSources: [],
            customPaths: [],
          }),
        }
      }

      if (configPath === '/Users/demo/new-repo/.config.json') {
        return {
          success: true,
          data: makeConfig({
            repoPath: '/Users/demo/new-repo/',
            importSources: ['custom-1'],
            customPaths: [{ id: 'custom-1', path: '/workspace/team', skills: { codex: 2 } }],
          }),
        }
      }

      return { success: false, data: null }
    })

    const config = await dataStore.getConfig()

    expect(config.repoPath).toBe('/Users/demo/new-repo/')
    expect(config.importSources).toEqual(['custom-1'])
    expect(config.customPaths).toHaveLength(1)
    expect(readConfig).toHaveBeenCalledTimes(2)
    expect(readConfig).toHaveBeenNthCalledWith(1, '~/Documents/SkillManager/.config.json')
    expect(readConfig).toHaveBeenNthCalledWith(2, '/Users/demo/new-repo/.config.json')
  })

  it('UT-BE-28: saveConfig 在非默认仓库时应同步写回默认锚点文件', async () => {
    writeConfig.mockResolvedValue({ success: true, error: null })
    ensureDir.mockResolvedValue({ success: true, error: null })

    const result = await dataStore.saveConfig(
      makeConfig({
        repoPath: '/Users/demo/new-repo/',
        importSources: ['custom-1'],
      })
    )

    expect(result.success).toBe(true)
    expect(ensureDir).toHaveBeenCalledWith('~/Documents/SkillManager/')
    expect(writeConfig).toHaveBeenCalledTimes(2)
    expect(writeConfig).toHaveBeenNthCalledWith(
      1,
      '/Users/demo/new-repo/.config.json',
      expect.objectContaining({ repoPath: '/Users/demo/new-repo/', importSources: ['custom-1'] })
    )
    expect(writeConfig).toHaveBeenNthCalledWith(
      2,
      '~/Documents/SkillManager/.config.json',
      expect.objectContaining({ repoPath: '/Users/demo/new-repo/', importSources: ['custom-1'] })
    )
  })
})
