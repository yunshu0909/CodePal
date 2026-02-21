/**
 * 配置页面
 *
 * 负责：
 * - 导入来源管理（预设工具 + 自定义路径）
 * - 推送目标配置
 * - 添加/删除自定义路径
 * - 保存配置到 dataStore
 * - 提供返回管理页面的导航
 *
 * @module ConfigPage
 */

import React, { useState, useEffect, useCallback } from 'react'
import { dataStore, toolDefinitions } from '../store/data'
import AddPathModal from '../components/AddPathModal'
import Toast from '../components/Toast'

// 勾选图标
const checkSvg = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

// 返回箭头图标
const backArrowSvg = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

/**
 * 配置页面组件
 * @param {Object} props - 组件属性
 * @param {Function} props.onBack - 返回管理页面的回调
 * @returns {JSX.Element} 配置页面
 */
export default function ConfigPage({ onBack }) {
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
  // Toast 提示消息
  const [toast, setToast] = useState(null)

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

  // 页面加载时加载配置
  useEffect(() => {
    loadConfig()
  }, [loadConfig])

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

    try {
      // 保存到 dataStore
      const importSourcesArray = Array.from(selectedImportSources)
      const pushTargetsArray = Array.from(selectedPushTargets)

      const saveSourcesResult = await dataStore.saveImportSources(importSourcesArray)
      if (!saveSourcesResult.success) {
        setError('保存导入来源失败')
        return
      }

      const saveTargetsResult = await dataStore.savePushTargets(pushTargetsArray)
      if (!saveTargetsResult.success) {
        setError('保存推送目标失败')
        return
      }

      // V0.4 规则：新增自定义路径后执行“仅新增不覆盖”的增量导入
      if (newCustomPathIds.length > 0) {
        const importResult = await dataStore.incrementalImport(newCustomPathIds)
        if (!importResult.success) {
          const firstError = importResult.errors?.[0]
          setError(firstError ? `增量导入失败：${firstError}` : '增量导入失败')
          return
        }
      }

      // 显示成功提示并返回管理页
      setToast({ message: '配置已保存', type: 'success' })

      // 延迟返回，让用户看到提示
      setTimeout(() => {
        onBack()
      }, 800)
    } catch (error) {
      console.error('Error saving config page:', error)
      setError('保存失败')
    }
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
    <div className="config-page" style={styles.container}>
      {/* Header with back button */}
      <div style={styles.header}>
        <button
          className="btn-back"
          style={styles.backBtn}
          onClick={onBack}
        >
          {backArrowSvg}
          <span style={styles.backText}>返回</span>
        </button>
        <h1 style={styles.headerTitle}>配置</h1>
        <div style={styles.headerRight} />
      </div>

      {/* Content */}
      <div style={styles.content}>
        {isLoading ? (
          <div style={styles.loading}>加载中...</div>
        ) : (
          <>
            {/* 导入来源区 */}
            <div className="config-section" style={styles.section}>
              <div className="config-section-title" style={styles.sectionTitle}>
                导入来源（扫描这些路径的技能）
              </div>
              <div className="config-path-list" style={styles.pathList}>
                {/* 预设工具 */}
                {toolDefinitions.map((tool) => (
                  <div
                    key={tool.id}
                    className={`config-path-item ${selectedImportSources.has(tool.id) ? 'selected' : ''}`}
                    style={{
                      ...styles.pathItem,
                      ...(selectedImportSources.has(tool.id) ? styles.pathItemSelected : {}),
                    }}
                    onClick={() => toggleImportSource(tool.id)}
                  >
                    <div
                      className={`config-path-checkbox ${selectedImportSources.has(tool.id) ? 'checked' : ''}`}
                      style={{
                        ...styles.checkbox,
                        ...(selectedImportSources.has(tool.id) ? styles.checkboxChecked : {}),
                      }}
                    >
                      {selectedImportSources.has(tool.id) ? checkSvg : null}
                    </div>
                    <div className="config-path-icon" style={styles.pathIcon}>
                      {tool.icon}
                    </div>
                    <div className="config-path-info" style={styles.pathInfo}>
                      <div className="config-path-name" style={styles.pathName}>
                        {tool.name}
                      </div>
                      <div className="config-path-meta" style={styles.pathMeta}>
                        {tool.path}
                      </div>
                    </div>
                  </div>
                ))}

                {/* 自定义路径 */}
                {customPaths.map((path) => (
                  <div
                    key={path.id}
                    className={`config-path-item ${selectedImportSources.has(path.id) ? 'selected' : ''}`}
                    style={{
                      ...styles.pathItem,
                      ...(selectedImportSources.has(path.id) ? styles.pathItemSelected : {}),
                    }}
                    onClick={() => toggleImportSource(path.id)}
                  >
                    <div
                      className={`config-path-checkbox ${selectedImportSources.has(path.id) ? 'checked' : ''}`}
                      style={{
                        ...styles.checkbox,
                        ...(selectedImportSources.has(path.id) ? styles.checkboxChecked : {}),
                      }}
                    >
                      {selectedImportSources.has(path.id) ? checkSvg : null}
                    </div>
                    <div className="config-path-icon" style={styles.pathIcon}>
                      📁
                    </div>
                    <div className="config-path-info" style={styles.pathInfo}>
                      <div className="config-path-name" style={styles.pathName}>
                        {getFolderName(path.path)}
                      </div>
                      <div className="config-path-meta" style={styles.pathMeta}>
                        {formatSkillStats(path.skills)}
                      </div>
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
                  <div style={styles.empty}>暂无导入路径</div>
                )}
              </div>

              {/* 添加自定义路径按钮 */}
              <div className="config-add-btn-row" style={styles.addBtnRow}>
                <button
                  className="btn-add-path"
                  style={styles.addPathBtn}
                  onClick={() => setShowAddPathModal(true)}
                >
                  + 添加自定义路径
                </button>
              </div>
            </div>

            {/* 推送目标区 */}
            <div className="config-section" style={styles.section}>
              <div className="config-section-title" style={styles.sectionTitle}>
                推送目标（勾选要推送的工具）
              </div>
              <div className="config-tool-list" style={styles.toolList}>
                {toolDefinitions.map((tool) => (
                  <div
                    key={tool.id}
                    className="config-tool-item"
                    style={{
                      ...styles.toolItem,
                      ...(selectedPushTargets.has(tool.id) ? {} : styles.toolItemUnchecked),
                    }}
                    onClick={() => togglePushTarget(tool.id)}
                  >
                    <div
                      className={`config-tool-checkbox ${selectedPushTargets.has(tool.id) ? 'checked' : ''}`}
                      style={{
                        ...styles.toolCheckbox,
                        ...(selectedPushTargets.has(tool.id) ? styles.toolCheckboxChecked : {}),
                      }}
                    >
                      {selectedPushTargets.has(tool.id) ? '✓' : ''}
                    </div>
                    <div className="config-tool-info" style={styles.toolInfo}>
                      <div className="config-tool-name" style={styles.toolName}>
                        {tool.name}
                      </div>
                      <div className="config-tool-path" style={styles.toolPath}>
                        {tool.path}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <div style={styles.error}>
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer with save button */}
      <div style={styles.footer}>
        <button
          className="config-btn primary"
          style={{ ...styles.btn, ...styles.btnPrimary }}
          onClick={handleSave}
          disabled={isLoading}
        >
          保存配置
        </button>
      </div>

      {/* 添加路径弹窗 */}
      <AddPathModal
        isOpen={showAddPathModal}
        onClose={() => setShowAddPathModal(false)}
        onConfirm={handleAddPathConfirm}
        existingPaths={customPaths}
      />

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// 样式定义（基于 ConfigModal 样式，适配全页面布局）
const styles = {
  container: {
    flex: 1,
    background: '#fff',
    borderRadius: '20px',
    boxShadow: '0 2px 20px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.03)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  // Header
  header: {
    padding: '28px 32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottom: '1px solid #f0eeeb',
    WebkitAppRegion: 'drag',
  },
  backBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 12px',
    borderRadius: '10px',
    border: '1.5px solid #d4d0cb',
    background: '#fff',
    color: '#555',
    fontSize: '13px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    WebkitAppRegion: 'no-drag',
  },
  backText: {
    fontSize: '13px',
    color: '#555',
  },
  headerTitle: {
    fontSize: '18px',
    fontWeight: 600,
    color: '#2d2d2d',
    margin: 0,
    flex: 1,
    textAlign: 'center',
  },
  headerRight: {
    width: '80px',
  },
  // Content
  content: {
    flex: 1,
    padding: '24px 32px',
    overflowY: 'auto',
    minHeight: 0,
  },
  loading: {
    textAlign: 'center',
    padding: '40px',
    color: '#999',
    fontSize: '14px',
  },
  section: {
    marginBottom: '28px',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#555',
    marginBottom: '12px',
  },
  pathList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  pathItem: {
    display: 'flex',
    alignItems: 'center',
    padding: '14px 16px',
    borderRadius: '14px',
    border: '1.5px solid #e8e6e3',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    position: 'relative',
  },
  pathItemSelected: {
    background: '#eff6ff',
    borderColor: '#bfdbfe',
  },
  checkbox: {
    width: '20px',
    height: '20px',
    borderRadius: '6px',
    border: '1.5px solid #d4d0cb',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.15s ease',
    background: '#fff',
    flexShrink: 0,
    marginRight: '12px',
  },
  checkboxChecked: {
    background: '#2563eb',
    borderColor: '#2563eb',
  },
  pathIcon: {
    width: '36px',
    height: '36px',
    borderRadius: '10px',
    marginRight: '10px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    flexShrink: 0,
    background: '#f5f3f0',
    color: '#888',
  },
  pathInfo: {
    flex: 1,
    minWidth: 0,
  },
  pathName: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#2d2d2d',
  },
  pathMeta: {
    fontSize: '11px',
    color: '#999',
    marginTop: '4px',
  },
  deleteBtn: {
    padding: '6px 12px',
    borderRadius: '8px',
    border: 'none',
    background: 'transparent',
    color: '#c45a5a',
    fontSize: '12px',
    cursor: 'pointer',
    opacity: 0,
    transition: 'all 0.15s ease',
  },
  addBtnRow: {
    marginTop: '12px',
  },
  addPathBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '12px',
    borderRadius: '10px',
    border: '1.5px dashed #d4d0cb',
    background: 'transparent',
    color: '#888',
    fontSize: '13px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    width: '100%',
  },
  toolList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  toolItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    cursor: 'pointer',
    borderRadius: '8px',
    transition: 'background 0.15s',
  },
  toolItemUnchecked: {
    opacity: 0.7,
  },
  toolCheckbox: {
    width: '16px',
    height: '16px',
    borderRadius: '4px',
    border: '1.5px solid #d4d0cb',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: '10px',
    color: '#fff',
  },
  toolCheckboxChecked: {
    background: '#2563eb',
    borderColor: '#2563eb',
  },
  toolInfo: {
    flex: 1,
  },
  toolName: {
    fontSize: '13px',
    color: '#2d2d2d',
  },
  toolPath: {
    fontSize: '11px',
    color: '#999',
    marginTop: '2px',
  },
  empty: {
    textAlign: 'center',
    padding: '20px',
    color: '#999',
    fontSize: '13px',
  },
  error: {
    color: '#c45a5a',
    fontSize: '13px',
    textAlign: 'center',
    padding: '10px',
    background: '#fdf2f2',
    borderRadius: '8px',
    marginTop: '10px',
  },
  // Footer
  footer: {
    padding: '16px 32px',
    borderTop: '1px solid #f0eeeb',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  btn: {
    padding: '10px 24px',
    borderRadius: '10px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    border: '1px solid #d4d0cb',
    background: '#fff',
    color: '#555',
    transition: 'all 0.15s',
  },
  btnPrimary: {
    background: '#2563eb',
    color: '#fff',
    borderColor: '#2563eb',
  },
}
