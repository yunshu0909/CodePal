/**
 * 添加自定义路径弹窗组件
 *
 * 负责：
 * - 选择文件夹
 * - 扫描并显示 skills 结果
 * - 确认添加自定义路径
 *
 * @module AddPathModal
 */

import React, { useRef, useState } from 'react'
import { dataStore } from '../store/data'
import { selectFolder } from '../store/fs'
import Modal from './Modal/Modal'
import Button from './Button/Button'

/**
 * 添加自定义路径弹窗
 * @param {Object} props - 组件属性
 * @param {boolean} props.isOpen - 是否显示弹窗
 * @param {Function} props.onClose - 关闭回调
 * @param {Function} props.onConfirm - 确认添加回调
 * @param {Array} props.existingPaths - 已存在的自定义路径列表（用于去重）
 * @returns {JSX.Element|null} 弹窗组件
 */
export default function AddPathModal({ isOpen, onClose, onConfirm, existingPaths }) {
  // 当前选中的文件夹路径
  const [selectedPath, setSelectedPath] = useState('')
  // 扫描结果
  const [scanResult, setScanResult] = useState(null)
  // 错误信息
  const [error, setError] = useState(null)
  // 是否正在确认添加（防止重复点击导致重复提交）
  const [isSubmitting, setIsSubmitting] = useState(false)
  // 使用 ref 做同步锁，避免 setState 异步导致的双击竞态
  const submittingRef = useRef(false)

  // 重置状态
  const resetState = () => {
    setSelectedPath('')
    setScanResult(null)
    setError(null)
    submittingRef.current = false
    setIsSubmitting(false)
  }

  // 处理关闭
  const handleClose = () => {
    resetState()
    onClose()
  }

  /**
   * 浏览文件夹
   */
  const handleBrowse = async () => {
    setError(null)
    setScanResult(null)

    try {
      // 1. 选择文件夹（只选择，不添加）
      const selectResult = await selectFolder()

      if (selectResult.canceled || !selectResult.success) {
        return // 用户取消选择或出错
      }

      const selectedFullPath = selectResult.path

      // 2. 检查路径是否已存在
      const pathExists = existingPaths.some(
        (p) => p.path === selectedFullPath || p.path.replace(/\/$/, '') === selectedFullPath.replace(/\/$/, '')
      )
      if (pathExists) {
        setError('该路径已存在')
        return
      }

      // 3. 扫描路径
      const scanResult = await dataStore.scanCustomPath(selectedFullPath)

      if (!scanResult.success) {
        setError('扫描失败：' + scanResult.error)
        return
      }

      // 4. 检查是否发现 skills
      const hasSkills = Object.keys(scanResult.skills).length > 0
      if (!hasSkills) {
        setSelectedPath(selectedFullPath)
        setScanResult({})
        return
      }

      // 成功扫描到 skills
      setSelectedPath(selectedFullPath)
      setScanResult(scanResult.skills)
    } catch (err) {
      setError('扫描失败：' + err.message)
    }
  }

  /**
   * 确认添加
   */
  const handleConfirm = async () => {
    if (!selectedPath || !scanResult || Object.keys(scanResult).length === 0 || submittingRef.current) {
      return
    }

    submittingRef.current = true
    setIsSubmitting(true)
    try {
      // 等待父组件处理完成再解锁，避免双击触发并发添加
      await Promise.resolve(onConfirm({
        path: selectedPath,
        skills: scanResult,
      }))
      resetState()
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  // 获取文件夹名称
  const getFolderName = (path) => {
    if (!path) return ''
    const parts = path.split('/').filter((p) => p)
    return parts[parts.length - 1] || '自定义路径'
  }

  // 计算总 skill 数
  const getTotalSkills = () => {
    if (!scanResult) return 0
    return Object.values(scanResult).reduce((sum, count) => sum + count, 0)
  }

  // 格式化扫描结果显示
  const formatScanDetails = () => {
    if (!scanResult) return ''
    return Object.entries(scanResult)
      .map(([tool, count]) => `${tool}: ${count} 个 skill`)
      .join(' · ')
  }

  // 是否可以确认添加
  const canConfirm =
    selectedPath && scanResult && Object.keys(scanResult).length > 0 && !error && !isSubmitting

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title="添加自定义路径"
      footer={
        <>
          <Button variant="secondary" disabled={isSubmitting} onClick={handleClose}>取消</Button>
          <Button variant="primary" loading={isSubmitting} disabled={!canConfirm} onClick={handleConfirm}>确认添加</Button>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label">选择文件夹</label>
        <div className="path-selector">
          <div className={`path-display ${!selectedPath ? 'empty' : ''}`}>
            {selectedPath || '点击浏览选择文件夹...'}
          </div>
          <button className="btn-browse" onClick={handleBrowse} disabled={isSubmitting}>
            浏览...
          </button>
        </div>
      </div>

      {error && (
        <div className="scan-result error">
          <div className="scan-result-title">❌ {error}</div>
        </div>
      )}

      {scanResult && !error && (
        <div className={`scan-result ${Object.keys(scanResult).length === 0 ? 'error' : ''}`}>
          {Object.keys(scanResult).length > 0 ? (
            <>
              <div className="scan-result-title">
                ✅ 发现 {getTotalSkills()} 个 skill
              </div>
              {Object.entries(scanResult).map(([tool, count]) => (
                <div key={tool} className="scan-item">
                  • {tool}: {count} 个 skill
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="scan-result-title">❌ 未找到 skills 目录</div>
              <div className="scan-item">
                该目录下未发现 .claude/skills/、.codex/skills/、.factory/skills/ 等
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
