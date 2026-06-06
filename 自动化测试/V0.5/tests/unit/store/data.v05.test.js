import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dataStore } from '@/store/data.js'

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

import { ensureDir, readConfig, writeConfig } from '@/store/fs.js'

describe('dataStore V0.5 单元测试', () => {
  beforeEach(() => {
    dataStore.clearConfigCache()
    dataStore.clearPushStatusCache()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('UT-05: getConfig 能对旧配置自动补齐字段', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: {
        repoPath: '~/Documents/SkillManager',
      },
    })

    const config = await dataStore.getConfig()

    expect(config.version).toBe('0.4')
    expect(config.pushTargets).toEqual([])
    expect(config.importSources).toEqual([])
    expect(config.firstEntryAfterImport).toBe(false)
  })

  it('UT-06: initPushTargetsAfterImport 仅预设工具时按选中项保存', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: {
        repoPath: '~/Documents/SkillManager',
        customPaths: [],
        pushStatus: {},
        pushTargets: [],
      },
    })
    writeConfig.mockResolvedValue({ success: true })

    const result = await dataStore.initPushTargetsAfterImport(['claude-code', 'cursor'])

    expect(result.success).toBe(true)
    const savedConfig = writeConfig.mock.calls[0][1]
    expect(savedConfig.pushTargets).toEqual(['claude-code', 'cursor'])
  })

  it('UT-07: addCustomPath 能拒绝非法路径和重复路径', async () => {
    const invalid = await dataStore.addCustomPath('')
    expect(invalid.success).toBe(false)
    expect(invalid.error).toBe('INVALID_PATH')

    readConfig.mockResolvedValue({
      success: true,
      data: {
        repoPath: '~/Documents/SkillManager',
        customPaths: [{ id: 'cp-1', path: '/existing/path' }],
        pushStatus: {},
      },
    })

    const duplicated = await dataStore.addCustomPath('/existing/path')
    expect(duplicated.success).toBe(false)
    expect(duplicated.error).toBe('PATH_ALREADY_EXISTS')
  })

  it('UT-08: setRepoPath 规范化路径并在目录创建失败时返回错误', async () => {
    readConfig.mockResolvedValue({
      success: true,
      data: {
        repoPath: '~/Documents/SkillManager',
        customPaths: [],
        pushStatus: {},
      },
    })

    // setRepoPath 现在除目标路径外，还会在默认路径写一份锚点配置（多一轮 ensureDir + writeConfig），
    // 因此成功路径用默认 mock 覆盖全部调用，失败路径再用 mockResolvedValueOnce 优先命中。
    ensureDir.mockResolvedValue({ success: true })
    writeConfig.mockResolvedValue({ success: true })

    const ok = await dataStore.setRepoPath('/tmp/v05-repo')
    expect(ok.success).toBe(true)
    expect(ensureDir).toHaveBeenCalledWith('/tmp/v05-repo/')

    ensureDir.mockResolvedValueOnce({ success: false, error: 'PERMISSION_DENIED' })
    const fail = await dataStore.setRepoPath('/tmp/v05-repo-fail')
    expect(fail.success).toBe(false)
    expect(fail.error).toBe('PERMISSION_DENIED')
  })

})
