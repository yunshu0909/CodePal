/**
 * Skill 控制中心页面
 *
 * 负责：
 * - 展示中央仓库与 Claude Code / Codex 的真实启用矩阵
 * - 按工具单独启用、停用和重新同步 Skill
 * - 用分工具近 30 天调用数据生成精简候选
 * - 保留搜索、标签和运行样本查看能力
 *
 * @module ManagePage
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dataStore, toolDefinitions } from '../store/data'
import Toast from '../components/Toast'
import PageShell from '../components/PageShell'
import SearchInput from '../components/SearchInput/SearchInput'
import Button from '../components/Button/Button'
import Tag from '../components/Tag/Tag'
import BatchActionBar from '../components/BatchActionBar/BatchActionBar'
import StateView from '../components/StateView/StateView'
import Modal from '../components/Modal/Modal'
import TagFilterChips from '../components/TagFilterChips/TagFilterChips'
import TagSelector from '../components/TagSelector/TagSelector'
import TagManagementModal from '../components/TagManagementModal/TagManagementModal'
import SkillRunSamplesModal from '../components/skillUsage/SkillRunSamplesModal'
import SkillUsageBadge from '../components/skillUsage/SkillUsageBadge'
import SkillUsageColumnHeader from '../components/skillUsage/SkillUsageColumnHeader'
import SkillControlSummary from '../components/skillControl/SkillControlSummary'
import SkillActivationCell from '../components/skillControl/SkillActivationCell'
import SkillHealthBadge from '../components/skillControl/SkillHealthBadge'
import SkillStateMenu from '../components/skillControl/SkillStateMenu'
import SkillDetailsModal from '../components/skillControl/SkillDetailsModal'
import useTagManagement from '../hooks/useTagManagement'
import useSkillUsage from '../hooks/useSkillUsage'
import useSkillControl from '../hooks/useSkillControl'
import {
  TOOL_META,
  enrichSkillControlRows,
  buildSkillControlSummary,
  buildExternalAdoptionPlan,
  filterSkillControlRows,
  getSkillSourceBadges,
} from './skillControlUtils'

const VIEW_OPTIONS = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '已启用' },
  { id: 'external', label: '外部 Skill' },
  { id: 'issues', label: '有问题' },
]

function SkillControlPage({ onNavigateToConfig, refreshSignal = 0 }) {
  const [centralSkills, setCentralSkills] = useState([])
  const [centralLoading, setCentralLoading] = useState(true)
  const [centralError, setCentralError] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeView, setActiveView] = useState('all')
  const [toast, setToast] = useState(null)
  const [usageSampleSkill, setUsageSampleSkill] = useState(null)
  const [isBatchAdoptOpen, setIsBatchAdoptOpen] = useState(false)
  const [detailsSkill, setDetailsSkill] = useState(null)

  const {
    tags, skillTags, activeTagFilter, setActiveTagFilter,
    isTagModalOpen, setIsTagModalOpen,
    loadTagData,
    handleAssignTag, handleRemoveTag,
    handleCreateTag, handleRenameTag, handleDeleteTag,
  } = useTagManagement(setToast)
  const loadTagDataRef = useRef(loadTagData)
  loadTagDataRef.current = loadTagData

  const {
    status: controlStatus,
    snapshot,
    error: controlError,
    pendingKeys,
    refresh: refreshControl,
    execute: executeControl,
    setActivation,
    adoptExternalSkill,
    adoptExternalSkills,
  } = useSkillControl(refreshSignal)

  const loadCentralMetadata = useCallback(async () => {
    setCentralLoading(true)
    try {
      const skills = await dataStore.getCentralSkills()
      setCentralSkills(skills)
      setCentralError(null)
      await loadTagDataRef.current()
    } catch (error) {
      setCentralError(error?.message || 'CENTRAL_SKILL_LOAD_FAILED')
    } finally {
      setCentralLoading(false)
    }
  }, [])

  useEffect(() => {
    loadCentralMetadata()
  }, [loadCentralMetadata, refreshSignal])

  const managedSkillNames = useMemo(() => centralSkills.map((skill) => skill.name), [centralSkills])
  const { status: usageStatus, usageMap, sources: usageSources } = useSkillUsage(managedSkillNames)
  const centralByName = useMemo(() => new Map(centralSkills.map((skill) => [skill.name, skill])), [centralSkills])

  const rows = useMemo(() => (snapshot?.skills || []).map((controlSkill) => {
    const metadata = centralByName.get(controlSkill.name)
    const externalTools = Object.entries(controlSkill.tools || {})
      .filter(([, state]) => state.state === 'external')
      .map(([toolId]) => TOOL_META[toolId]?.fullName)
      .filter(Boolean)
    return {
      ...controlSkill,
      id: controlSkill.name,
      displayName: metadata?.displayName || controlSkill.displayName || controlSkill.name,
      desc: metadata?.desc || controlSkill.description || controlSkill.origins?.find((origin) => origin.description)?.description
        || (controlSkill.managed ? '' : `仅存在于 ${externalTools.join(' / ')}`),
    }
  }), [snapshot, centralByName])

  const enrichedRows = useMemo(() => enrichSkillControlRows(rows, usageMap), [rows, usageMap])
  const summary = useMemo(() => buildSkillControlSummary(snapshot, enrichedRows), [snapshot, enrichedRows])
  const filteredRows = useMemo(() => filterSkillControlRows(enrichedRows, {
    activeView,
    activeTagFilter,
    skillTags,
    searchQuery,
  }), [enrichedRows, activeView, activeTagFilter, skillTags, searchQuery])
  const externalRows = useMemo(() => enrichedRows.filter((skill) => !skill.managed), [enrichedRows])
  const batchAdoption = useMemo(() => buildExternalAdoptionPlan(externalRows), [externalRows])

  const handleActivation = useCallback(async (skill, toolId, enabled, isSync = false) => {
    const tool = TOOL_META[toolId]
    const source = skill.origins?.find((item) => item.toolId === toolId && item.mutable)
    const result = await setActivation({ skillName: skill.name, toolId, enabled, source })
    if (!result.success) {
      setToast({ message: result.error === 'PERMISSION_DENIED' ? '操作失败，请检查工具目录权限' : '操作失败，已保留原状态', type: 'error' })
      return
    }

    const action = isSync ? '同步' : enabled ? '启用' : '停用'
    setToast({ message: `已在 ${tool.fullName} ${action} ${skill.displayName || skill.name}`, type: 'success' })
  }, [setActivation])

  const handleAdopt = useCallback(async (skill, toolId) => {
    const tool = TOOL_META[toolId]
    const result = await adoptExternalSkill({ skillName: skill.name, toolId })
    if (result.adopted?.length > 0) {
      await loadCentralMetadata()
      setToast({ message: `已从 ${tool.fullName} 收进资产库：${skill.displayName || skill.name}`, type: 'success' })
      return
    }
    setToast({ message: '收进资产库失败，原外部 Skill 已保留', type: 'error' })
  }, [adoptExternalSkill, loadCentralMetadata])

  const handleStateAction = useCallback(async (skill, command) => {
    if (command.action === 'delete-central') {
      if (!window.confirm(`只从 CodePal 中央仓库删除 ${skill.name}？工具侧副本会保留。`)) return
      const result = await dataStore.removeCentralSkill(skill.name)
      if (!result?.success) {
        setToast({ message: '中央资产删除失败，工具副本未修改', type: 'error' })
        return
      }
      await Promise.all([loadCentralMetadata(), refreshControl({ silent: true })])
      setToast({ message: `已从中央仓库删除 ${skill.name}，工具副本已保留`, type: 'success' })
      return
    }
    const source = skill.origins?.find((item) => item.toolId === command.toolId && item.mutable)
    const result = await executeControl({ skillName: skill.name, toolId: command.toolId, action: command.action, source })
    setToast(result.success
      ? { message: command.action === 'remove-tool' ? '已从工具移除，中央资产已保留' : '启用状态已更新', type: 'success' }
      : { message: result.error === 'ORIGIN_READ_ONLY' ? '该来源由项目或 Plugin 管理，CodePal 只读展示' : '操作失败，原状态已保留', type: 'error' })
  }, [executeControl, loadCentralMetadata, refreshControl])

  const handleBatchAdopt = useCallback(async () => {
    const result = await adoptExternalSkills(batchAdoption.operations)
    await loadCentralMetadata()
    setIsBatchAdoptOpen(false)

    const adoptedCount = result.adopted?.length || 0
    const failedCount = result.failed?.length || 0
    const conflictCount = batchAdoption.conflicts.length
    if (failedCount === 0 && conflictCount === 0) {
      setToast({ message: `已将 ${adoptedCount} 个外部 Skill 收进资产库`, type: 'success' })
      return
    }
    setToast({
      message: `已收进 ${adoptedCount} 个，${conflictCount} 个来源冲突、${failedCount} 个失败`,
      type: failedCount > 0 ? 'error' : 'warning',
    })
  }, [adoptExternalSkills, batchAdoption, loadCentralMetadata])

  const isLoading = controlStatus === 'loading' || centralLoading
  const pageError = controlStatus === 'error' || centralError ? (
    <><strong>Skill 状态读取失败</strong><br /><span>没有修改任何目录</span></>
  ) : null
  const unavailableTools = Object.values(snapshot?.tools || {}).filter((tool) => !tool.available)
  const partialMessage = useMemo(() => {
    if (!snapshot?.partial) return null
    const legacyBlocked = snapshot.errors?.some((item) => item.toolId === 'codex' && item.origin === 'legacy')
    if (legacyBlocked) return 'Codex 兼容路径暂时不可读，其他来源仍可管理'
    return '部分 Skill 来源暂时不可读，已保留其余真实状态'
  }, [snapshot])
  const hasFilter = activeView !== 'all' || Boolean(activeTagFilter) || Boolean(searchQuery.trim())

  return (
    <PageShell
      title="Skill 控制中心"
      subtitle="这里只显示独立 Skill；Plugin 所带能力请到 Plugin 控制中心查看"
      className="page-shell--no-padding skill-control-page"
      actions={
        <>
          {activeView === 'external' && batchAdoption.operations.length > 0 && (
            <Button variant="primary" size="sm" onClick={() => setIsBatchAdoptOpen(true)}>全部收进资产库</Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setIsTagModalOpen(true)}>管理标签</Button>
          <Button variant="secondary" size="sm" onClick={onNavigateToConfig}>配置</Button>
        </>
      }
    >
      <StateView
        loading={isLoading}
        loadingMessage="正在读取真实 Skill 状态"
        error={pageError}
        onRetry={() => { refreshControl(); loadCentralMetadata() }}
        empty={!isLoading && enrichedRows.length === 0}
        emptyMessage="中央仓库还没有 Skill"
        emptyHint="查看外部 Skill"
      >
        <>
          <SkillControlSummary summary={summary} activeView={activeView} onSelect={setActiveView} />

          <div className="skill-control-toolbar">
            <div className="skill-control-views" aria-label="Skill 视图筛选">
              {VIEW_OPTIONS.map((view) => (
                <button
                  type="button"
                  key={view.id}
                  className={`skill-control-view ${activeView === view.id ? 'is-active' : ''}`}
                  onClick={() => setActiveView(view.id)}
                >
                  {view.label}{view.id === 'external' && summary.externalCount > 0 ? ` ${summary.externalCount}` : ''}
                </button>
              ))}
            </div>
            <SearchInput
              className="skill-control-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索 Skill"
            />
          </div>

          {tags.length > 0 && (
            <TagFilterChips
              tags={tags}
              skillTags={skillTags}
              totalSkillCount={snapshot?.summary?.managed || 0}
              activeTagId={activeTagFilter}
              onSelect={setActiveTagFilter}
            />
          )}

          {unavailableTools.length > 0 && (
            <div className="skill-control-partial">
              {unavailableTools.map((tool) => tool.name).join('、')} 状态无法读取，其他数据仍可使用
            </div>
          )}

          {partialMessage && <div className="skill-control-partial">{partialMessage}</div>}

          <div className="skill-control-table-wrap">
            <div className="skill-control-row skill-control-row--header">
              <div>Skill 与作用</div>
              <div>近 30 天</div>
              <div>来源</div>
              <div className="skill-control-tool-heading"><span className="skill-control-brand skill-control-brand--claude">CC</span>Claude</div>
              <div className="skill-control-tool-heading"><span className="skill-control-brand skill-control-brand--codex">CX</span>Codex</div>
              <div>健康</div>
            </div>

            {filteredRows.length === 0 ? (
              <div className="skill-control-empty-filter">
                <div><strong>没有符合条件的 Skill</strong><div className="skill-control-empty-filter__hint">清除搜索或切回“全部”</div></div>
              </div>
            ) : filteredRows.map((skill) => (
              <div key={skill.name} className={`skill-control-row ${skill.issue ? 'skill-control-row--issue' : ''}`}>
                <div className="skill-control-name" title={`${skill.displayName}\n${skill.desc || skill.name}`}>
                  <div className="skill-control-name__title">{skill.displayName}</div>
                  <div className="skill-control-name__meta">
                    {skill.displayName !== skill.name || skill.desc ? `${skill.name}${skill.desc ? ` · ${skill.desc}` : ''}` : '中央资产'}
                  </div>
                </div>
                <div className="skill-control-usage">
                  {skill.managed ? (
                    <SkillUsageBadge
                      usage={skill.usage}
                      loading={usageStatus === 'loading'}
                      error={usageStatus === 'error'}
                      onClick={(event) => { event.stopPropagation(); setUsageSampleSkill(skill) }}
                      title="查看清洗后的运行样本"
                    />
                  ) : '—'}
                </div>
                <div onClick={(event) => event.stopPropagation()}>
                  <div className="skill-control-sources">
                    {getSkillSourceBadges(skill).slice(0, 2).map((source) => (
                      <Tag key={source.key} variant={source.kind === 'plugin' ? 'info' : 'default'}>{source.label}</Tag>
                    ))}
                  </div>
                </div>
                {Object.keys(TOOL_META).map((toolId) => {
                  const tool = TOOL_META[toolId]
                  const pending = pendingKeys.has(`${skill.name}:${toolId}`)
                    || pendingKeys.has(`adopt:${skill.name}:${toolId}`)
                  return (
                    <SkillActivationCell
                      key={toolId}
                      state={skill.tools?.[toolId]}
                      usageCount={skill.usage?.[tool.usageKey] || 0}
                      pending={pending}
                      managed={skill.managed}
                      toolName={tool.fullName}
                      onChange={(enabled) => handleActivation(skill, toolId, enabled)}
                      onSync={() => handleActivation(skill, toolId, true, true)}
                      onAdopt={() => handleAdopt(skill, toolId)}
                    />
                  )
                })}
                <div className="skill-control-health">
                  <SkillHealthBadge skill={skill} isCandidate={skill.isCandidate} />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`查看 ${skill.name} 详情`}
                    onClick={() => setDetailsSkill(skill)}
                  >
                    查看
                  </Button>
                  <SkillStateMenu skill={skill} pendingKeys={pendingKeys} onAction={(command) => handleStateAction(skill, command)} />
                </div>
              </div>
            ))}
          </div>

          <footer className="skill-control-footer">
            <span>显示 {filteredRows.length} / {enrichedRows.length} · 状态来自本机实际目录与官方 CLI</span>
            <span>{usageSources && usageStatus === 'ready' ? '0 次表示近 30 天未观察到显式调用' : '调用统计加载中'}</span>
          </footer>
        </>
      </StateView>

      <TagManagementModal
        open={isTagModalOpen}
        onClose={() => { setIsTagModalOpen(false); loadCentralMetadata() }}
        tags={tags}
        skillTags={skillTags}
        skills={centralSkills}
        onCreateTag={handleCreateTag}
        onRenameTag={handleRenameTag}
        onDeleteTag={handleDeleteTag}
        onRemoveSkillFromTag={handleRemoveTag}
      />

      <SkillRunSamplesModal
        open={Boolean(usageSampleSkill)}
        onClose={() => setUsageSampleSkill(null)}
        skill={usageSampleSkill}
      />

      <SkillDetailsModal skill={detailsSkill} onClose={() => setDetailsSkill(null)} />

      <Modal
        open={isBatchAdoptOpen}
        onClose={() => setIsBatchAdoptOpen(false)}
        title="将外部 Skill 收进资产库"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsBatchAdoptOpen(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={batchAdoption.operations.length === 0}
              onClick={handleBatchAdopt}
            >
              收进 {batchAdoption.operations.length} 个
            </Button>
          </>
        }
      >
        <div className="skill-adoption-confirm">
          <p>收进后，中央资产库将成为这些 Skill 的维护版本，Claude Code / Codex 中的原外部项会替换为 CodePal 副本。</p>
          <p>软链接指向的原始上游目录不会删除。</p>
          {batchAdoption.conflicts.length > 0 && (
            <p className="skill-adoption-confirm__warning">
              {batchAdoption.conflicts.length} 个 Skill 同时存在于两个工具，批量操作会跳过，请回到列表选择来源工具。
            </p>
          )}
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </PageShell>
  )
}

// 勾选图标
const checkSvg = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

/**
 * 合并技能列表并保持已有项顺序稳定
 * @param {Array} previousSkills - 旧列表
 * @param {Array} latestSkills - 新计算列表
 * @returns {Array}
 */
function mergeSkillsKeepOrder(previousSkills, latestSkills) {
  if (!Array.isArray(previousSkills) || previousSkills.length === 0) {
    return latestSkills
  }

  const latestById = new Map(latestSkills.map((skill) => [skill.id, skill]))
  const merged = []

  // 先按旧顺序保留仍然存在的项，避免自动刷新后列表跳动
  for (const previousSkill of previousSkills) {
    if (!latestById.has(previousSkill.id)) continue
    merged.push(latestById.get(previousSkill.id))
    latestById.delete(previousSkill.id)
  }

  // 再把新增项追加到末尾，满足“只新增不改已有位置”
  for (const latestSkill of latestSkills) {
    if (latestById.has(latestSkill.id)) {
      merged.push(latestSkill)
      latestById.delete(latestSkill.id)
    }
  }

  return merged
}

/**
 * 管理页面组件
 * @param {Object} props - 组件属性
 * @param {Function} props.onReimport - 重新导入回调（V0.4 保留但不在界面展示）
 * @param {Function} props.onNavigateToConfig - 导航到配置页面的回调
 * @param {number} [props.refreshSignal=0] - 自动刷新信号（新增 skill 后触发）
 * @returns {JSX.Element} 管理页面
 */
function LegacyManagePage({ onReimport, onNavigateToConfig, refreshSignal = 0 }) {
  // 所有技能列表（带全局推送状态）
  const [skills, setSkills] = useState([])
  // 搜索关键词
  const [searchQuery, setSearchQuery] = useState('')
  // 选中的 skill ID 集合
  const [selected, setSelected] = useState(new Set())
  // 是否正在加载数据
  const [isLoading, setIsLoading] = useState(true)
  // 是否正在处理推送/停用操作
  const [isProcessing, setIsProcessing] = useState(false)
  // Toast 提示消息
  const [toast, setToast] = useState(null)

  // 操作锁引用，防止并发操作
  const operationLock = React.useRef(false)
  // 启用的推送目标列表
  const [pushTargets, setPushTargets] = useState([])

  // 标签管理（状态 + 操作方法）
  const {
    tags, skillTags, activeTagFilter, setActiveTagFilter,
    isTagModalOpen, setIsTagModalOpen,
    loadTagData,
    handleAssignTag, handleRemoveTag,
    handleCreateTag, handleRenameTag, handleDeleteTag,
  } = useTagManagement(setToast)

  // 调用次数（近30天，Claude+Codex 合计）—— 逻辑在 useSkillUsage hook，列表不被扫描阻塞
  const skillNames = useMemo(() => skills.map((s) => s.name), [skills])
  const {
    status: usageStatus,
    usageMap,
    sources: usageSources,
    scanMeta: usageScanMeta,
  } = useSkillUsage(skillNames)
  // 「调用」列排序（默认降序）+ 说明浮层开关
  const [usageSort, setUsageSort] = useState('desc')
  const [usageHelpOpen, setUsageHelpOpen] = useState(false)
  const [usageSampleSkill, setUsageSampleSkill] = useState(null)

  /**
   * 加载技能数据和推送目标配置
   */
  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      // 1. 获取启用的推送目标
      const targets = await dataStore.getPushTargets()
      // 过滤出有效的工具定义
      const validTargets = targets.filter((id) =>
        toolDefinitions.some((t) => t.id === id)
      )
      setPushTargets(validTargets)

      // 2. 获取中央仓库所有技能
      const centralSkills = await dataStore.getCentralSkills()

      // 3. 计算每个技能的全局推送状态
      const skillsWithGlobalStatus = await Promise.all(
        centralSkills.map(async (skill) => {
          // 检查该技能在每个启用目标中的推送状态
          const pushStatusList = await Promise.all(
            validTargets.map(async (toolId) => {
              return await dataStore.isPushed(toolId, skill.name)
            })
          )

          // 全部已推送才算"已推送"
          const allPushed = pushStatusList.length > 0 && pushStatusList.every((status) => status)

          return {
            ...skill,
            pushed: allPushed,
            toolStatus: validTargets.reduce((acc, toolId, index) => {
              acc[toolId] = pushStatusList[index]
              return acc
            }, {}),
          }
        })
      )

      setSkills((previousSkills) => mergeSkillsKeepOrder(previousSkills, skillsWithGlobalStatus))

      // 4. 加载标签数据
      await loadTagData()
    } catch (error) {
      console.error('Error loading data:', error)
      setToast({ message: '加载数据失败', type: 'error' })
    } finally {
      setIsLoading(false)
    }
  }, [loadTagData])

  // 初始加载
  useEffect(() => {
    loadData()
  }, [loadData])

  // 收到自动刷新信号后重载列表，展示新增 skill
  useEffect(() => {
    if (refreshSignal <= 0) return
    loadData()
  }, [refreshSignal, loadData])

  /**
   * 根据标签和搜索关键词过滤技能列表
   * 标签过滤在前（AND 逻辑），搜索过滤在后
   */
  const filteredSkills = useMemo(() => {
    let result = skills

    // 标签过滤：__untagged__ 筛出无标签技能，其余按标签 ID 精确匹配
    if (activeTagFilter === '__untagged__') {
      result = result.filter((s) => !skillTags[s.id])
    } else if (activeTagFilter) {
      result = result.filter((s) => skillTags[s.id] === activeTagFilter)
    }

    // 搜索过滤
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter((skill) => {
        const nameMatch = skill.name.toLowerCase().includes(query)
        const displayNameMatch = skill.displayName && skill.displayName.toLowerCase().includes(query)
        const descMatch = skill.desc && skill.desc.toLowerCase().includes(query)
        return nameMatch || displayNameMatch || descMatch
      })
    }

    return result
  }, [skills, searchQuery, activeTagFilter, skillTags])

  // 在标签/搜索过滤之后按「调用」列排序（V8 sort 稳定，等值保持原顺序）
  const sortedSkills = useMemo(() => {
    if (!usageSort) return filteredSkills
    const dir = usageSort === 'asc' ? 1 : -1
    const countOf = (s) => usageMap.get(s.name)?.total || 0
    return [...filteredSkills].sort((a, b) => (countOf(a) - countOf(b)) * dir)
  }, [filteredSkills, usageSort, usageMap])

  const openUsageSamples = useCallback((skill, event) => {
    event.stopPropagation()
    setUsageSampleSkill(skill)
  }, [])

  /**
   * 计算全选复选框的状态
   * @returns {'unchecked' | 'indeterminate' | 'checked'} 全选状态
   */
  const getSelectAllState = useCallback(() => {
    if (filteredSkills.length === 0) return 'unchecked'

    const filteredIds = new Set(filteredSkills.map((s) => s.id))
    const selectedFilteredCount = [...selected].filter((id) =>
      filteredIds.has(id)
    ).length

    if (selectedFilteredCount === 0) return 'unchecked'
    if (selectedFilteredCount === filteredSkills.length) return 'checked'
    return 'indeterminate'
  }, [filteredSkills, selected])

  /**
   * 切换单个技能的选中状态
   * @param {string} skillId - 技能 ID
   * @param {Event} e - 点击事件（可选，用于阻止冒泡）
   */
  const toggleSelection = useCallback((skillId, e) => {
    if (e) e.stopPropagation()

    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(skillId)) {
        next.delete(skillId)
      } else {
        next.add(skillId)
      }
      return next
    })
  }, [])

  /**
   * 处理全选/取消全选
   * 仅对当前过滤结果进行操作
   */
  const handleSelectAll = useCallback(() => {
    const state = getSelectAllState()
    const filteredIds = filteredSkills.map((s) => s.id)

    if (state === 'checked') {
      // 取消全选：移除当前过滤结果的所有选中
      setSelected((prev) => {
        const next = new Set(prev)
        filteredIds.forEach((id) => next.delete(id))
        return next
      })
    } else {
      // 全选：添加当前过滤结果的所有项
      setSelected((prev) => {
        const next = new Set(prev)
        filteredIds.forEach((id) => next.add(id))
        return next
      })
    }
  }, [filteredSkills, getSelectAllState])

  /**
   * 切换单个技能的推送状态
   * 已推送 -> 停用，未推送 -> 推送
   * 采用静默更新，不触发 loading，保持滚动位置
   * @param {Object} skill - 技能对象
   * @param {Event} e - 点击事件
   */
  const toggleSkillStatus = useCallback(async (skill, e) => {
    if (e) e.stopPropagation()
    // 操作锁检查：防止并发操作
    if (operationLock.current || isProcessing) {
      return
    }
    if (pushTargets.length === 0) {
      setToast({ message: '未配置推送目标，请先点击右上角"配置"', type: 'warning' })
      return
    }

    // 获取操作锁
    operationLock.current = true
    setIsProcessing(true)
    try {
      let success = false
      if (skill.pushed) {
        // 已推送 -> 停用：从所有启用的推送目标中移除
        const results = await Promise.all(
          pushTargets.map(async (toolId) => {
            // 只处理实际已推送的
            const isPushed = await dataStore.isPushed(toolId, skill.name)
            if (isPushed) {
              return await dataStore.unpushSkills(toolId, [skill.name])
            }
            return { success: true, unpushedCount: 0 }
          })
        )

        const totalUnpushed = results.reduce((sum, r) => sum + (r.unpushedCount || 0), 0)
        success = totalUnpushed > 0
        if (success) {
          setToast({ message: `已停用 ${skill.displayName || skill.name}`, type: 'success' })
        }
      } else {
        // 未推送 -> 推送：推送到所有启用的推送目标
        const results = await Promise.all(
          pushTargets.map(async (toolId) => {
            // 只处理未推送的
            const isPushed = await dataStore.isPushed(toolId, skill.name)
            if (!isPushed) {
              return await dataStore.pushSkills(toolId, [skill.name])
            }
            return { success: true, pushedCount: 0 }
          })
        )

        const totalPushed = results.reduce((sum, r) => sum + (r.pushedCount || 0), 0)
        success = totalPushed > 0
        if (success) {
          setToast({ message: `已推送 ${skill.displayName || skill.name}`, type: 'success' })
        }
      }

      // 静默更新：只修改当前技能的 pushed 状态，不重新加载整个列表
      if (success) {
        setSkills((prevSkills) =>
          prevSkills.map((s) =>
            s.id === skill.id ? { ...s, pushed: !s.pushed } : s
          )
        )
      }
    } catch (error) {
      console.error('Toggle skill status error:', error)
      setToast({ message: '操作失败', type: 'error' })
    } finally {
      setIsProcessing(false)
      // 释放操作锁
      operationLock.current = false
    }
  }, [isProcessing, pushTargets])

  /**
   * 批量推送选中的技能
   * 只处理选中的未推送项，已推送项跳过
   */
  const handleBatchPush = useCallback(async () => {
    // 操作锁检查：防止并发操作
    if (operationLock.current || selected.size === 0) return
    if (pushTargets.length === 0) {
      setToast({ message: '未配置推送目标，请先点击右上角”配置”', type: 'warning' })
      return
    }

    // 获取操作锁
    operationLock.current = true
    setIsProcessing(true)
    try {
      // 筛选出选中的未推送技能
      const selectedUnpushedSkills = skills.filter(
        (s) => selected.has(s.id) && !s.pushed
      )

      if (selectedUnpushedSkills.length === 0) {
        setToast({ message: '选中的技能已全部推送', type: 'info' })
        setIsProcessing(false)
        return
      }

      const skillNames = selectedUnpushedSkills.map((s) => s.name)

      // 推送到所有启用的推送目标
      const results = await Promise.all(
        pushTargets.map(async (toolId) => {
          return await dataStore.pushSkills(toolId, skillNames)
        })
      )

      const totalPushed = results.reduce((sum, r) => sum + (r.pushedCount || 0), 0)
      const uniqueTools = pushTargets.length

      setToast({ message: `已推送 ${selectedUnpushedSkills.length} 个 skill 到 ${uniqueTools} 个工具`, type: 'success' })

      // 清空选中并刷新
      setSelected(new Set())
      await loadData()
    } catch (error) {
      console.error('Batch push error:', error)
      setToast({ message: '批量推送失败', type: 'error' })
    } finally {
      setIsProcessing(false)
      // 释放操作锁
      operationLock.current = false
    }
  }, [selected, skills, pushTargets, loadData])

  /**
   * 批量停用选中的技能
   * 只处理选中的已推送项，未推送项跳过
   */
  const handleBatchDeactivate = useCallback(async () => {
    // 操作锁检查：防止并发操作
    if (operationLock.current || selected.size === 0) return
    if (pushTargets.length === 0) {
      setToast({ message: '未配置推送目标，请先点击右上角”配置”', type: 'warning' })
      return
    }

    // 获取操作锁
    operationLock.current = true
    setIsProcessing(true)
    try {
      // 筛选出选中的已推送技能
      const selectedPushedSkills = skills.filter(
        (s) => selected.has(s.id) && s.pushed
      )

      if (selectedPushedSkills.length === 0) {
        setToast({ message: '选中的技能未推送，无需停用', type: 'info' })
        setIsProcessing(false)
        return
      }

      const skillNames = selectedPushedSkills.map((s) => s.name)

      // 从所有启用的推送目标中移除
      await Promise.all(
        pushTargets.map(async (toolId) => {
          return await dataStore.unpushSkills(toolId, skillNames)
        })
      )

      setToast({ message: `已停用 ${selectedPushedSkills.length} 个 skill`, type: 'success' })

      // 清空选中并刷新
      setSelected(new Set())
      await loadData()
    } catch (error) {
      console.error('Batch deactivate error:', error)
      setToast({ message: '批量停用失败', type: 'error' })
    } finally {
      setIsProcessing(false)
      // 释放操作锁
      operationLock.current = false
    }
  }, [selected, skills, pushTargets, loadData])

  // 全选状态
  const selectAllState = getSelectAllState()

  // 是否有选中项（用于控制批量操作栏显示）
  const hasSelected = selected.size > 0

  return (
    <PageShell
      title="Skills 管理"
      subtitle="管理和推送你的 Skills 到各个工具"
      className="page-shell--no-padding"
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={() => setIsTagModalOpen(true)}>管理标签</Button>
          <Button variant="secondary" size="sm" onClick={onNavigateToConfig}>配置</Button>
        </>
      }
    >
      {/* Search */}
      <div className="manage-search">
        <SearchInput
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索 skill..."
          disabled={isLoading}
        />
      </div>

      {/* Tag Filter Chips */}
      {tags.length > 0 && (
        <TagFilterChips
          tags={tags}
          skillTags={skillTags}
          totalSkillCount={skills.length}
          activeTagId={activeTagFilter}
          onSelect={setActiveTagFilter}
        />
      )}

      {/* Batch Action Bar */}
      <BatchActionBar
        selectedCount={selected.size}
        onPush={handleBatchPush}
        onDeactivate={handleBatchDeactivate}
        isVisible={hasSelected}
      />

      {/* Skill List */}
      <div className="manage-skill-list">
        <StateView
          loading={isLoading}
          empty={filteredSkills.length === 0}
          emptyMessage={searchQuery ? '没有找到匹配的 skill' : '中央仓库为空，请先导入 skills'}
        >
          <>
            {/* Table Header */}
            <div className="skill-header">
              <div className="header-skill-info">
                <div
                  className={`header-select-all ${selectAllState !== 'unchecked' ? 'checked' : ''}`}
                  onClick={handleSelectAll}
                  title="全选/取消全选"
                >
                  {selectAllState === 'checked' ? checkSvg : selectAllState === 'indeterminate' ? (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2.5 6H9.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  ) : null}
                </div>
                <span className="header-text">Skill ({filteredSkills.length})</span>
              </div>
              <SkillUsageColumnHeader
                sort={usageSort}
                onToggleSort={() => setUsageSort((p) => (p === 'desc' ? 'asc' : 'desc'))}
                helpOpen={usageHelpOpen}
                onToggleHelp={() => setUsageHelpOpen((v) => !v)}
                sources={usageSources}
                scanMeta={usageScanMeta}
              />
              <div className="header-tag">标签</div>
              <div className="header-status">
                <span className="header-status-text">状态</span>
              </div>
            </div>

            {/* Skill Rows */}
            {sortedSkills.map((skill) => {
              const isSelected = selected.has(skill.id)
              return (
                <div
                  key={skill.id}
                  className={`skill-card-v4 ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleSelection(skill.id)}
                >
                  <div
                    className={`skill-check-v4 ${isSelected ? 'checked' : ''}`}
                    onClick={(e) => toggleSelection(skill.id, e)}
                  >
                    {isSelected ? checkSvg : null}
                  </div>
                  <div className="skill-info">
                    <div className="skill-name">
                      {skill.displayName || skill.name}
                    </div>
                    <div className="skill-desc">{skill.desc}</div>
                  </div>
                  <div className="skill-usage-column">
                    <SkillUsageBadge
                      usage={usageMap.get(skill.name)}
                      loading={usageStatus === 'loading'}
                      error={usageStatus === 'error'}
                      onClick={(event) => openUsageSamples(skill, event)}
                      title="查看调用记录"
                    />
                  </div>
                  <div className="skill-tag-column" onClick={(e) => e.stopPropagation()}>
                    <TagSelector
                      skillId={skill.id}
                      currentTagId={skillTags[skill.id] || null}
                      tags={tags}
                      onAssign={handleAssignTag}
                      onRemove={handleRemoveTag}
                    />
                  </div>
                  <div
                    className="skill-status-container"
                    onClick={(e) => toggleSkillStatus(skill, e)}
                  >
                    <span className={`status-tag ${skill.pushed ? 'pushed' : 'not-pushed'}`}>
                      {skill.pushed ? '已推送' : '未推送'}
                    </span>
                  </div>
                </div>
              )
            })}
          </>
        </StateView>
      </div>

      {/* Footer */}
      <div className="manage-footer">
        <span className="manage-footer-info">
          共 {skills.length} 个技能 · 已推送 {skills.filter((s) => s.pushed).length}
        </span>
      </div>

      {/* Tag Management Modal */}
      <TagManagementModal
        open={isTagModalOpen}
        onClose={() => { setIsTagModalOpen(false); loadData() }}
        tags={tags}
        skillTags={skillTags}
        skills={skills}
        onCreateTag={handleCreateTag}
        onRenameTag={handleRenameTag}
        onDeleteTag={handleDeleteTag}
        onRemoveSkillFromTag={handleRemoveTag}
      />

      <SkillRunSamplesModal
        open={Boolean(usageSampleSkill)}
        onClose={() => setUsageSampleSkill(null)}
        skill={usageSampleSkill}
      />

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </PageShell>
  )
}

/**
 * 新宿主使用 v2 控制中心；缺少新 IPC 的旧宿主继续使用原管理页。
 * @param {object} props 页面参数
 * @returns {JSX.Element}
 */
export default function ManagePage(props) {
  const supportsSkillControl = typeof window !== 'undefined' && Boolean(window.electronAPI?.getSkillControlSnapshot)
  return supportsSkillControl ? <SkillControlPage {...props} /> : <LegacyManagePage {...props} />
}
