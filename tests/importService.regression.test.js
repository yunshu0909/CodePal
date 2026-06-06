/* @vitest-environment node */

/**
 * importService 回归单测（两个已修复 bug 的护栏）
 *
 * 负责：
 * - #1 reimportSkills 保留式重建：重建只重置 pushStatus / firstEntryAfterImport，
 *   不得顺手清掉 tags / skillTags 等其它用户配置
 * - #2 autoIncrementalRefresh 单向回拉：仅当来源比中央更新（sourceMtime > targetMtime）
 *   才覆盖中央，避免工具目录里的旧版本冲掉用户在中央侧的编辑
 *
 * @module tests/importService.regression.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createImportService } from '../src/store/services/importService.js'

// 一份带「额外用户配置」的基础 config，用来验证重建不丢字段
function makeConfig(overrides = {}) {
  return {
    version: '0.4',
    repoPath: '/repo',
    customPaths: [],
    pushStatus: { claude: ['old-skill'] },
    pushTargets: ['claude'],
    importSources: ['claude'],
    firstEntryAfterImport: true,
    tags: ['工作', '学习'],
    skillTags: { 'skill-a': ['工作'] },
    ...overrides,
  }
}

// 构造一套全可注入的假 deps；测试只覆写关心的项
function makeDeps(overrides = {}) {
  return {
    getRepoPath: vi.fn().mockResolvedValue('/repo'),
    getConfig: vi.fn().mockResolvedValue(makeConfig()),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    setFirstEntryAfterImport: vi.fn().mockResolvedValue(undefined),
    getCentralSkills: vi.fn().mockResolvedValue([]),
    getCentralSkillPath: vi.fn(async (name) => `/repo/${name}`),
    getToolSkillPath: vi.fn((toolPath, name) => `${toolPath}/${name}`),
    deleteSkill: vi.fn().mockResolvedValue({ success: true }),
    copySkill: vi.fn().mockResolvedValue({ success: true }),
    ensureDir: vi.fn().mockResolvedValue({ success: true }),
    scanToolDirectory: vi.fn().mockResolvedValue({ success: true, skills: [] }),
    scanCustomPath: vi.fn().mockResolvedValue({ success: true, skills: {} }),
    buildCustomToolPath: vi.fn((base, toolPath) => `${base}/${toolPath}`),
    compareSkillContent: vi.fn(),
    clearPushStatusCache: vi.fn(),
    toolDefinitions: [{ id: 'claude', name: 'Claude', path: '/tool/claude' }],
    DEFAULT_REPO_PATH: '/default-repo',
    ...overrides,
  }
}

describe('importService 回归', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // #1：重新导入时保留 tags / skillTags
  describe('#1 reimportSkills 保留式重建', () => {
    it('保留 tags / skillTags，并把 pushStatus 重置为空、触发 importSkills', async () => {
      const deps = makeDeps()
      const service = createImportService(deps)

      await service.reimportSkills(['claude'])

      // reimport 自身先写一次 newConfig，随后 importSkills 会再写一次最终 config；
      // 取第一次写入断言「重建后的配置」是否丢字段
      const rebuiltConfig = deps.saveConfig.mock.calls[0][0]

      // 核心护栏：其它用户配置必须原样保留
      expect(rebuiltConfig.tags).toEqual(['工作', '学习'])
      expect(rebuiltConfig.skillTags).toEqual({ 'skill-a': ['工作'] })

      // 重建该重置的两项
      expect(rebuiltConfig.pushStatus).toEqual({})
      expect(rebuiltConfig.firstEntryAfterImport).toBe(false)

      // 确认确实走到了 importSkills（它会再写一次 config + 落 firstEntryAfterImport 标记）
      expect(deps.setFirstEntryAfterImport).toHaveBeenCalledWith(true)
      expect(deps.saveConfig.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  // #2：自动增量刷新只在来源更新时回拉，不冲掉更新的中央版本
  describe('#2 autoIncrementalRefresh 单向回拉', () => {
    // 已存在于中央的同名技能，让比较逻辑进入「更新候选」分支
    const existingSkillsDeps = () => ({
      getCentralSkills: vi.fn().mockResolvedValue([{ name: 'skill-a' }]),
      scanToolDirectory: vi.fn().mockResolvedValue({
        success: true,
        skills: [{ name: 'skill-a' }],
      }),
    })

    it('中央比工具新时不回拉：不以该 skill 调 copySkill(force:true)，updated 不计', async () => {
      const deps = makeDeps({
        ...existingSkillsDeps(),
        // sourceMtime 小、targetMtime 大 => 中央更新，应跳过
        compareSkillContent: vi.fn().mockResolvedValue({
          success: true,
          isDifferent: true,
          sourceMtime: 100,
          targetMtime: 200,
        }),
      })
      const service = createImportService(deps)

      const result = await service.autoIncrementalRefresh()

      // 不应对该 skill 触发 force 覆盖（中央侧编辑被保护）
      const forcedCopies = deps.copySkill.mock.calls.filter(
        ([, , opts]) => opts && opts.force === true
      )
      expect(forcedCopies).toHaveLength(0)
      expect(result.updated).toBe(0)
      expect(result.skipped).toBe(1)
    })

    it('工具比中央新时回拉：以该 skill 调 copySkill(force:true)，updated 计入', async () => {
      const deps = makeDeps({
        ...existingSkillsDeps(),
        // sourceMtime 大、targetMtime 小 => 工具更新，应回拉覆盖
        compareSkillContent: vi.fn().mockResolvedValue({
          success: true,
          isDifferent: true,
          sourceMtime: 200,
          targetMtime: 100,
        }),
      })
      const service = createImportService(deps)

      const result = await service.autoIncrementalRefresh()

      expect(deps.copySkill).toHaveBeenCalledWith(
        '/tool/claude/skill-a',
        '/repo/skill-a',
        { force: true }
      )
      expect(result.updated).toBe(1)
      expect(result.skipped).toBe(0)
    })
  })
})
