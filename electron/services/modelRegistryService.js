/**
 * 模型配置注册表服务（主进程）
 *
 * 负责：
 * - 三层优先级加载：userData cache > 安装包打包版 > 硬编码兜底
 * - 后台从 jsDelivr / GitHub Raw 双源拉取最新注册表
 * - 拉取结果经 schema 校验后写入 userData cache，下次启动生效
 * - 让"Claude 升级新增模型/推理档位"无需发 CodePal 新版
 *
 * 设计要点：
 * - 远程刷新与本次启动的 UI 解耦（下次启动才生效）——避免 UI 中途跳变
 * - 远程失败静默回落，应用永远不会因拉取失败而损坏
 * - 双源 + 兜底的组合让国内无法稳定访问 GitHub 的用户也能用上本地打包版
 *
 * @module electron/services/modelRegistryService
 */

const fs = require('fs/promises')
const path = require('path')

// 仓库根在 skill-manager/ 目录，src/config/ 是相对仓库根
const REMOTE_SOURCES = [
  'https://cdn.jsdelivr.net/gh/yunshu0909/CodePal@master/src/config/model-registry.json',
  'https://raw.githubusercontent.com/yunshu0909/CodePal/master/src/config/model-registry.json',
]

const FETCH_TIMEOUT_MS = 5000
const CACHE_FILENAME = 'model-registry.cache.json'

// effortLevel id 格式校验与 modelConfigHandlers 保持一致，避免两处规则漂移
const EFFORT_ID_PATTERN = /^[a-z0-9_-]{1,32}$/

// 最终兜底（即使 json 文件被改坏或缺失，应用也能跑）
const HARDCODED_FALLBACK_REGISTRY = Object.freeze({
  version: 'hardcoded-fallback',
  updatedAt: null,
  models: [
    { id: 'opus[1m]', display: 'Opus (1M)', sublabel: '最强 · 1M' },
    { id: 'opus', display: 'Opus', sublabel: '最强 · 200K' },
    { id: 'sonnet', display: 'Sonnet', sublabel: '日常' },
    { id: 'sonnet[1m]', display: 'Sonnet (1M)', sublabel: '日常 · 1M' },
    { id: 'haiku', display: 'Haiku', sublabel: '快速' },
  ],
  effortLevels: [
    { id: 'low', display: '低', desc: '快速响应，适合简单问答' },
    { id: 'medium', display: '中', desc: '平衡速度与质量，Claude 默认值', isDefault: true },
    { id: 'high', display: '高', desc: '深度思考，适合复杂编码任务' },
    { id: 'xhigh', display: '超高', desc: 'Claude 4.7 新增，推理最充分，适合复杂架构与调试' },
  ],
})

let effectiveRegistryCache = null
let effectiveRegistrySource = null

/**
 * Schema 校验：确认拉回或读到的数据结构合法
 * @param {unknown} data - 待校验对象
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
function validateRegistry(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'registry 必须是对象' }
  }

  if (!Array.isArray(data.models) || data.models.length === 0) {
    return { valid: false, error: 'models 必须是非空数组' }
  }
  for (const model of data.models) {
    if (!model || typeof model.id !== 'string' || !model.id) {
      return { valid: false, error: 'model.id 必须是非空字符串' }
    }
    if (typeof model.sublabel !== 'string') {
      return { valid: false, error: `model[${model.id}].sublabel 必须是字符串` }
    }
    // display 可选；存在即必须是字符串
    if (model.display !== undefined && typeof model.display !== 'string') {
      return { valid: false, error: `model[${model.id}].display 必须是字符串` }
    }
  }

  if (!Array.isArray(data.effortLevels) || data.effortLevels.length === 0) {
    return { valid: false, error: 'effortLevels 必须是非空数组' }
  }
  for (const level of data.effortLevels) {
    if (!level || typeof level.id !== 'string') {
      return { valid: false, error: 'effortLevels[].id 必须是字符串' }
    }
    if (!EFFORT_ID_PATTERN.test(level.id)) {
      return { valid: false, error: `effortLevel.id 非法: ${level.id}` }
    }
    if (typeof level.display !== 'string' || !level.display) {
      return { valid: false, error: `effortLevel[${level.id}].display 必须是非空字符串` }
    }
    if (typeof level.desc !== 'string') {
      return { valid: false, error: `effortLevel[${level.id}].desc 必须是字符串` }
    }
  }

  return { valid: true }
}

/**
 * 读取安装包内打包的 registry json
 * @returns {Promise<object | null>}
 */
async function loadPackagedRegistry() {
  try {
    // eslint-disable-next-line global-require
    const packaged = require('../../src/config/model-registry.json')
    const validation = validateRegistry(packaged)
    if (!validation.valid) {
      console.warn('[model-registry] packaged registry invalid:', validation.error)
      return null
    }
    return packaged
  } catch (error) {
    console.warn('[model-registry] load packaged failed:', error?.message || error)
    return null
  }
}

/**
 * 读取 userData 目录下的远程缓存
 * @param {string} cacheFilePath - 缓存文件绝对路径
 * @returns {Promise<object | null>}
 */
async function loadCachedRegistry(cacheFilePath) {
  try {
    const content = await fs.readFile(cacheFilePath, 'utf-8')
    const parsed = JSON.parse(content)
    const validation = validateRegistry(parsed)
    if (!validation.valid) {
      console.warn('[model-registry] cached registry invalid:', validation.error)
      return null
    }
    return parsed
  } catch (error) {
    // cache 不存在是正常情况（首次启动 / 还没拉到过）
    if (error.code !== 'ENOENT') {
      console.warn('[model-registry] load cache failed:', error?.message || error)
    }
    return null
  }
}

/**
 * 把拉到的 registry 写入 userData cache
 * @param {string} cacheFilePath - 缓存文件绝对路径
 * @param {object} registry - 已校验的 registry 对象
 * @returns {Promise<boolean>}
 */
async function saveCachedRegistry(cacheFilePath, registry) {
  try {
    await fs.mkdir(path.dirname(cacheFilePath), { recursive: true })
    const content = `${JSON.stringify(registry, null, 2)}\n`
    await fs.writeFile(cacheFilePath, content, 'utf-8')
    return true
  } catch (error) {
    console.warn('[model-registry] save cache failed:', error?.message || error)
    return false
  }
}

/**
 * 单个 URL 的拉取封装（带超时）
 * @param {string} url - 拉取 URL
 * @returns {Promise<object>} 成功解析的 JSON 对象
 */
async function fetchRegistryFromUrl(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CodePal-Model-Registry-Fetch',
      },
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从远程多源拉取 registry，任意一个成功即返回
 * @returns {Promise<{ success: boolean, registry?: object, source?: string, error?: string }>}
 */
async function fetchRemoteRegistry() {
  for (const url of REMOTE_SOURCES) {
    try {
      const data = await fetchRegistryFromUrl(url)
      const validation = validateRegistry(data)
      if (!validation.valid) {
        console.warn(`[model-registry] remote invalid from ${url}:`, validation.error)
        continue
      }
      return { success: true, registry: data, source: url }
    } catch (error) {
      // 某一源挂了是常态（国内访问 GitHub Raw 经常失败），继续试下一个
      console.warn(`[model-registry] fetch failed from ${url}:`, error?.message || error)
    }
  }
  return { success: false, error: 'ALL_REMOTE_SOURCES_FAILED' }
}

/**
 * 三层优先级加载：cache > packaged > hardcoded
 * @param {string} cacheFilePath - 缓存文件绝对路径
 * @returns {Promise<{ registry: object, source: 'cache' | 'packaged' | 'hardcoded' }>}
 */
async function loadEffectiveRegistry(cacheFilePath) {
  const cached = await loadCachedRegistry(cacheFilePath)
  if (cached) return { registry: cached, source: 'cache' }

  const packaged = await loadPackagedRegistry()
  if (packaged) return { registry: packaged, source: 'packaged' }

  return { registry: { ...HARDCODED_FALLBACK_REGISTRY }, source: 'hardcoded' }
}

/**
 * 初始化：加载 registry 到内存（应用启动早期调用）
 * @param {object} deps - 依赖
 * @param {() => string} deps.getUserDataPath - 返回 userData 目录
 * @returns {Promise<{ source: string, version: string }>}
 */
async function initModelRegistry({ getUserDataPath }) {
  const cacheFilePath = path.join(getUserDataPath(), CACHE_FILENAME)
  const { registry, source } = await loadEffectiveRegistry(cacheFilePath)
  effectiveRegistryCache = registry
  effectiveRegistrySource = source
  return { source, version: registry?.version || 'unknown' }
}

/**
 * 获取当前生效的 registry 快照（同步，供 IPC handler 使用）
 * @returns {{ registry: object, source: string | null }}
 */
function getEffectiveRegistry() {
  if (!effectiveRegistryCache) {
    // 极端情况：init 尚未跑完就被请求了，直接返回硬编码兜底
    return { registry: { ...HARDCODED_FALLBACK_REGISTRY }, source: 'hardcoded' }
  }
  return { registry: effectiveRegistryCache, source: effectiveRegistrySource }
}

/**
 * 后台刷新远程 registry 并写入 cache（下次启动生效）
 * @param {object} deps - 依赖
 * @param {() => string} deps.getUserDataPath - 返回 userData 目录
 * @returns {Promise<{ success: boolean, source?: string, version?: string, error?: string }>}
 */
async function refreshRegistryInBackground({ getUserDataPath }) {
  const result = await fetchRemoteRegistry()
  if (!result.success) {
    return { success: false, error: result.error }
  }

  const cacheFilePath = path.join(getUserDataPath(), CACHE_FILENAME)
  const saved = await saveCachedRegistry(cacheFilePath, result.registry)
  if (!saved) {
    return { success: false, error: 'CACHE_WRITE_FAILED' }
  }

  return {
    success: true,
    source: result.source,
    version: result.registry?.version || 'unknown',
  }
}

module.exports = {
  initModelRegistry,
  getEffectiveRegistry,
  refreshRegistryInBackground,
  // 导出给测试用
  validateRegistry,
  loadPackagedRegistry,
  loadCachedRegistry,
  saveCachedRegistry,
  fetchRemoteRegistry,
  loadEffectiveRegistry,
  HARDCODED_FALLBACK_REGISTRY,
  REMOTE_SOURCES,
  CACHE_FILENAME,
}
