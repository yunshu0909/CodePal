/**
 * 模型注册表服务行为测试
 *
 * 负责：
 * - validateRegistry 的合法/非法路径
 * - 三层兜底优先级：cache > packaged > hardcoded
 * - 远程多源兜底：jsDelivr 失败时应切 GitHub Raw
 * - 非法远程数据不应被写入 cache
 *
 * @module 自动化测试/V0.16/tests/backend/modelRegistryService.behavior.test
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const require = createRequire(import.meta.url)

const modulePath = path.resolve(
  process.cwd(),
  'electron/services/modelRegistryService.js'
)

/**
 * 以干净状态重新加载 service（绕过模块内部状态缓存）
 * @returns {object}
 */
function loadFreshService() {
  delete require.cache[modulePath]
  return require(modulePath)
}

describe('modelRegistryService', () => {
  /** @type {string} */
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-registry-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    vi.restoreAllMocks()
  })

  describe('validateRegistry', () => {
    it('合法 registry 应通过校验', () => {
      const { validateRegistry } = loadFreshService()
      const result = validateRegistry({
        version: '2026-04-18',
        models: [{ id: 'opus', display: 'Opus', sublabel: '最强' }],
        effortLevels: [{ id: 'high', display: '高', desc: '深度思考' }],
      })
      expect(result.valid).toBe(true)
    })

    it('非对象应被拒绝', () => {
      const { validateRegistry } = loadFreshService()
      expect(validateRegistry(null).valid).toBe(false)
      expect(validateRegistry('not-object').valid).toBe(false)
    })

    it('缺 models 应被拒绝', () => {
      const { validateRegistry } = loadFreshService()
      const result = validateRegistry({ effortLevels: [{ id: 'low', display: '低', desc: '' }] })
      expect(result.valid).toBe(false)
    })

    it('effortLevel id 格式非法应被拒绝', () => {
      const { validateRegistry } = loadFreshService()
      const result = validateRegistry({
        models: [{ id: 'opus', sublabel: '' }],
        effortLevels: [{ id: 'HIGH!', display: '高', desc: '' }],
      })
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/HIGH!/)
    })

    it('model.display 非字符串应被拒绝（可选字段，但存在必须合法）', () => {
      const { validateRegistry } = loadFreshService()
      const result = validateRegistry({
        models: [{ id: 'opus', display: 123, sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      })
      expect(result.valid).toBe(false)
    })
  })

  describe('loadCachedRegistry', () => {
    it('cache 文件不存在时返回 null', async () => {
      const { loadCachedRegistry } = loadFreshService()
      const result = await loadCachedRegistry(path.join(tmpDir, 'not-exist.json'))
      expect(result).toBeNull()
    })

    it('cache 文件存在但内容非法时返回 null', async () => {
      const { loadCachedRegistry } = loadFreshService()
      const cacheFile = path.join(tmpDir, 'cache.json')
      await fs.writeFile(cacheFile, JSON.stringify({ models: [] }), 'utf-8')
      const result = await loadCachedRegistry(cacheFile)
      expect(result).toBeNull()
    })

    it('cache 合法时应返回解析结果', async () => {
      const { loadCachedRegistry } = loadFreshService()
      const valid = {
        models: [{ id: 'opus', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      const cacheFile = path.join(tmpDir, 'cache.json')
      await fs.writeFile(cacheFile, JSON.stringify(valid), 'utf-8')
      const result = await loadCachedRegistry(cacheFile)
      expect(result).toEqual(valid)
    })
  })

  describe('loadEffectiveRegistry', () => {
    it('cache 不存在时应回退到打包版', async () => {
      const { loadEffectiveRegistry } = loadFreshService()
      const result = await loadEffectiveRegistry(path.join(tmpDir, 'not-exist.json'))
      expect(result.source).toBe('packaged')
      expect(result.registry).toBeTruthy()
      // 打包版里至少应该有 xhigh（第一步就加进来了）
      expect(result.registry.effortLevels.some((l) => l.id === 'xhigh')).toBe(true)
    })

    it('cache 合法时优先使用 cache', async () => {
      const { loadEffectiveRegistry } = loadFreshService()
      const cacheFile = path.join(tmpDir, 'cache.json')
      const fromCache = {
        version: 'from-cache',
        models: [{ id: 'opus', display: 'Opus', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      await fs.writeFile(cacheFile, JSON.stringify(fromCache), 'utf-8')

      const result = await loadEffectiveRegistry(cacheFile)
      expect(result.source).toBe('cache')
      expect(result.registry.version).toBe('from-cache')
    })
  })

  describe('fetchRemoteRegistry', () => {
    it('第一个源失败时应尝试第二个源', async () => {
      const { fetchRemoteRegistry, REMOTE_SOURCES } = loadFreshService()
      expect(REMOTE_SOURCES.length).toBeGreaterThanOrEqual(2)

      const validRegistry = {
        models: [{ id: 'opus', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() => Promise.reject(new Error('jsDelivr down')))
        .mockImplementationOnce(() =>
          Promise.resolve({ ok: true, json: () => Promise.resolve(validRegistry) })
        )

      const result = await fetchRemoteRegistry()
      expect(result.success).toBe(true)
      expect(result.source).toBe(REMOTE_SOURCES[1])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('所有源都失败时返回 ALL_REMOTE_SOURCES_FAILED', async () => {
      const { fetchRemoteRegistry } = loadFreshService()
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.reject(new Error('network down'))
      )
      const result = await fetchRemoteRegistry()
      expect(result.success).toBe(false)
      expect(result.error).toBe('ALL_REMOTE_SOURCES_FAILED')
    })

    it('远程返回数据 schema 非法时应跳过并尝试下一源', async () => {
      const { fetchRemoteRegistry } = loadFreshService()
      vi.spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() =>
          Promise.resolve({ ok: true, json: () => Promise.resolve({ garbage: true }) })
        )
        .mockImplementationOnce(() =>
          Promise.reject(new Error('second source down'))
        )

      const result = await fetchRemoteRegistry()
      expect(result.success).toBe(false)
      expect(result.error).toBe('ALL_REMOTE_SOURCES_FAILED')
    })
  })

  describe('saveCachedRegistry', () => {
    it('应写入合法 JSON 到目标路径', async () => {
      const { saveCachedRegistry } = loadFreshService()
      const cacheFile = path.join(tmpDir, 'nested', 'cache.json')
      const registry = {
        models: [{ id: 'opus', sublabel: '' }],
        effortLevels: [{ id: 'high', display: '高', desc: '' }],
      }
      const ok = await saveCachedRegistry(cacheFile, registry)
      expect(ok).toBe(true)

      const written = JSON.parse(await fs.readFile(cacheFile, 'utf-8'))
      expect(written).toEqual(registry)
    })
  })

  describe('HARDCODED_FALLBACK_REGISTRY', () => {
    it('硬编码兜底本身应通过 schema 校验', () => {
      const { HARDCODED_FALLBACK_REGISTRY, validateRegistry } = loadFreshService()
      expect(validateRegistry(HARDCODED_FALLBACK_REGISTRY).valid).toBe(true)
    })

    it('硬编码兜底应至少包含 xhigh 推理档', () => {
      const { HARDCODED_FALLBACK_REGISTRY } = loadFreshService()
      expect(HARDCODED_FALLBACK_REGISTRY.effortLevels.some((l) => l.id === 'xhigh')).toBe(true)
    })
  })
})
