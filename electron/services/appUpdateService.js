/**
 * 应用更新检查服务
 *
 * 负责：
 * - 从 GitHub Releases 拉取 CodePal 最新版本信息
 * - 比较当前版本与远端最新版本
 * - 在主进程内维护统一的更新状态快照
 *
 * @module electron/services/appUpdateService
 */

const GITHUB_OWNER = 'yunshu0909'
const GITHUB_REPO = 'CodePal'
const DEFAULT_RELEASE_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

const DEFAULT_APP_UPDATE_STATE = Object.freeze({
  checked: false,
  checking: false,
  hasUpdate: false,
  currentVersion: '',
  latestVersion: '',
  releaseUrl: DEFAULT_RELEASE_PAGE_URL,
  // GitHub 发布说明原文（Markdown），应用内「新版本」对话框展示用；过长截断
  releaseNotes: '',
  error: null,
  checkedAt: null,
})

// 发布说明最多带回的字数，够对话框显示前几条
const RELEASE_NOTES_LIMIT = 4000

let appUpdateState = { ...DEFAULT_APP_UPDATE_STATE }
const stateSubscribers = new Set()

/**
 * 规范化版本号，兼容 v1.2.7 这类 tag
 * @param {string} version - 原始版本号或 tag
 * @returns {string}
 */
function normalizeVersion(version) {
  if (typeof version !== 'string') return ''
  return version.trim().replace(/^v/i, '')
}

/**
 * 将版本号拆成纯数字数组，便于逐段比较
 * @param {string} version - 版本号
 * @returns {number[]}
 */
function parseVersionSegments(version) {
  const normalizedVersion = normalizeVersion(version)
  const matches = normalizedVersion.match(/\d+/g)
  return matches ? matches.map(Number) : []
}

/**
 * 比较两个版本号大小
 * @param {string} nextVersion - 新版本
 * @param {string} currentVersion - 当前版本
 * @returns {number} 1=next 更大，0=相等，-1=current 更大
 */
function compareVersions(nextVersion, currentVersion) {
  const nextSegments = parseVersionSegments(nextVersion)
  const currentSegments = parseVersionSegments(currentVersion)
  const maxLength = Math.max(nextSegments.length, currentSegments.length)

  for (let index = 0; index < maxLength; index += 1) {
    const nextSegment = nextSegments[index] || 0
    const currentSegment = currentSegments[index] || 0

    if (nextSegment > currentSegment) return 1
    if (nextSegment < currentSegment) return -1
  }

  return 0
}

/**
 * 获取当前更新状态快照
 * @returns {typeof DEFAULT_APP_UPDATE_STATE}
 */
function getAppUpdateState() {
  return { ...appUpdateState }
}

/**
 * 广播更新状态变更
 */
function notifyStateSubscribers() {
  const nextState = getAppUpdateState()
  stateSubscribers.forEach((subscriber) => {
    try {
      subscriber(nextState)
    } catch (error) {
      console.warn('[app-update] state subscriber failed:', error?.message || error)
    }
  })
}

/**
 * 合并并更新当前更新状态
 * @param {Partial<typeof DEFAULT_APP_UPDATE_STATE>} partialState - 需要覆盖的字段
 * @returns {typeof DEFAULT_APP_UPDATE_STATE}
 */
function setAppUpdateState(partialState) {
  appUpdateState = {
    ...appUpdateState,
    ...partialState,
  }
  notifyStateSubscribers()
  return getAppUpdateState()
}

/**
 * 订阅更新状态变化
 * @param {(state: typeof DEFAULT_APP_UPDATE_STATE) => void} subscriber - 状态变更回调
 * @returns {() => void}
 */
function subscribeAppUpdateState(subscriber) {
  stateSubscribers.add(subscriber)
  return () => stateSubscribers.delete(subscriber)
}

/**
 * 检查 GitHub Releases 上是否存在更高版本
 * @param {string} currentVersion - 当前应用版本
 * @returns {Promise<typeof DEFAULT_APP_UPDATE_STATE>}
 */
async function checkForAppUpdate(currentVersion) {
  const normalizedCurrentVersion = normalizeVersion(currentVersion)

  setAppUpdateState({
    checking: true,
    currentVersion: normalizedCurrentVersion || currentVersion || '',
    error: null,
  })

  try {
    const response = await fetch(LATEST_RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'CodePal-App-Update-Check',
      },
    })

    if (!response.ok) {
      throw new Error(`UPDATE_CHECK_FAILED_${response.status}`)
    }

    const release = await response.json()
    const latestVersion = normalizeVersion(release?.tag_name || release?.name || '')

    if (!latestVersion) {
      throw new Error('LATEST_VERSION_NOT_FOUND')
    }

    return setAppUpdateState({
      checked: true,
      checking: false,
      hasUpdate: compareVersions(latestVersion, normalizedCurrentVersion) > 0,
      currentVersion: normalizedCurrentVersion,
      latestVersion,
      releaseUrl: release?.html_url || DEFAULT_RELEASE_PAGE_URL,
      releaseNotes: typeof release?.body === 'string' ? release.body.slice(0, RELEASE_NOTES_LIMIT) : '',
      checkedAt: new Date().toISOString(),
      error: null,
    })
  } catch (error) {
    return setAppUpdateState({
      checked: true,
      checking: false,
      hasUpdate: false,
      currentVersion: normalizedCurrentVersion,
      latestVersion: '',
      releaseUrl: DEFAULT_RELEASE_PAGE_URL,
      releaseNotes: '',
      checkedAt: new Date().toISOString(),
      error: error?.message || 'UPDATE_CHECK_FAILED',
    })
  }
}

module.exports = {
  DEFAULT_RELEASE_PAGE_URL,
  checkForAppUpdate,
  getAppUpdateState,
  subscribeAppUpdateState,
}
