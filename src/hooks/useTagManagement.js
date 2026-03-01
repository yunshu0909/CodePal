/**
 * 标签管理 Hook
 *
 * 负责：
 * - 标签状态（tags, skillTags, activeTagFilter, isTagModalOpen）
 * - 标签 CRUD 操作及本地状态同步
 * - 技能-标签绑定/解绑
 * - 标签筛选逻辑
 *
 * @module hooks/useTagManagement
 */

import { useState, useCallback } from 'react'
import { dataStore } from '../store/data'

/**
 * 标签管理 Hook
 * @param {Function} setToast - Toast 提示回调
 * @returns {Object} 标签状态和操作方法
 */
export default function useTagManagement(setToast) {
  // 所有标签定义
  const [tags, setTags] = useState([])
  // 技能-标签映射 { skillId: tagId }
  const [skillTags, setSkillTags] = useState({})
  // 当前筛选标签 ID（null = 全部）
  const [activeTagFilter, setActiveTagFilter] = useState(null)
  // 标签管理弹窗是否打开
  const [isTagModalOpen, setIsTagModalOpen] = useState(false)

  /**
   * 加载标签数据（在 loadData 中调用）
   */
  const loadTagData = useCallback(async () => {
    const [tagList, skillTagMap] = await Promise.all([
      dataStore.getTags(),
      dataStore.getSkillTags(),
    ])
    setTags(tagList)
    setSkillTags(skillTagMap)
  }, [])

  /**
   * 给技能分配标签
   * @param {string} skillId - 技能 ID
   * @param {string} tagId - 标签 ID
   */
  const handleAssignTag = useCallback(async (skillId, tagId) => {
    const result = await dataStore.setSkillTag(skillId, tagId)
    if (result.success) {
      setSkillTags((prev) => ({ ...prev, [skillId]: tagId }))
    }
  }, [])

  /**
   * 移除技能的标签
   * @param {string} skillId - 技能 ID
   */
  const handleRemoveTag = useCallback(async (skillId) => {
    const result = await dataStore.removeSkillTag(skillId)
    if (result.success) {
      setSkillTags((prev) => {
        const next = { ...prev }
        delete next[skillId]
        return next
      })
    }
  }, [])

  /**
   * 创建标签
   * @param {string} name - 标签名
   * @returns {Promise<Object>} 创建结果
   */
  const handleCreateTag = useCallback(async (name) => {
    const result = await dataStore.createTag(name)
    if (result.success) {
      setTags((prev) => [...prev, result.tag])
      setToast({ message: `已创建标签「${name}」`, type: 'success' })
    }
    return result
  }, [setToast])

  /**
   * 重命名标签
   * @param {string} tagId - 标签 ID
   * @param {string} newName - 新名称
   * @returns {Promise<Object>} 重命名结果
   */
  const handleRenameTag = useCallback(async (tagId, newName) => {
    const result = await dataStore.renameTag(tagId, newName)
    if (result.success) {
      setTags((prev) => prev.map((t) => (t.id === tagId ? { ...t, name: newName } : t)))
      setToast({ message: `已重命名为「${newName}」`, type: 'success' })
    }
    return result
  }, [setToast])

  /**
   * 删除标签
   * @param {string} tagId - 标签 ID
   * @returns {Promise<Object>} 删除结果
   */
  const handleDeleteTag = useCallback(async (tagId) => {
    const deletedTag = tags.find((t) => t.id === tagId)
    const result = await dataStore.deleteTag(tagId)
    if (result.success) {
      setTags((prev) => prev.filter((t) => t.id !== tagId))
      // 清理本地 skillTags 中指向该标签的映射
      setSkillTags((prev) => {
        const next = { ...prev }
        for (const key of Object.keys(next)) {
          if (next[key] === tagId) delete next[key]
        }
        return next
      })
      // 如果当前筛选的标签被删除，重置筛选
      if (activeTagFilter === tagId) {
        setActiveTagFilter(null)
      }
      if (deletedTag) {
        setToast({ message: `已删除标签「${deletedTag.name}」`, type: 'success' })
      }
    }
    return result
  }, [tags, activeTagFilter, setToast])

  return {
    tags,
    skillTags,
    activeTagFilter,
    setActiveTagFilter,
    isTagModalOpen,
    setIsTagModalOpen,
    loadTagData,
    handleAssignTag,
    handleRemoveTag,
    handleCreateTag,
    handleRenameTag,
    handleDeleteTag,
  }
}
