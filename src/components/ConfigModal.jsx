/**
 * 配置中心弹窗组件
 *
 * 负责：
 * - 导入来源管理（预设工具 + 自定义路径）
 * - 推送目标配置
 * - 添加/删除自定义路径
 * - 保存配置到 dataStore
 *
 * @module ConfigModal
 */

import React, { useState, useEffect, useCallback } from 'react'
import { dataStore, toolDefinitions } from '../store/data'
import AddPathModal from './AddPathModal'
import Modal from './Modal/Modal'
import Button from './Button/Button'
import StateView from './StateView/StateView'

// 勾选图标
const checkSvg = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

/**
 * 配置中心弹窗
 * @param {Object} props - 组件属性
 * @param {boolean} props.isOpen - 是否显示弹窗
 * @param {Function} props.onClose - 关闭回调
 * @param {Function} props.onSave - 保存回调，传入 { importSources, pushTargets, newCustomPathIds }
 * @returns {JSX.Element|null} 弹窗组件
 */
export default function ConfigModal({ isOpen, onClose, onSave }) {
  // 导入来源选中状态（路径ID集合）
  const [selectedImportSources, setSelectedImportSources] = useState(new Set())
  // 推送目标选中状态（工具ID集合）
  const [selectedPushTargets, setSelectedPushTargets] = useState(new Set())
  // 自定义路径列表
  const [customPaths, setCustomPaths] = useState([])
  // 是否显示添加路径弹窗
  const [showAddPathModal, setShowAddPathModal] = useState(false)
  // 新增的路径ID列表（用于触发增量导入）
  const [newCustomPathIds, setNewCustomPathIds] = useState([])
  // 错误提示
  const [error, setError] = useState(null)
  // 是否正在加载
  const [isLoading, setIsLoading] = useState(true)

  /**
   * 规范化路径用于比较（去除末尾斜杠）
   * @param {string} pathValue - 原始路径
   * @returns {string}
   */
  const normalizePathForCompare = (pathValue) => {
    if (typeof pathValue !== 'string') return ''
    return pathValue.replace(/\/+$/, '')
  }

  /**
   * 对自定义路径按 path 去重，避免并发或脏数据造成重复渲染
   * @param {Array} paths - 路径列表
   * @returns {Array}
   */
  const dedupeCustomPaths = (paths) => {
    if (!Array.isArray(paths)) return []

    const seen = new Set()
    const deduped = []
    for (const pathItem of paths) {
      if (!pathItem?.path) continue
      const normalizedPath = normalizePathForCompare(pathItem.path)
      if (!normalizedPath || seen.has(normalizedPath)) continue
      seen.add(normalizedPath)
      deduped.push({
        ...pathItem,
        path: normalizedPath,
      })
    }
    return deduped
  }

  /**
   * 从 dataStore 加载配置
   */
  const loadConfig = useCallback(async () => {
    setIsLoading(true)
    try {
      // 1. 获取导入来源配置
      const importSources = await dataStore.getImportSources()
      // 2. 获取推送目标配置
      const pushTargets = await dataStore.getPushTargets()
      // 3. 获取自定义路径
      const paths = await dataStore.getCustomPaths()

      setSelectedImportSources(new Set(importSources || []))
      setSelectedPushTargets(new Set(pushTargets || []))
      setCustomPaths(dedupeCustomPaths(paths || []))
      setNewCustomPathIds([])
      setError(null)
    } catch (err) {
      setError('加载配置失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 弹窗打开时加载配置
  useEffect(() => {
    if (isOpen) {
      loadConfig()
    }
  }, [isOpen, loadConfig])

  /**
   * 切换导入来源选中状态
   * @param {string} sourceId - 来源ID（工具ID或自定义路径ID）
   */
  const toggleImportSource = (sourceId) => {
    setSelectedImportSources((prev) => {
      const next = new Set(prev)
      if (next.has(sourceId)) {
        next.delete(sourceId)
      } else {
        next.add(sourceId)
      }
      return next
    })
  }

  /**
   * 切换推送目标选中状态
   * @param {string} toolId - 工具ID
   */
  const togglePushTarget = (toolId) => {
    setSelectedPushTargets((prev) => {
      const next = new Set(prev)
      if (next.has(toolId)) {
        // 至少保留一个选中
        if (next.size > 1) {
          next.delete(toolId)
        }
      } else {
        next.add(toolId)
      }
      return next
    })
    setError(null)
  }

  /**
   * 删除自定义路径
   * @param {string} pathId - 路径ID
   * @param {Event} e - 点击事件
   */
  const handleDeleteCustomPath = async (pathId, e) => {
    e.stopPropagation()
    try {
      const result = await dataStore.deleteCustomPath(pathId)
      if (result.success) {
        setCustomPaths((prev) => prev.filter((p) => p.id !== pathId))
        setNewCustomPathIds((prev) => prev.filter((id) => id !== pathId))
        setSelectedImportSources((prev) => {
          const next = new Set(prev)
          next.delete(pathId)
          return next
        })
      } else {
        setError('删除失败')
      }
    } catch (err) {
      setError('删除失败')
    }
  }

  /**
   * 处理添加自定义路径确认
   * @param {Object} result - 添加结果 { path, skills }
   */
  const handleAddPathConfirm = async (result) => {
    try {
      // 调用 dataStore 添加路径
      const addResult = await dataStore.addCustomPath(result.path)
      if (addResult.success) {
        const newPath = addResult.customPath
        setCustomPaths((prev) => dedupeCustomPaths([...prev, newPath]))
        setSelectedImportSources((prev) => {
          const next = new Set(prev)
          next.add(newPath.id)
          return next
        })
        setNewCustomPathIds((prev) => Array.from(new Set([...prev, newPath.id])))
        setShowAddPathModal(false)
        setError(null)
      } else if (addResult.error === 'PATH_ALREADY_EXISTS') {
        setError('路径已存在')
      } else {
        setError('添加失败')
      }
    } catch (err) {
      setError('添加失败')
    }
  }

  /**
   * 处理保存配置
   */
  const handleSave = async () => {
    // 校验：至少保留一个推送目标
    if (selectedPushTargets.size === 0) {
      setError('至少保留一个推送目标')
      return
    }

    // 保存到 dataStore
    const importSourcesArray = Array.from(selectedImportSources)
    const pushTargetsArray = Array.from(selectedPushTargets)

    await dataStore.saveImportSources(importSourcesArray)
    await dataStore.savePushTargets(pushTargetsArray)

    // 调用 onSave 回调
    onSave({
      importSources: importSourcesArray,
      pushTargets: pushTargetsArray,
      newCustomPathIds,
    })

    // 关闭弹窗
    onClose()
  }

  /**
   * 处理取消/关闭
   */
  const handleClose = () => {
    setError(null)
    onClose()
  }

  /**
   * 获取文件夹名称
   * @param {string} path - 路径
   * @returns {string} 文件夹名
   */
  const getFolderName = (path) => {
    if (!path) return '自定义路径'
    const parts = path.split('/').filter((p) => p)
    return parts[parts.length - 1] || '自定义路径'
  }

  /**
   * 格式化 skill 统计信息
   * @param {Object} skills - { claude: 3, codex: 2 }
   * @returns {string} 格式化后的字符串
   */
  const formatSkillStats = (skills) => {
    if (!skills || Object.keys(skills).length === 0) {
      return '未发现 skill'
    }
    const entries = Object.entries(skills)
    const total = entries.reduce((sum, [, count]) => sum + count, 0)
    const details = entries.map(([tool, count]) => `${tool}: ${count} 个 skill`).join(' · ')
    return `共 ${total} 个 skill · ${details}`
  }

  return (
    <>
      <Modal
        open={isOpen}
        onClose={handleClose}
        title="配置"
        footer={
          <>
            <Button variant="secondary" onClick={handleClose}>取消</Button>
            <Button variant="primary" onClick={handleSave}>保存</Button>
          </>
        }
      >
        <StateView loading={isLoading}>
          <>
            {/* 导入来源区 */}
            <div className="config-section">
              <div className="config-section-title">
                导入来源（扫描这些路径的技能）
              </div>
              <div className="config-path-list">
                {/* 预设工具 */}
                {toolDefinitions.map((tool) => (
                  <div
                    key={tool.id}
                    className={`config-path-item ${selectedImportSources.has(tool.id) ? 'selected' : ''}`}
                    onClick={() => toggleImportSource(tool.id)}
                  >
                    <div className={`config-path-checkbox ${selectedImportSources.has(tool.id) ? 'checked' : ''}`}>
                      {selectedImportSources.has(tool.id) ? checkSvg : null}
                    </div>
                    <div className="config-path-icon">
                      {tool.icon}
                    </div>
                    <div className="config-path-info">
                      <div className="config-path-name">{tool.name}</div>
                      <div className="config-path-meta">{tool.path}</div>
                    </div>
                  </div>
                ))}

                {/* 自定义路径 */}
                {customPaths.map((path) => (
                  <div
                    key={path.id}
                    className={`config-path-item ${selectedImportSources.has(path.id) ? 'selected' : ''}`}
                    onClick={() => toggleImportSource(path.id)}
                  >
                    <div className={`config-path-checkbox ${selectedImportSources.has(path.id) ? 'checked' : ''}`}>
                      {selectedImportSources.has(path.id) ? checkSvg : null}
                    </div>
                    <div className="config-path-icon">📁</div>
                    <div className="config-path-info">
                      <div className="config-path-name">{getFolderName(path.path)}</div>
                      <div className="config-path-meta">{formatSkillStats(path.skills)}</div>
                    </div>
                    <button
                      className="config-path-delete"
                      onClick={(e) => handleDeleteCustomPath(path.id, e)}
                    >
                      删除
                    </button>
                  </div>
                ))}

                {customPaths.length === 0 && toolDefinitions.length === 0 && (
                  <div className="config-empty">暂无导入路径</div>
                )}
              </div>

              {/* 添加自定义路径按钮 */}
              <div className="config-add-btn-row">
                <button className="btn-add-path" onClick={() => setShowAddPathModal(true)}>
                  + 添加自定义路径
                </button>
              </div>
            </div>

            {/* 推送目标区 */}
            <div className="config-section">
              <div className="config-section-title">
                推送目标（勾选要推送的工具）
              </div>
              <div className="config-tool-list">
                {toolDefinitions.map((tool) => (
                  <div
                    key={tool.id}
                    className="config-tool-item"
                    style={selectedPushTargets.has(tool.id) ? undefined : { opacity: 0.7 }}
                    onClick={() => togglePushTarget(tool.id)}
                  >
                    <div className={`config-tool-checkbox ${selectedPushTargets.has(tool.id) ? 'checked' : ''}`}>
                      {selectedPushTargets.has(tool.id) ? '✓' : ''}
                    </div>
                    <div className="config-tool-info">
                      <div className="config-tool-name">{tool.name}</div>
                      <div className="config-tool-path">{tool.path}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <div style={{ color: '#c45a5a', fontSize: '13px', textAlign: 'center', padding: '10px', background: '#fdf2f2', borderRadius: '8px', marginTop: '10px' }}>
                {error}
              </div>
            )}
          </>
        </StateView>
      </Modal>

      {/* 添加路径弹窗 */}
      <AddPathModal
        isOpen={showAddPathModal}
        onClose={() => setShowAddPathModal(false)}
        onConfirm={handleAddPathConfirm}
        existingPaths={customPaths}
      />
    </>
  )
}
