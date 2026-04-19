/**
 * 通用远程配置加载器行为测试
 *
 * 负责：
 * - 三层兜底优先级：cache > packaged > hardcoded
 * - 远程多源兜底：jsDelivr 失败应切 GitHub Raw
 * - schema 校验：非法数据不应污染 cache
 * - 写入：saveCached 的原子性与目录自动创建
 *
 * 测试策略：以 modelRegistry spec 作为 fixture 来验证通用 loader 行为
 *
 * @module 自动化测试/V0.16/tests/backend/remoteConfigLoader.behavior.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const require = createRequire(import.meta.url)

const loaderPath = path.resolve(process.cwd(), 'electron/services/remoteConfigLoader.js')
const modelRegistryPath = path.resolve(
  process.cwd(),
  'electron/services/registries/modelRegistry.js'
)

/**
 * 以干净状态重新加载模块（绕过模块内部状态缓存）
 * @returns {{ loader: object, modelRegistry: object }}
 */
function loadFresh() {
  delete require.cache[loaderPath]
  delete require.cache[modelRegistryPath]
  const loader = require(loaderPath)
  const modelRegistry = require(modelRegistryPath)
  return { loader, modelRegistry }
}

describe('remoteConfigLoader', () => {
  /** @type {string} */
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-config-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    vi.restoreAllMocks()
  })

  describe('loadCached', () => {
    it('cache 文件不存在时返回 null', async () => {
      const { loader, modelRegistry } = loadFresh()
      const result = await loader.loadCached(
        modelRegistry.modelRegistrySpec,
        path.join(tmpDir, 'not-exist.json')
      )
      expect(result).toBeNull()
    })

    it('cache 文件存在但内容非法时返回 null', async () => {
      const { loader, modelRegistry } = loadFresh()
      const cacheFile = path.join(tmpDir, 'cache.json')
      await fs.writeFile(cacheFile, JSON.stringify({ models: [] }), 'utf-8')
      const result = await loader.loadCached(modelRegistry.modelRegistrySpec, cacheFile)
      expect(result).toBeNull()
    })

    it('cache 合法时返回解析结果', async () => {
      const { loader, modelRegistry } = loadFresh()
      const valid = {
        models: [{ id: 'opus', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      const cacheFile = path.join(tmpDir, 'cache.json')
      await fs.writeFile(cacheFile, JSON.stringify(valid), 'utf-8')
      const result = await loader.loadCached(modelRegistry.modelRegistrySpec, cacheFile)
      expect(result).toEqual(valid)
    })
  })

  describe('loadEffective', () => {
    it('cache 不存在时应回退到打包版', async () => {
      const { loader, modelRegistry } = loadFresh()
      const result = await loader.loadEffective(
        modelRegistry.modelRegistrySpec,
        path.join(tmpDir, 'not-exist.json')
      )
      expect(result.source).toBe('packaged')
      expect(result.config).toBeTruthy()
      // 打包版 model-registry.json 里必须至少含 xhigh 推理档
      expect(result.config.effortLevels.some((l) => l.id === 'xhigh')).toBe(true)
    })

    it('cache 合法时优先使用 cache', async () => {
      const { loader, modelRegistry } = loadFresh()
      const cacheFile = path.join(tmpDir, 'cache.json')
      const fromCache = {
        version: 'from-cache',
        models: [{ id: 'opus', display: 'Opus', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      await fs.writeFile(cacheFile, JSON.stringify(fromCache), 'utf-8')

      const result = await loader.loadEffective(modelRegistry.modelRegistrySpec, cacheFile)
      expect(result.source).toBe('cache')
      expect(result.config.version).toBe('from-cache')
    })

    it('cache 非法、packaged 非法时应回落到 hardcoded', async () => {
      const { loader } = loadFresh()
      // 构造一个 packaged 就不合法的 spec（用一个故意不合法的对象）
      const badSpec = {
        name: 'test-bad',
        remotePath: 'nope',
        cacheFileName: 'nope.json',
        packaged: { models: [] }, // 非法：models 为空数组
        hardcoded: {
          version: 'hc',
          models: [{ id: 'x', sublabel: '' }],
          effortLevels: [{ id: 'low', display: '低', desc: '' }],
        },
        validate: (data) => {
          if (!data || !Array.isArray(data.models) || data.models.length === 0) {
            return { valid: false, error: 'models empty' }
          }
          return { valid: true }
        },
      }
      const result = await loader.loadEffective(badSpec, path.join(tmpDir, 'noexist.json'))
      expect(result.source).toBe('hardcoded')
      expect(result.config.version).toBe('hc')
    })
  })

  describe('fetchRemote', () => {
    it('第一个源失败时应尝试第二个源', async () => {
      const { loader, modelRegistry } = loadFresh()
      expect(loader.REMOTE_SOURCE_TEMPLATES.length).toBeGreaterThanOrEqual(2)

      const validConfig = {
        models: [{ id: 'opus', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() => Promise.reject(new Error('jsDelivr down')))
        .mockImplementationOnce(() =>
          Promise.resolve({ ok: true, json: () => Promise.resolve(validConfig) })
        )

      const result = await loader.fetchRemote(modelRegistry.modelRegistrySpec)
      expect(result.success).toBe(true)
      expect(result.source).toContain('raw.githubusercontent.com')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('所有源都失败时返回 ALL_REMOTE_SOURCES_FAILED', async () => {
      const { loader, modelRegistry } = loadFresh()
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.reject(new Error('network down'))
      )
      const result = await loader.fetchRemote(modelRegistry.modelRegistrySpec)
      expect(result.success).toBe(false)
      expect(result.error).toBe('ALL_REMOTE_SOURCES_FAILED')
    })

    it('远程数据 schema 非法时应跳过并尝试下一源', async () => {
      const { loader, modelRegistry } = loadFresh()
      vi.spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() =>
          Promise.resolve({ ok: true, json: () => Promise.resolve({ garbage: true }) })
        )
        .mockImplementationOnce(() => Promise.reject(new Error('second source down')))

      const result = await loader.fetchRemote(modelRegistry.modelRegistrySpec)
      expect(result.success).toBe(false)
      expect(result.error).toBe('ALL_REMOTE_SOURCES_FAILED')
    })
  })

  describe('saveCached', () => {
    it('应写入合法 JSON 到目标路径（目录自动创建）', async () => {
      const { loader, modelRegistry } = loadFresh()
      const cacheFile = path.join(tmpDir, 'nested', 'cache.json')
      const config = {
        models: [{ id: 'opus', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      const ok = await loader.saveCached(modelRegistry.modelRegistrySpec, cacheFile, config)
      expect(ok).toBe(true)

      const written = JSON.parse(await fs.readFile(cacheFile, 'utf-8'))
      expect(written).toEqual(config)
    })
  })

  describe('initRemoteConfig + getRemoteConfig', () => {
    it('init 后应能同步读取快照', async () => {
      const { loader, modelRegistry } = loadFresh()
      const result = await loader.initRemoteConfig(modelRegistry.modelRegistrySpec, {
        getUserDataPath: () => tmpDir,
      })
      expect(result.source).toBe('packaged')

      const snapshot = loader.getRemoteConfig('model-registry')
      expect(snapshot.source).toBe('packaged')
      expect(snapshot.config).toBeTruthy()
      expect(snapshot.config.effortLevels.some((l) => l.id === 'xhigh')).toBe(true)
    })

    it('未 init 的 name 应返回 null 配置（避免抛出）', () => {
      const { loader } = loadFresh()
      const snapshot = loader.getRemoteConfig('never-initialized')
      expect(snapshot.config).toBeNull()
      expect(snapshot.source).toBeNull()
    })
  })

  describe('refreshRemoteConfigInBackground', () => {
    it('远程拉取成功后应写入 cache', async () => {
      const { loader, modelRegistry } = loadFresh()
      // 注意：remote version 必须是合法日期格式且 >= 打包版，否则会被防退化拦截
      const validConfig = {
        version: '2099-12-31',
        models: [{ id: 'opus', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(validConfig) })
      )

      const result = await loader.refreshRemoteConfigInBackground(modelRegistry.modelRegistrySpec, {
        getUserDataPath: () => tmpDir,
      })
      expect(result.success).toBe(true)
      expect(result.version).toBe('2099-12-31')

      // cache 文件应存在且内容正确
      const cacheFile = path.join(tmpDir, 'model-registry.cache.json')
      const written = JSON.parse(await fs.readFile(cacheFile, 'utf-8'))
      expect(written.version).toBe('2099-12-31')
    })

    it('拉取失败时不应写 cache', async () => {
      const { loader, modelRegistry } = loadFresh()
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.reject(new Error('all sources down'))
      )

      const result = await loader.refreshRemoteConfigInBackground(modelRegistry.modelRegistrySpec, {
        getUserDataPath: () => tmpDir,
      })
      expect(result.success).toBe(false)
      expect(result.error).toBe('ALL_REMOTE_SOURCES_FAILED')

      const cacheFile = path.join(tmpDir, 'model-registry.cache.json')
      await expect(fs.access(cacheFile)).rejects.toThrow()
    })
  })

  describe('isRemoteVersionStale（防退化保护）', () => {
    it('远程比打包新 → 不退化', () => {
      const { loader } = loadFresh()
      expect(loader.isRemoteVersionStale('2026-04-20', '2026-04-18')).toBe(false)
    })

    it('远程和打包同版 → 不退化', () => {
      const { loader } = loadFresh()
      expect(loader.isRemoteVersionStale('2026-04-18', '2026-04-18')).toBe(false)
    })

    it('远程比打包老 → 退化', () => {
      const { loader } = loadFresh()
      expect(loader.isRemoteVersionStale('2026-03-01', '2026-04-18')).toBe(true)
    })

    it('远程无 version、打包有 version → 视为退化（典型 CDN 污染场景）', () => {
      const { loader } = loadFresh()
      expect(loader.isRemoteVersionStale(undefined, '2026-04-18')).toBe(true)
      expect(loader.isRemoteVersionStale(null, '2026-04-18')).toBe(true)
    })

    it('远程非法格式、打包有合法 version → 视为退化', () => {
      const { loader } = loadFresh()
      expect(loader.isRemoteVersionStale('garbage', '2026-04-18')).toBe(true)
      expect(loader.isRemoteVersionStale('v2.0', '2026-04-18')).toBe(true)
    })

    it('打包无 version → 不做防护（无法比较，信任远程）', () => {
      const { loader } = loadFresh()
      expect(loader.isRemoteVersionStale('whatever', undefined)).toBe(false)
      expect(loader.isRemoteVersionStale(undefined, undefined)).toBe(false)
    })

    it('同日修订号比较：.1 比无后缀新', () => {
      const { loader } = loadFresh()
      expect(loader.isRemoteVersionStale('2026-04-18', '2026-04-18.1')).toBe(true)
      expect(loader.isRemoteVersionStale('2026-04-18.1', '2026-04-18')).toBe(false)
      expect(loader.isRemoteVersionStale('2026-04-18.2', '2026-04-18.1')).toBe(false)
    })
  })

  describe('refreshRemoteConfigInBackground：防退化集成', () => {
    it('远程返老版本时不应写 cache（模拟 CDN 缓存污染）', async () => {
      const { loader } = loadFresh()

      // 构造一个 packaged version 明确较新的 spec
      const spec = {
        name: 'test-stale',
        remotePath: 'x',
        cacheFileName: 'test-stale.cache.json',
        packaged: {
          version: '2026-04-18',
          models: [{ id: 'new', sublabel: '' }],
          effortLevels: [{ id: 'high', display: '高', desc: '' }],
        },
        hardcoded: {
          models: [{ id: 'hc', sublabel: '' }],
          effortLevels: [{ id: 'high', display: '高', desc: '' }],
        },
        validate: (data) => {
          if (!data || !Array.isArray(data.models)) return { valid: false, error: '...' }
          return { valid: true }
        },
      }

      // 模拟远程返回老 version
      const staleRemote = {
        version: '2026-03-01',
        models: [{ id: 'old', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(staleRemote) })
      )

      const result = await loader.refreshRemoteConfigInBackground(spec, {
        getUserDataPath: () => tmpDir,
      })
      expect(result.success).toBe(false)
      expect(result.error).toBe('REMOTE_VERSION_STALE')

      // cache 不应被写入
      const cacheFile = path.join(tmpDir, 'test-stale.cache.json')
      await expect(fs.access(cacheFile)).rejects.toThrow()
    })

    it('远程缺 version 且打包有 version → 拒绝写 cache', async () => {
      const { loader } = loadFresh()
      const spec = {
        name: 'test-missing-version',
        remotePath: 'x',
        cacheFileName: 'test-mv.cache.json',
        packaged: {
          version: '2026-04-18',
          models: [{ id: 'a', sublabel: '' }],
          effortLevels: [{ id: 'high', display: '高', desc: '' }],
        },
        hardcoded: {
          models: [{ id: 'hc', sublabel: '' }],
          effortLevels: [{ id: 'high', display: '高', desc: '' }],
        },
        validate: (data) => {
          if (!data || !Array.isArray(data.models)) return { valid: false, error: '...' }
          return { valid: true }
        },
      }

      const remoteWithoutVersion = {
        // 故意不写 version，模拟 CDN 缓存的老版本
        models: [{ id: 'old', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(remoteWithoutVersion) })
      )

      const result = await loader.refreshRemoteConfigInBackground(spec, {
        getUserDataPath: () => tmpDir,
      })
      expect(result.success).toBe(false)
      expect(result.error).toBe('REMOTE_VERSION_STALE')
    })
  })
})

describe('modelRegistry spec', () => {
  it('HARDCODED_MODEL_FALLBACK 应通过自己的 schema 校验', () => {
    const { modelRegistry } = loadFresh()
    const result = modelRegistry.validateModelRegistry(modelRegistry.HARDCODED_MODEL_FALLBACK)
    expect(result.valid).toBe(true)
  })

  it('HARDCODED_MODEL_FALLBACK 应包含 xhigh 推理档', () => {
    const { modelRegistry } = loadFresh()
    expect(
      modelRegistry.HARDCODED_MODEL_FALLBACK.effortLevels.some((l) => l.id === 'xhigh')
    ).toBe(true)
  })

  it('effortLevel id 非法格式应被拒绝', () => {
    const { modelRegistry } = loadFresh()
    const result = modelRegistry.validateModelRegistry({
      models: [{ id: 'opus', sublabel: '' }],
      effortLevels: [{ id: 'HIGH!', display: '高', desc: '' }],
    })
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/HIGH!/)
  })
})
