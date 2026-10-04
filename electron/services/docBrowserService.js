/**
 * 文档查阅服务
 *
 * 负责：
 * - 管理用户添加的文件夹列表（持久化到 electron-store）
 * - 递归扫描文件夹下的 .md 文件
 * - 读取 .md 文件内容
 * - 启动时校验路径有效性
 *
 * @module electron/services/docBrowserService
 */

const fs = require('fs/promises')
const path = require('path')

const STORE_KEY = 'docBrowser.folders'
const MAX_SCAN_FILES = 5000
const MAX_SCAN_DEPTH = 15
const INDEX_TTL_MS = 30_000
let indexes = new Map()
let folderGenerations = new Map()
let storeGeneration = 0

/** @type {import('electron-store').default | null} */
let store = null

/**
 * 注入 electron-store 实例
 * @param {import('electron-store').default} storeInstance
 */
function initDocBrowserStore(storeInstance) {
  store = storeInstance
  storeGeneration += 1
  indexes = new Map()
  folderGenerations = new Map()
}

/**
 * 递归扫描目录下的所有 .md 文件
 * @param {string} baseDir - 根目录
 * @param {string} [relativeTo=''] - 相对路径前缀（递归用）
 * @param {number} [depth=0] - 当前递归深度
 * @param {{complete: boolean}} [scan] - 累计扫描失败，避免缓存不完整结果
 * @returns {Promise<Array<{name: string, relativePath: string, dir: string, fullPath: string, size: number}>>}
 */
async function scanMdFiles(baseDir, relativeTo = '', depth = 0, scan = { complete: true }) {
  const results = []

  // 超过深度限制，停止递归
  if (depth > MAX_SCAN_DEPTH) return results

  let entries
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true })
  } catch {
    scan.complete = false
    return results
  }

  for (const entry of entries) {
    // 达到文件数量上限，停止扫描
    if (results.length >= MAX_SCAN_FILES) break

    const fullPath = path.join(baseDir, entry.name)
    const relPath = relativeTo ? path.join(relativeTo, entry.name) : entry.name

    // 跳过符号链接，防止越界到系统目录或循环链接
    if (entry.isSymbolicLink()) continue

    if (entry.isDirectory()) {
      // 跳过隐藏目录和 node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const subFiles = await scanMdFiles(fullPath, relPath, depth + 1, scan)
      results.push(...subFiles)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const stat = await fs.stat(fullPath)
        results.push({
          name: entry.name,
          relativePath: relPath,
          dir: relativeTo || '',
          fullPath,
          size: stat.size,
        })
      } catch {
        scan.complete = false
        // 文件 stat 失败，跳过
      }
    }
  }

  return results
}

/**
 * Reuse directory metadata for a fixed 30 seconds; validate root identity/access every time.
 * @param {string} folderPath Registered root or a root being validated before registration.
 * @returns {Promise<Array<object>>} Cloned file descriptors, never document contents.
 * @throws {Error} Root access or identity lookup failed.
 */
async function indexedFiles(folderPath) {
  const owner = storeGeneration
  const generation = folderGenerations.get(folderPath) || 0
  let identity
  try {
    await fs.access(folderPath)
    const realRoot = await fs.realpath(folderPath)
    const stat = await fs.stat(realRoot)
    identity = JSON.stringify([realRoot, stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs])
  } catch (error) {
    indexes.delete(folderPath)
    throw error
  }
  if (owner !== storeGeneration || generation !== (folderGenerations.get(folderPath) || 0)) {
    return scanMdFiles(folderPath)
  }
  const prior = indexes.get(folderPath)
  if (prior?.identity === identity && (prior.pending || Date.now() < prior.expires)) {
    return structuredClone(await (prior.pending || prior.files))
  }
  const entry = { identity, expires: 0, files: null, pending: null }
  indexes.set(folderPath, entry)
  // This also bounds scans requested outside the registered-folder list.
  while (indexes.size > 100) indexes.delete(indexes.keys().next().value)
  const scan = { complete: true }
  entry.pending = scanMdFiles(folderPath, '', 0, scan).then(files => {
    if (indexes.get(folderPath) === entry) {
      if (scan.complete) {
        entry.files = files
        entry.expires = Date.now() + INDEX_TTL_MS
      } else indexes.delete(folderPath)
    }
    return files
  }).finally(() => { entry.pending = null })
  return structuredClone(await entry.pending)
}

/**
 * 获取已保存的文件夹列表 + 校验路径有效性
 * @returns {Promise<Array<{name: string, path: string, fileCount: number, valid: boolean}>>}
 */
async function listFolders() {
  const folders = [...store.get(STORE_KEY, [])]
  const owner = storeGeneration
  const result = new Array(folders.length)
  let cursor = 0
  async function worker() {
    while (cursor < folders.length) {
      const index = cursor++
      const folderPath = folders[index]
      let valid = false
      let fileCount = 0
      try {
        const files = await indexedFiles(folderPath)
        valid = true
        fileCount = files.length
      } catch { /* Retain the existing invalid-folder result. */ }
      result[index] = { name: path.basename(folderPath), path: folderPath, fileCount, valid }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, folders.length) }, worker))
  if (owner !== storeGeneration) return []
  const current = store.get(STORE_KEY, [])
  return result.filter(folder => current.includes(folder.path))
}

/**
 * 添加文件夹
 * @param {string} folderPath - 文件夹绝对路径
 * @returns {Promise<{success: boolean, data?: object, error?: string, errorCode?: string}>}
 */
async function addFolder(folderPath) {
  const folders = store.get(STORE_KEY, [])
  const owner = storeGeneration
  const generation = folderGenerations.get(folderPath) || 0

  // 检查重复
  if (folders.includes(folderPath)) {
    return { success: false, error: '该文件夹已在列表中', errorCode: 'DUPLICATE' }
  }

  // 检查路径可访问
  try {
    await fs.access(folderPath)
  } catch {
    return { success: false, error: '无法访问该文件夹，请检查路径和权限', errorCode: 'ACCESS_DENIED' }
  }

  // 扫描 .md 文件
  const files = await indexedFiles(folderPath)

  // A removal or store switch while scanning must not resurrect a registration.
  if (owner !== storeGeneration || generation !== (folderGenerations.get(folderPath) || 0)) {
    return { success: false, error: '无法访问该文件夹，请检查路径和权限', errorCode: 'ACCESS_DENIED' }
  }
  const latest = store.get(STORE_KEY, [])
  if (latest.includes(folderPath)) return { success: false, error: '该文件夹已在列表中', errorCode: 'DUPLICATE' }
  store.set(STORE_KEY, [...latest, folderPath])

  return {
    success: true,
    data: {
      name: path.basename(folderPath),
      path: folderPath,
      fileCount: files.length,
      files,
    },
  }
}

/**
 * 移除文件夹
 * @param {string} folderPath - 文件夹路径
 * @returns {{success: boolean}}
 */
function removeFolder(folderPath) {
  folderGenerations.set(folderPath, (folderGenerations.get(folderPath) || 0) + 1)
  indexes.delete(folderPath)
  const folders = store.get(STORE_KEY, [])
  const updated = folders.filter(f => f !== folderPath)
  store.set(STORE_KEY, updated)
  return { success: true, data: null, error: null }
}

/**
 * 列出指定文件夹下的所有 .md 文件
 * @param {string} folderPath - 文件夹路径
 * @returns {Promise<Array<{name: string, relativePath: string, dir: string, fullPath: string, size: number}>>}
 */
async function listFiles(folderPath) {
  try {
    return await indexedFiles(folderPath)
  } catch {
    return []
  }
}

/**
 * 读取 .md 文件内容
 * 安全校验：文件必须在已注册文件夹内，且为 .md 后缀
 * @param {string} filePath - 文件绝对路径
 * @returns {Promise<{content: string, size: number}>}
 */
async function readFile(filePath) {
  // 路径安全校验：必须在已注册的文件夹内
  const folders = store.get(STORE_KEY, [])
  const realPath = await fs.realpath(filePath)
  let isAllowed = false
  for (const folderPath of folders) {
    try {
      const realFolder = await fs.realpath(folderPath)
      if (realPath.startsWith(realFolder + path.sep)) {
        isAllowed = true
        break
      }
    } catch {
      // 文件夹路径不可访问，跳过
    }
  }
  if (!isAllowed) {
    throw new Error('文件不在已注册的文件夹内')
  }
  // 仅允许读取 .md 文件
  if (!realPath.endsWith('.md')) {
    throw new Error('仅支持读取 .md 文件')
  }

  const content = await fs.readFile(realPath, 'utf-8')
  const stat = await fs.stat(realPath)
  return { content, size: stat.size }
}

module.exports = { initDocBrowserStore, listFolders, addFolder, removeFolder, listFiles, readFile }
