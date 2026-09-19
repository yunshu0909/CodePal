/**
 * 导入页面
 *
 * 负责：
 * - 扫描工具目录获取技能列表
 * - 选择要导入的工具和自定义路径
 * - 管理中央仓库位置
 * - 执行导入/重新导入操作
 *
 * @module ImportPage
 */

import React, { useState, useEffect } from 'react'
import { toolDefinitions, dataStore } from '../store/data'
import Checkbox from '../components/Checkbox'
import { toast } from '../components/Toast'
import AddPathModal from '../components/AddPathModal'
import PageShell from '../components/PageShell'

/**
 * 导入页面组件
 * @param {Object} props - 组件属性
 * @param {Function} props.onImportComplete - 导入完成回调
 * @param {boolean} [props.isReimport=false] - 是否为重新导入模式
 * @returns {JSX.Element} 导入页面
 */
export default function ImportPage({ onImportComplete, isReimport = false }) {
  // 已选中的来源 ID 集合（工具 ID 或自定义路径 ID）
  const [selectedSources, setSelectedSources] = useState(new Set())
  // 工具列表（包含扫描结果）
  const [toolList, setToolList] = useState([])
  // 是否正在扫描工具目录
  const [isLoading, setIsLoading] = useState(true)
  // 是否正在执行导入操作
  const [isImporting, setIsImporting] = useState(false)
  // 自定义路径列表
  const [customPaths, setCustomPaths] = useState([])
  // 中央仓库路径
  const [repoPath, setRepoPath] = useState('~/Documents/SkillManager/')
  // 是否显示添加路径弹窗
  const [isModalOpen, setIsModalOpen] = useState(false)

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
   * 对自定义路径按规范化路径去重
   * @param {Array} paths - 原始路径列表
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

  // 初始化：扫描工具目录和加载配置
  useEffect(() => {
    const init = async () => {
      setIsLoading(true)
      try {
        // 1. 扫描预设工具
        const results = await dataStore.scanAllTools()
        setToolList(results)

        // 2. 加载配置（自定义路径和仓库位置）
        const config = await dataStore.getConfig()
        if (config.customPaths) {
          setCustomPaths(dedupeCustomPaths(config.customPaths))
        }
        if (config.repoPath) {
          setRepoPath(config.repoPath)
        }
      } catch (error) {
        console.error('Error initializing import page:', error)
        toast.error('初始化失败')
      } finally {
        setIsLoading(false)
      }
    }

    init()
  }, [])

  /**
   * 切换来源的选中状态
   * @param {string} id - 来源 ID
   */
  const toggleSource = (id) => {
    const newSelected = new Set(selectedSources)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedSources(newSelected)
  }

  /**
   * 获取技能数量显示文本
   * @param {Object} tool - 工具对象
   * @param {string} tool.error - 错误信息
   * @param {Array} tool.skills - 技能列表
   * @returns {JSX.Element|string} 显示文本
   */
  const getSkillCountText = (tool) => {
    if (isLoading) {
      return <span className="scanning-text">扫描中...</span>
    }

    if (tool.error === 'DIRECTORY_NOT_FOUND') {
      return <span className="error-text">目录不存在</span>
    }

    if (tool.error === 'PERMISSION_DENIED') {
      return <span className="error-text">无法访问</span>
    }

    if (tool.error) {
      return <span className="error-text">扫描失败</span>
    }

    return `${tool.skills.length} 个 skill`
  }

  /**
   * 删除自定义路径
   * @param {string} id - 自定义路径 ID
   * @param {Event} e - 点击事件
   */
  const deleteCustomPath = (id, e) => {
    e.stopPropagation()
    const newPaths = customPaths.filter((cp) => cp.id !== id)
    setCustomPaths(newPaths)

    // 从选中集合中移除
    const newSelected = new Set(selectedSources)
    newSelected.delete(id)
    setSelectedSources(newSelected)

    // 保存到配置
    saveCustomPaths(newPaths)

    toast.success('已删除自定义路径')
  }

  /**
   * 保存自定义路径到配置
   * @param {Array} paths - 自定义路径列表
   */
  const saveCustomPaths = async (paths) => {
    try {
      const config = await dataStore.getConfig()
      config.customPaths = paths
      await dataStore.saveConfig(config)
    } catch (error) {
      console.error('Error saving custom paths:', error)
    }
  }

  /**
   * 处理添加自定义路径
   * @param {Object} data - 路径数据
   * @param {string} data.path - 文件夹路径
   * @param {Object} data.skills - 扫描到的 skills 分布
   */
  const handleAddCustomPath = async (data) => {
    const normalizedPath = normalizePathForCompare(data.path)
    if (!normalizedPath) return

    const duplicate = customPaths.some((pathItem) =>
      normalizePathForCompare(pathItem.path) === normalizedPath
    )
    if (duplicate) {
      toast.warning('该路径已存在')
      setIsModalOpen(false)
      return
    }

    const newPath = {
      id: 'custom-' + Date.now(),
      path: normalizedPath,
      skills: data.skills,
    }

    const newPaths = dedupeCustomPaths([...customPaths, newPath])
    setCustomPaths(newPaths)
    await saveCustomPaths(newPaths)

    setIsModalOpen(false)
    toast.success('已添加自定义路径')
  }

  /**
   * 更改中央仓库位置
   */
  const handleChangeRepoPath = async () => {
    try {
      const result = await dataStore.selectAndSetRepoPath()
      if (result.canceled) {
        return // 用户取消选择
      }
      if (!result.success) {
        toast.error('更改位置失败')
        return
      }

      setRepoPath(result.path)
      toast.success('中央仓库位置已更改')
    } catch (error) {
      console.error('Error changing repo path:', error)
      toast.error('更改位置失败')
    }
  }

  /**
   * 执行导入操作
   */
  const handleImport = async () => {
    if (selectedSources.size === 0) return

    setIsImporting(true)
    try {
      // 分离预设工具和自定义路径
      const selectedToolIds = []
      const selectedCustomPathIds = []

      for (const id of selectedSources) {
        if (id.startsWith('custom-')) {
          selectedCustomPathIds.push(id)
        } else {
          selectedToolIds.push(id)
        }
      }

      // 调用统一的导入方法
      let result
      if (isReimport) {
        result = await dataStore.reimportSkills(selectedToolIds, selectedCustomPathIds)
      } else {
        result = await dataStore.importSkills(selectedToolIds, selectedCustomPathIds)
      }

      if (result.success) {
        toast.success(`已导入 ${result.copiedCount} 个 skill`)

        // Auto switch to manage page after a short delay
        setTimeout(() => {
          onImportComplete()
        }, 500)
      } else {
        const errorMsg = result.errors?.[0] || '导入失败'
        toast.error(`导入失败：${errorMsg}`)
      }
    } catch (error) {
      console.error('Import error:', error)
      toast.error(`导入失败：${error.message}`)
    } finally {
      setIsImporting(false)
    }
  }

  // 获取文件夹名称
  const getFolderName = (path) => {
    if (!path) return ''
    const parts = path.split('/').filter((p) => p)
    return parts[parts.length - 1] || '自定义路径'
  }

  // 计算自定义路径的总 skill 数
  const getCustomPathTotalSkills = (skills) => {
    if (!skills) return 0
    return Object.values(skills).reduce((sum, count) => sum + count, 0)
  }

  // 格式化自定义路径的 skills 显示（超长时截断）
  const formatCustomPathSkills = (skills) => {
    if (!skills || Object.keys(skills).length === 0) {
      return '未发现 skill'
    }
    const MAX_LENGTH = 50 // 最大显示长度
    let result = Object.entries(skills)
      .map(([tool, count]) => `${tool}: ${count} 个 skill`)
      .join(' · ')
    // 超长路径截断显示
    if (result.length > MAX_LENGTH) {
      result = result.slice(0, MAX_LENGTH) + '...'
    }
    return result
  }

  // 截断过长的路径显示
  const truncatePath = (path, maxLength = 35) => {
    if (!path || path.length <= maxLength) return path
    // 末尾斜杠会导致 split 后最后一项为空，先去掉
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
    const parts = trimmed.split('/')
    if (parts.length <= 2) return path
    // 保留开头和结尾，中间用 ... 代替
    return parts[0] + '/.../' + parts[parts.length - 1]
  }

  return (
    <PageShell
      title={isReimport ? '重新导入 Skills' : '导入 Skills'}
      subtitle={isReimport
        ? '重新导入会清空中央仓库并重新复制所选工具的 Skills'
        : 'Skills 会从选中工具导入，后续一键推送到这些工具'}
    >
        {/* Preset Tools Section */}
        <div className="section-title">
          选择导入来源
        </div>
        <div className="section-hint">
          勾选要导入的工具或自定义路径
        </div>

        <div className="preset-tools-grid">
          {toolList.map((tool) => {
            const isSelected = selectedSources.has(tool.id)
            return (
              <div
                key={tool.id}
                className={`tool-card ${isSelected ? 'selected' : ''} ${tool.error ? 'has-error' : ''}`}
                onClick={() => toggleSource(tool.id)}
              >
                <Checkbox checked={isSelected} />
                <div className={`tool-icon ${tool.iconClass}`}>{tool.icon}</div>
                <div className="tool-info">
                  <div className="tool-name">{tool.name}</div>
                  <div className="tool-skill-count">{getSkillCountText(tool)}</div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Custom Paths Section */}
        <div className="custom-section">
          <div className="section-title">自定义路径</div>
          <div className="section-hint">添加任意文件夹，自动扫描其中的 skills 目录</div>

          {customPaths.map((cp) => {
            const isSelected = selectedSources.has(cp.id)
            const totalSkills = getCustomPathTotalSkills(cp.skills)
            const folderName = getFolderName(cp.path)

            return (
              <div
                key={cp.id}
                className={`custom-path-card ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleSource(cp.id)}
              >
                <Checkbox checked={isSelected} />
                <div className="tool-icon custom">📁</div>
                <div className="custom-path-details">
                  <div className="custom-path-name">{folderName}</div>
                  <div className="custom-path-skills" title={formatCustomPathSkills(cp.skills)}>
                    {formatCustomPathSkills(cp.skills)}
                  </div>
                </div>
                <div className="tool-skill-count">{totalSkills} 个 skill</div>
                <button className="btn-delete" onClick={(e) => deleteCustomPath(cp.id, e)}>
                  删除
                </button>
              </div>
            )
          })}

          <button className="btn-add" onClick={() => setIsModalOpen(true)}>
            + 添加自定义路径
          </button>
        </div>

        {/* Central Repo Section */}
        <div className="repo-section">
          <div className="section-title">中央仓库</div>
          <div className="section-hint">
            所有 Skills 将合并存储在此位置，无特殊需求建议保持默认
          </div>
          <div className="repo-card">
            <div className="repo-info">
              <div className="repo-path" title={repoPath}>{truncatePath(repoPath, 40)}</div>
            </div>
            <button className="btn-change" onClick={handleChangeRepoPath}>
              更改位置
            </button>
          </div>
        </div>

        {/* Action Bar */}
        <div className="import-action">
          <span className="import-count">已选 {selectedSources.size} 个来源</span>
          <button
            className="action-btn"
            disabled={selectedSources.size === 0 || isImporting}
            onClick={handleImport}
          >
            {isImporting ? '导入中...' : isReimport ? '重新导入' : '一键导入'}
          </button>
        </div>


      <AddPathModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConfirm={handleAddCustomPath}
        existingPaths={customPaths}
      />
    </PageShell>
  )
}
