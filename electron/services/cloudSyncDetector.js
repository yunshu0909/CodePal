/**
 * 云盘同步路径检测
 *
 * 负责：
 * - 识别 ~/.codex-switcher/ 是否位于 iCloud / Dropbox / OneDrive 等云盘同步目录下
 * - 命中后由调用方决定是否警告用户 + 禁用主动 sweep
 *
 * 依据：
 * - 设计稿 §9.2：云盘检测规则
 * - 前置技术调研 V1.7-前置技术调研报告.md §4
 *
 * 检测规则：
 * - macOS:  `~/Library/CloudStorage/<vendor>...`（含 Dropbox/GoogleDrive/Box 等 File Provider 注册）
 *           `~/Library/Mobile Documents/com~apple~CloudDocs/...`（iCloud Drive）
 *           `~/Dropbox/...`（旧 Dropbox 客户端）
 * - Windows: `%OneDrive%`, `%OneDriveConsumer%`, `%OneDriveCommercial%` 任一非空且为前缀
 *
 * @module electron/services/cloudSyncDetector
 */

const path = require('node:path')
const os = require('node:os')

/**
 * @param {string} absolutePath - 待检测路径（绝对路径）
 * @param {{ platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv }} [opts] - 测试注入
 * @returns {{ sync: boolean, vendor?: string }}
 */
function detectCloudSync(absolutePath, opts = {}) {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) return { sync: false }

  const platform = opts.platform ?? process.platform
  const home = opts.home ?? os.homedir()
  const env = opts.env ?? process.env

  if (platform === 'darwin') {
    return detectDarwin(absolutePath, home)
  }
  if (platform === 'win32') {
    return detectWin32(absolutePath, env)
  }
  return { sync: false }
}

function detectDarwin(absolutePath, home) {
  // iCloud Drive
  const iCloudPrefix = path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs')
  if (startsWithDir(absolutePath, iCloudPrefix)) return { sync: true, vendor: 'iCloud' }

  // CloudStorage 注册的 File Provider（vendor 从子目录名抽出）
  const cloudStoragePrefix = path.join(home, 'Library/CloudStorage')
  if (startsWithDir(absolutePath, cloudStoragePrefix)) {
    const rel = path.relative(cloudStoragePrefix, absolutePath)
    const first = rel.split(path.sep)[0] ?? ''
    // first 形如 "Dropbox-Personal" / "GoogleDrive-foo" / "OneDrive-bar" / "Box-baz"
    const vendor = first.split('-')[0] || 'Cloud'
    return { sync: true, vendor }
  }

  // 旧 Dropbox 客户端
  const legacyDropbox = path.join(home, 'Dropbox')
  if (startsWithDir(absolutePath, legacyDropbox)) return { sync: true, vendor: 'Dropbox' }

  return { sync: false }
}

function detectWin32(absolutePath, env) {
  const candidates = [
    { key: 'OneDriveConsumer', vendor: 'OneDrive' },
    { key: 'OneDriveCommercial', vendor: 'OneDrive' },
    { key: 'OneDrive', vendor: 'OneDrive' },
  ]
  const lower = absolutePath.toLowerCase()
  for (const c of candidates) {
    const v = env[c.key]
    if (typeof v === 'string' && v.length > 0 && lower.startsWith(v.toLowerCase())) {
      return { sync: true, vendor: c.vendor }
    }
  }
  return { sync: false }
}

/**
 * 严格按"目录边界"判前缀，避免 /Users/test/Library/Foo 误命中 /Users/test/Library
 */
function startsWithDir(target, prefix) {
  if (typeof target !== 'string' || typeof prefix !== 'string') return false
  const t = path.normalize(target)
  const p = path.normalize(prefix)
  if (t === p) return true
  const withSep = p.endsWith(path.sep) ? p : p + path.sep
  return t.startsWith(withSep)
}

module.exports = {
  detectCloudSync,
}
