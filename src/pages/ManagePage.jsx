/**
 * 管理页面
 *
 * 负责：
 * - 显示中央仓库中的所有技能列表（单列表，不分标签页）
 * - 管理技能的全局推送状态（聚合所有启用推送目标的状态）
 * - 搜索、筛选技能
 * - 批量选择、推送、停用操作
 * - 单条技能状态切换
 * - 配置弹窗管理
 *
 * @module ManagePage
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { dataStore, toolDefinitions } from '../store/data'
import Toast from '../components/Toast'
import PageShell from '../components/PageShell'
import SearchInput from '../components/SearchInput/SearchInput'
import Button from '../components/Button/Button'
import StateView from '../components/StateView/StateView'
import TagFilterChips from '../components/TagFilterChips/TagFilterChips'
import TagSelector from '../components/TagSelector/TagSelector'
import TagManagementModal from '../components/TagManagementModal/TagManagementModal'
import useTagManagement from '../hooks/useTagManagement'

// 勾选图标
const checkSvg = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

/**
 * 批量操作栏组件
 * @param {Object} props - 组件属性
 * @param {number} props.selectedCount - 选中的技能数量
 * @param {Function} props.onPush - 批量推送回调
 * @param {Function} props.onDeactivate - 批量停用回调
 * @param {boolean} props.isVisible - 是否显示
 * @returns {JSX.Element|null} 批量操作栏
 */
function BatchActionBar({ selectedCount, onPush, onDeactivate, isVisible }) {
  if (!isVisible) return null

  return (
    <div className="batch-bar">
      <span className="batch-info">
        已选 <strong className="batch-count">{selectedCount}</strong> 个 skill
      </span>
      <div className="batch-actions">
        <Button variant="secondary" size="sm" onClick={onDeactivate}>停用</Button>
        <Button variant="primary" size="sm" onClick={onPush}>推送</Button>
      </div>
    </div>
  )
}

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
export default function ManagePage({ onReimport, onNavigateToConfig, refreshSignal = 0 }) {
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

    // 标签过滤
    if (activeTagFilter) {
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
              <div className="header-tag">标签</div>
              <div className="header-status">
                <span className="header-status-text">状态</span>
              </div>
            </div>

            {/* Skill Rows */}
            {filteredSkills.map((skill) => {
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

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </PageShell>
  )
}
