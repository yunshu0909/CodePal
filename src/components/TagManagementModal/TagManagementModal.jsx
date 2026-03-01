/**
 * 标签管理弹窗组件
 *
 * 负责：
 * - 左侧面板：标签列表浏览 + 新建标签（inline 输入框）
 * - 右侧面板：选中标签详情（成员列表、重命名、删除）
 * - 状态切换：未选、已选、重命名态、删除确认态
 * - 通过回调通知父组件更新，由父组件统一管理 Toast
 *
 * @module components/TagManagementModal
 */

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import Modal from '../Modal/Modal'
import Button from '../Button/Button'
import './TagManagementModal.css'

/** 标签名最大长度 */
const TAG_NAME_MAX_LENGTH = 10

/**
 * 字符计数器颜色
 * @param {number} len - 当前长度
 * @returns {string} CSS 类名后缀
 */
function getCounterVariant(len) {
  if (len >= TAG_NAME_MAX_LENGTH) return 'danger'
  if (len >= 8) return 'warning'
  return 'muted'
}

/**
 * 标签管理弹窗
 * @param {boolean} open - 是否显示
 * @param {Function} onClose - 关闭回调
 * @param {Array} tags - 标签定义列表
 * @param {Object} skillTags - 技能-标签映射
 * @param {Array} skills - 所有技能列表
 * @param {Function} onCreateTag - 创建标签 (name) => Promise
 * @param {Function} onRenameTag - 重命名标签 (tagId, newName) => Promise
 * @param {Function} onDeleteTag - 删除标签 (tagId) => Promise
 * @param {Function} onRemoveSkillFromTag - 移除技能标签 (skillId) => Promise
 */
export default function TagManagementModal({
  open,
  onClose,
  tags,
  skillTags,
  skills,
  onCreateTag,
  onRenameTag,
  onDeleteTag,
  onRemoveSkillFromTag,
}) {
  // 左侧选中的标签 ID
  const [selectedTagId, setSelectedTagId] = useState(null)
  // 新建标签模式
  const [isCreating, setIsCreating] = useState(false)
  // 新建标签输入值
  const [newTagName, setNewTagName] = useState('')
  // 新建标签错误
  const [createError, setCreateError] = useState('')
  // 重命名模式
  const [isRenaming, setIsRenaming] = useState(false)
  // 重命名输入值
  const [renameValue, setRenameValue] = useState('')
  // 重命名错误
  const [renameError, setRenameError] = useState('')
  // 删除确认模式
  const [isDeleting, setIsDeleting] = useState(false)
  // 操作中
  const [isProcessing, setIsProcessing] = useState(false)

  const newTagInputRef = useRef(null)
  const renameInputRef = useRef(null)

  // 弹窗关闭时重置状态
  useEffect(() => {
    if (!open) {
      setSelectedTagId(null)
      setIsCreating(false)
      setNewTagName('')
      setCreateError('')
      setIsRenaming(false)
      setRenameValue('')
      setRenameError('')
      setIsDeleting(false)
    }
  }, [open])

  // 新建输入框自动聚焦
  useEffect(() => {
    if (isCreating && newTagInputRef.current) {
      newTagInputRef.current.focus()
    }
  }, [isCreating])

  // 重命名输入框自动聚焦
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
    }
  }, [isRenaming])

  /** 选中标签对象 */
  const selectedTag = useMemo(
    () => tags.find((t) => t.id === selectedTagId) || null,
    [tags, selectedTagId]
  )

  /** 每个标签下的技能数 */
  const tagSkillCounts = useMemo(() => {
    const counts = {}
    for (const tagId of Object.values(skillTags)) {
      counts[tagId] = (counts[tagId] || 0) + 1
    }
    return counts
  }, [skillTags])

  /** 选中标签下的技能列表 */
  const tagMembers = useMemo(() => {
    if (!selectedTagId) return []
    return skills.filter((s) => skillTags[s.id] === selectedTagId)
  }, [skills, skillTags, selectedTagId])

  // ==================== 新建标签 ====================

  const handleStartCreate = useCallback(() => {
    setIsCreating(true)
    setNewTagName('')
    setCreateError('')
  }, [])

  const handleCancelCreate = useCallback(() => {
    setIsCreating(false)
    setNewTagName('')
    setCreateError('')
  }, [])

  const handleConfirmCreate = useCallback(async () => {
    const trimmed = newTagName.trim()
    if (!trimmed) {
      setCreateError('标签名不能为空')
      return
    }
    if (trimmed.length > TAG_NAME_MAX_LENGTH) {
      setCreateError(`最多 ${TAG_NAME_MAX_LENGTH} 个字符`)
      return
    }
    // 客户端重名校验
    if (tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
      setCreateError('标签名已存在')
      return
    }

    setIsProcessing(true)
    const result = await onCreateTag(trimmed)
    setIsProcessing(false)

    if (result && result.success) {
      setIsCreating(false)
      setNewTagName('')
      setCreateError('')
      // 选中新创建的标签
      if (result.tag) {
        setSelectedTagId(result.tag.id)
      }
    } else {
      const errorMap = {
        DUPLICATE_NAME: '标签名已存在',
        EMPTY_NAME: '标签名不能为空',
        NAME_TOO_LONG: `最多 ${TAG_NAME_MAX_LENGTH} 个字符`,
      }
      setCreateError(errorMap[result?.error] || '创建失败')
    }
  }, [newTagName, tags, onCreateTag])

  const handleCreateKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirmCreate()
    } else if (e.key === 'Escape') {
      handleCancelCreate()
    }
  }, [handleConfirmCreate, handleCancelCreate])

  // ==================== 重命名 ====================

  const handleStartRename = useCallback(() => {
    if (!selectedTag) return
    setIsRenaming(true)
    setRenameValue(selectedTag.name)
    setRenameError('')
    setIsDeleting(false)
  }, [selectedTag])

  const handleCancelRename = useCallback(() => {
    setIsRenaming(false)
    setRenameValue('')
    setRenameError('')
  }, [])

  const handleConfirmRename = useCallback(async () => {
    const trimmed = renameValue.trim()
    if (!trimmed) {
      setRenameError('标签名不能为空')
      return
    }
    if (trimmed.length > TAG_NAME_MAX_LENGTH) {
      setRenameError(`最多 ${TAG_NAME_MAX_LENGTH} 个字符`)
      return
    }
    // 没有改动
    if (selectedTag && trimmed === selectedTag.name) {
      handleCancelRename()
      return
    }
    // 客户端重名校验
    if (tags.some((t) => t.id !== selectedTagId && t.name.toLowerCase() === trimmed.toLowerCase())) {
      setRenameError('标签名已存在')
      return
    }

    setIsProcessing(true)
    const result = await onRenameTag(selectedTagId, trimmed)
    setIsProcessing(false)

    if (result && result.success) {
      handleCancelRename()
    } else {
      const errorMap = {
        DUPLICATE_NAME: '标签名已存在',
        EMPTY_NAME: '标签名不能为空',
        NAME_TOO_LONG: `最多 ${TAG_NAME_MAX_LENGTH} 个字符`,
      }
      setRenameError(errorMap[result?.error] || '重命名失败')
    }
  }, [renameValue, selectedTag, selectedTagId, tags, onRenameTag, handleCancelRename])

  const handleRenameKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirmRename()
    } else if (e.key === 'Escape') {
      handleCancelRename()
    }
  }, [handleConfirmRename, handleCancelRename])

  // ==================== 删除 ====================

  const handleStartDelete = useCallback(() => {
    setIsDeleting(true)
    setIsRenaming(false)
  }, [])

  const handleCancelDelete = useCallback(() => {
    setIsDeleting(false)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    setIsProcessing(true)
    const result = await onDeleteTag(selectedTagId)
    setIsProcessing(false)

    if (result && result.success) {
      setIsDeleting(false)
      setSelectedTagId(null)
    }
  }, [selectedTagId, onDeleteTag])

  // ==================== 移除技能 ====================

  const handleRemoveSkill = useCallback(async (skillId) => {
    setIsProcessing(true)
    await onRemoveSkillFromTag(skillId)
    setIsProcessing(false)
  }, [onRemoveSkillFromTag])

  // 重命名/删除时右侧列表变灰
  const isEditing = isRenaming || isDeleting

  return (
    <Modal open={open} onClose={onClose} title="管理标签" size="lg">
      <div className="tag-modal-body">
        {/* === 左侧面板：标签列表 === */}
        <div className="tag-modal-left">
          <div className="tag-modal-left-scroll">
            {tags.length === 0 && !isCreating ? (
              <div className="tag-modal-left-empty">暂无标签</div>
            ) : (
              tags.map((tag) => (
                <div
                  key={tag.id}
                  className={`tag-modal-tag-item ${tag.id === selectedTagId ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedTagId(tag.id)
                    setIsRenaming(false)
                    setIsDeleting(false)
                  }}
                >
                  <span className="tag-modal-tag-name">{tag.name}</span>
                  <span className={`tag-modal-tag-count ${tag.id === selectedTagId ? 'active' : ''}`}>
                    {tagSkillCounts[tag.id] || 0}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* 新建标签区域 */}
          <div className="tag-modal-left-footer">
            {isCreating ? (
              <div className="tag-modal-create-form">
                <div className="tag-modal-create-input-row">
                  <input
                    ref={newTagInputRef}
                    className="tag-modal-create-input"
                    type="text"
                    value={newTagName}
                    onChange={(e) => {
                      const val = e.target.value.slice(0, TAG_NAME_MAX_LENGTH)
                      setNewTagName(val)
                      setCreateError('')
                    }}
                    onKeyDown={handleCreateKeyDown}
                    placeholder="标签名称"
                    maxLength={TAG_NAME_MAX_LENGTH}
                  />
                  <button
                    className="tag-modal-create-confirm"
                    onClick={handleConfirmCreate}
                    disabled={isProcessing}
                  >
                    确定
                  </button>
                  <button
                    className="tag-modal-create-cancel"
                    onClick={handleCancelCreate}
                  >
                    ✕
                  </button>
                </div>
                <div className="tag-modal-create-meta">
                  <span className={`tag-modal-counter tag-modal-counter--${getCounterVariant(newTagName.length)}`}>
                    {newTagName.length}/{TAG_NAME_MAX_LENGTH}
                  </span>
                  {createError && <span className="tag-modal-create-error">{createError}</span>}
                </div>
              </div>
            ) : (
              <button className="tag-modal-btn-new" onClick={handleStartCreate}>
                ＋ 新建标签
              </button>
            )}
          </div>
        </div>

        {/* === 右侧面板 === */}
        <div className="tag-modal-right">
          {!selectedTag ? (
            /* 未选状态 */
            <div className="tag-modal-placeholder">
              ← 选择一个标签查看详情
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="tag-modal-right-header">
                {isRenaming ? (
                  /* 重命名态 */
                  <div className="tag-modal-rename-form">
                    <input
                      ref={renameInputRef}
                      className="tag-modal-rename-input"
                      type="text"
                      value={renameValue}
                      onChange={(e) => {
                        const val = e.target.value.slice(0, TAG_NAME_MAX_LENGTH)
                        setRenameValue(val)
                        setRenameError('')
                      }}
                      onKeyDown={handleRenameKeyDown}
                      maxLength={TAG_NAME_MAX_LENGTH}
                    />
                    <button
                      className="tag-modal-rename-confirm"
                      onClick={handleConfirmRename}
                      disabled={isProcessing}
                    >
                      确认
                    </button>
                    <button
                      className="tag-modal-rename-cancel"
                      onClick={handleCancelRename}
                    >
                      取消
                    </button>
                    {renameError && (
                      <span className="tag-modal-rename-error">{renameError}</span>
                    )}
                  </div>
                ) : (
                  /* 正常态 */
                  <>
                    <div className="tag-modal-right-header-info">
                      <span className="tag-modal-right-tag-name">{selectedTag.name}</span>
                      <span className="tag-modal-right-skill-count">
                        {tagMembers.length} 个技能
                      </span>
                    </div>
                    <div className="tag-modal-right-actions">
                      <button
                        className="tag-modal-btn-rename"
                        onClick={handleStartRename}
                      >
                        重命名
                      </button>
                      <button
                        className="tag-modal-btn-delete"
                        onClick={handleStartDelete}
                      >
                        删除标签
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* 删除确认区 */}
              {isDeleting && (
                <div className="tag-modal-delete-confirm">
                  <div className="tag-modal-delete-text">
                    确认删除标签「<strong>{selectedTag.name}</strong>」？
                    {tagMembers.length > 0 && (
                      <> 该标签下的 {tagMembers.length} 个技能将被解除关联。</>
                    )}
                  </div>
                  <div className="tag-modal-delete-actions">
                    <button
                      className="tag-modal-btn-cancel-delete"
                      onClick={handleCancelDelete}
                    >
                      取消
                    </button>
                    <button
                      className="tag-modal-btn-confirm-delete"
                      onClick={handleConfirmDelete}
                      disabled={isProcessing}
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              )}

              {/* 技能列表 */}
              <div className={`tag-modal-skill-list ${isEditing ? 'dimmed' : ''}`}>
                {tagMembers.length === 0 ? (
                  <div className="tag-modal-skill-empty">
                    此标签暂无技能
                    <br />
                    <span className="tag-modal-skill-empty-hint">在主列表中点击技能行的标签列来分配</span>
                  </div>
                ) : (
                  tagMembers.map((skill) => (
                    <div key={skill.id} className="tag-modal-skill-item">
                      <div className="tag-modal-skill-info">
                        <div className="tag-modal-skill-name">
                          {skill.displayName || skill.name}
                        </div>
                        {skill.desc && (
                          <div className="tag-modal-skill-desc">{skill.desc}</div>
                        )}
                      </div>
                      <button
                        className="tag-modal-btn-remove"
                        onClick={() => handleRemoveSkill(skill.id)}
                        disabled={isEditing || isProcessing}
                      >
                        移出
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
