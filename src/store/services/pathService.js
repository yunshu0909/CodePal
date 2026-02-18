/**
 * 路径服务模块
 *
 * 负责：
 * - 规范化路径并用于去重比较
 * - 生成工具技能目录与自定义工具目录路径
 * - 提供路径列表去重能力
 *
 * @module store/services/pathService
 */

/**
 * 规范化路径用于比较（去除末尾斜杠）
 * @param {string} pathValue - 原始路径
 * @returns {string}
 */
export function normalizePathForCompare(pathValue) {
  if (typeof pathValue !== 'string') return ''
  return pathValue.replace(/\/+$/, '')
}

/**
 * 自定义路径去重（按规范化路径）
 * @param {Array} customPaths - 自定义路径列表
 * @returns {Array}
 */
export function dedupeCustomPaths(customPaths) {
  if (!Array.isArray(customPaths)) return []

  const seen = new Set()
  const deduped = []

  for (const customPath of customPaths) {
    if (!customPath || typeof customPath.path !== 'string') continue
    const normalizedPath = normalizePathForCompare(customPath.path)
    if (!normalizedPath || seen.has(normalizedPath)) continue

    seen.add(normalizedPath)
    deduped.push({
      ...customPath,
      path: normalizedPath,
    })
  }

  return deduped
}

/**
 * 获取工具目录中技能的路径
 * @param {string} toolPath - 工具目录路径
 * @param {string} skillName - 技能名称
 * @returns {string} 技能路径
 */
export function getToolSkillPath(toolPath, skillName) {
  const normalizedPath = toolPath.endsWith('/') ? toolPath : `${toolPath}/`
  return `${normalizedPath}${skillName}`
}

/**
 * 构造自定义路径下某工具的技能目录
 * @param {string} customPath - 自定义根路径
 * @param {string} toolPath - 工具默认路径（以 `~/` 开头）
 * @returns {string}
 */
export function buildCustomToolPath(customPath, toolPath) {
  return `${customPath.replace(/\/$/, '')}/${toolPath.replace(/^~\//, '')}`
}
