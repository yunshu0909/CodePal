/**
 * Skill 资产库路径解析（主进程）
 *
 * 负责：
 * - 逐条照旧版渲染层 store（src/store/data.js getConfig，2026-10 已删）的规则解析资产库位置：
 *   旧版每读一处配置都先用默认配置打底（默认配置的 repoPath 就是默认位置），再叠上文件里读到的内容；
 *   先读锚点 ~/Documents/SkillManager/.config.json，得到 repoPath；它不是默认位置时再读那里的 .config.json，
 *   最终取那里写的 repoPath。所以任何一处文件不存在、读不出、不是合法 JSON、没写 repoPath，结果都落回默认位置
 * - 旧版改资产库位置时会在新位置和锚点各写一份带 repoPath 的配置，正常使用不会走到落回默认的分支
 * - 结果补末尾斜杠
 * - 只读，不创建目录也不写任何文件
 *
 * @module electron/services/skillRepoPath
 */

const fs = require('fs/promises')
const path = require('path')

const DEFAULT_REPO_PATH = '~/Documents/SkillManager/'
const CONFIG_FILE_NAME = '.config.json'

function normalizeRepoPath(value) {
  if (typeof value !== 'string' || value.length === 0) return DEFAULT_REPO_PATH
  return value.endsWith('/') ? value : `${value}/`
}

function expandHome(value, homeDir) {
  if (value === '~') return homeDir
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2))
  return value
}

/**
 * 读某个位置的配置
 * @returns {Promise<{state: 'missing'|'ok'|'failed', repoPath: string|null}>} 不存在 / 读到 / 读不出或坏了
 */
async function readConfigAt(repoPath, homeDir, deps) {
  let text
  try {
    text = await (deps.readFileFn || fs.readFile)(path.join(expandHome(repoPath, homeDir), CONFIG_FILE_NAME), 'utf8')
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'failed', repoPath: null }
  }
  try {
    const config = JSON.parse(text)
    const value = config && typeof config === 'object' && typeof config.repoPath === 'string' && config.repoPath ? config.repoPath : null
    return { state: 'ok', repoPath: value }
  } catch {
    return { state: 'failed', repoPath: null }
  }
}

/**
 * 解析当前资产库路径
 * @param {object} params
 * @param {string} params.homeDir - 家目录
 * @param {object} [deps] - readFileFn 可注入
 * @returns {Promise<string>} 资产库路径（可能以 ~/ 开头，末尾带斜杠），与旧版保存的写法一致
 */
async function resolveSkillRepoPath({ homeDir }, deps = {}) {
  const anchored = normalizeRepoPath((await readConfigAt(DEFAULT_REPO_PATH, homeDir, deps)).repoPath)
  if (anchored === DEFAULT_REPO_PATH) return DEFAULT_REPO_PATH
  return normalizeRepoPath((await readConfigAt(anchored, homeDir, deps)).repoPath)
}

module.exports = { DEFAULT_REPO_PATH, resolveSkillRepoPath }
