/**
 * Skill 控制中心纯业务规则
 *
 * 负责：
 * - 分工具精简候选判定
 * - 问题状态判定
 * - 视图/标签/搜索过滤与排序
 * - 摘要统计
 *
 * @module pages/skillControlUtils
 */

export const TOOL_META = Object.freeze({
  'claude-code': { label: 'Claude', fullName: 'Claude Code', usageKey: 'claude', brand: 'claude', mark: 'CC' },
  codex: { label: 'Codex', fullName: 'Codex', usageKey: 'codex', brand: 'codex', mark: 'CX' },
})

const ORIGIN_LABELS = Object.freeze({
  user: '个人目录',
  legacy: '兼容目录',
  project: '项目 Skill',
  plugin: 'Plugin Skill',
  system: '系统 Skill',
  bundled: '系统 Skill',
  synced: '同步来源',
  command: '旧 Command',
})

/**
 * 生成列表与详情共用的安全来源标签。
 * @param {object} skill Skill 行
 * @returns {Array<{key:string,label:string,kind:string}>}
 */
export function getSkillSourceBadges(skill) {
  const seen = new Set()
  return (skill.origins || []).flatMap((origin) => {
    const labels = origin.origin === 'plugin' && origin.pluginName
      ? [origin.pluginName, ORIGIN_LABELS.plugin]
      : [ORIGIN_LABELS[origin.origin] || origin.origin || '未知来源']
    return labels.flatMap((label) => {
      const key = `${origin.toolId || 'unknown'}:${origin.origin || 'unknown'}:${label}`
      if (seen.has(key)) return []
      seen.add(key)
      return [{ key, label, kind: origin.origin || 'unknown' }]
    })
  })
}

export function isToolCandidate(skill, usage, toolId) {
  if (!skill.managed || skill.tools?.[toolId]?.enabled !== true) return false
  return (usage?.[TOOL_META[toolId].usageKey] || 0) === 0
}

export function hasSkillControlIssue(skill) {
  if (!skill.managed) return false
  return Object.values(skill.tools || {}).some(
    (state) => state.state === 'drifted' || state.state === 'unavailable'
  )
}

export function enrichSkillControlRows(rows, usageMap) {
  return rows.map((skill) => {
    const usage = usageMap.get(skill.name)
    const candidateTools = Object.keys(TOOL_META).filter((toolId) => isToolCandidate(skill, usage, toolId))
    return {
      ...skill,
      usage,
      candidateTools,
      isCandidate: candidateTools.length > 0,
      issue: hasSkillControlIssue(skill),
    }
  })
}

export function buildSkillControlSummary(snapshot, rows) {
  return {
    managed: snapshot?.summary?.managed || 0,
    claudeEnabled: snapshot?.summary?.claudeEnabled || 0,
    codexEnabled: snapshot?.summary?.codexEnabled || 0,
    candidateCount: rows.filter((skill) => skill.isCandidate).length,
    issueCount: rows.filter((skill) => skill.issue).length,
    externalCount: rows.filter((skill) => !skill.managed).length,
  }
}

/**
 * 生成批量收进资产库计划：唯一可变来源可自动处理，双来源必须由用户明确选版本。
 * @param {object[]} rows - 控制中心行
 * @returns {{operations:object[],conflicts:string[]}}
 */
export function buildExternalAdoptionPlan(rows) {
  const operations = []
  const conflicts = []
  rows.filter((skill) => !skill.managed).forEach((skill) => {
    const sourceToolIds = Object.entries(skill.tools || {})
      .filter(([, state]) => state.state === 'external' && state.mutable !== false)
      .map(([toolId]) => toolId)

    if (sourceToolIds.length === 1) {
      operations.push({ skillName: skill.name, toolId: sourceToolIds[0] })
    } else if (sourceToolIds.length > 1) {
      conflicts.push(skill.name)
    }
  })
  return { operations, conflicts }
}

export function filterSkillControlRows(rows, {
  activeView = 'all',
  activeTagFilter = null,
  skillTags = {},
  searchQuery = '',
} = {}) {
  let result = rows

  if (activeView === 'active') {
    result = result.filter((skill) => Object.values(skill.tools || {}).some((state) => state.enabled === true))
  } else if (activeView === 'candidates') {
    result = result.filter((skill) => skill.isCandidate)
  } else if (activeView === 'issues') {
    result = result.filter((skill) => skill.issue)
  } else if (activeView === 'external') {
    result = result.filter((skill) => !skill.managed)
  }

  // 外部 Skill 尚不能打中央标签，进入外部视图时标签筛选不应把它们全部隐藏。
  if (activeView !== 'external') {
    if (activeTagFilter === '__untagged__') {
      result = result.filter((skill) => skill.managed && !skillTags[skill.id])
    } else if (activeTagFilter) {
      result = result.filter((skill) => skillTags[skill.id] === activeTagFilter)
    }
  }

  if (searchQuery.trim()) {
    const query = searchQuery.trim().toLowerCase()
    result = result.filter((skill) => [
      skill.name,
      skill.displayName,
      skill.desc,
      skill.description,
      ...(skill.origins || []).flatMap((origin) => [
        origin.description,
        origin.pluginName,
        origin.pluginId,
        ORIGIN_LABELS[origin.origin],
      ]),
    ]
      .some((value) => value?.toLowerCase().includes(query)))
  }

  return [...result].sort((a, b) => {
    if (activeView === 'issues' && a.issue !== b.issue) return a.issue ? -1 : 1
    if (activeView === 'external') return a.name.localeCompare(b.name)
    if (activeView === 'candidates') return (a.usage?.total || 0) - (b.usage?.total || 0)
    return (b.usage?.total || 0) - (a.usage?.total || 0) || a.name.localeCompare(b.name)
  })
}
