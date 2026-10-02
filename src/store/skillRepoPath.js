/**
 * Skills 页用的资产库路径
 *
 * 负责：
 * - 向主进程要资产库路径（`skill-control:get-repo-path`，解析规则在 electron/services/skillRepoPath.js）
 * - 记住本次运行里最近一次拿到的路径，供 Skills 页第一帧选缓存用
 *
 * @module store/skillRepoPath
 */

const DEFAULT_REPO_PATH = '~/Documents/SkillManager/'

let cachedRepoPath = null

export const skillRepoPath = {
  /**
   * 向主进程要当前资产库路径；接口不可用或失败时用默认位置
   * @returns {Promise<string>}
   */
  async getRepoPath() {
    try {
      const result = await window.electronAPI?.getSkillRepoPath?.()
      cachedRepoPath = result?.success && typeof result.data === 'string' && result.data ? result.data : DEFAULT_REPO_PATH
    } catch {
      cachedRepoPath = DEFAULT_REPO_PATH
    }
    return cachedRepoPath
  },

  /**
   * 本次运行里最近一次拿到的路径；还没拿过时为 null
   * @returns {string|null}
   */
  getCachedRepoPath() {
    return cachedRepoPath
  },
}
