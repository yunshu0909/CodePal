/**
 * 文档查阅页面
 *
 * 负责：
 * - 左栏：文件夹管理（添加/移除）+ 文件树浏览 + 文件名搜索
 * - 右栏：MarkdownRenderer 渲染选中的 .md 文件内容
 *
 * @module pages/DocBrowserPage
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import PageShell from '../components/PageShell'
import MarkdownRenderer from '../components/MarkdownRenderer/MarkdownRenderer'
import { toast } from '../components/Toast'
import useResizableSidebar from '../hooks/useResizableSidebar'
import '../styles/doc-browser.css'

/**
 * 格式化文件大小
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 从扁平文件列表构建 N 层目录树
 * @param {Array} files - 扁平文件列表（含 relativePath）
 * @returns {{files: Array, dirs: Map<string, {files, dirs}>}}
 */
function buildFileTree(files) {
  const root = { files: [], dirs: new Map() }

  for (const file of files) {
    const parts = file.relativePath.split('/')
    if (parts.length === 1) {
      // 根目录文件
      root.files.push(file)
    } else {
      // 按路径逐级放入子目录
      let current = root
      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i]
        if (!current.dirs.has(dirName)) {
          current.dirs.set(dirName, { files: [], dirs: new Map() })
        }
        current = current.dirs.get(dirName)
      }
      current.files.push(file)
    }
  }

  return root
}

/**
 * 统计目录树中的总文件数（含所有子目录）
 * @param {{files: Array, dirs: Map}} node
 * @returns {number}
 */
function countTreeFiles(node) {
  let count = node.files.length
  for (const child of node.dirs.values()) {
    count += countTreeFiles(child)
  }
  return count
}

/**
 * 递归渲染目录树节点
 * 根级文件直接显示，子目录可折叠（默认折叠）
 */
function FileTreeNode({ name, node, depth, selectedFile, onFileClick }) {
  const [expanded, setExpanded] = useState(false)
  const totalFiles = useMemo(() => countTreeFiles(node), [node])
  const sortedDirs = useMemo(
    () => [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    [node.dirs]
  )
  const sortedFiles = useMemo(
    () => [...node.files].sort((a, b) => a.name.localeCompare(b.name)),
    [node.files]
  )

  return (
    <div className="db-tree-node">
      {/* 目录标题行（根级不显示） */}
      {name && (
        <button
          className="db-dir-toggle"
          onClick={() => setExpanded(prev => !prev)}
        >
          <span className="db-dir-arrow">{expanded ? '▼' : '▶'}</span>
          <span className="db-dir-icon-folder">{expanded ? '📂' : '📁'}</span>
          <span className="db-dir-name">{name}</span>
          <span className="db-dir-count">{totalFiles}</span>
        </button>
      )}

      {/* 展开后显示子目录和文件 */}
      {(expanded || !name) && (
        <div className={name ? 'db-tree-children' : ''}>
          {/* 先渲染子目录 */}
          {sortedDirs.map(([dirName, dirNode]) => (
            <FileTreeNode
              key={dirName}
              name={dirName}
              node={dirNode}
              depth={(depth || 0) + 1}
              selectedFile={selectedFile}
              onFileClick={onFileClick}
            />
          ))}
          {/* 再渲染文件 */}
          {sortedFiles.map(file => (
            <button
              key={file.fullPath}
              className={`db-file-item ${selectedFile === file.fullPath ? 'active' : ''}`}
              onClick={() => onFileClick(file.fullPath)}
            >
              <span className="db-file-icon">📄</span>
              <span className="db-file-name">{file.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DocBrowserPage() {
  // 文件夹列表
  const [folders, setFolders] = useState([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  // 当前展开的文件夹
  const [expandedFolder, setExpandedFolder] = useState(null)
  // 展开文件夹的文件列表
  const [files, setFiles] = useState([])
  const [filesLoading, setFilesLoading] = useState(false)
  // 当前选中的文件
  const [selectedFile, setSelectedFile] = useState(null)
  // 文件内容
  const [fileContent, setFileContent] = useState('')
  const [fileSize, setFileSize] = useState(0)
  const [contentLoading, setContentLoading] = useState(false)
  const [contentError, setContentError] = useState(null)
  // 搜索
  const [searchQuery, setSearchQuery] = useState('')
  // 所有文件夹的文件缓存（搜索用）
  const [allFilesCache, setAllFilesCache] = useState({})
  // 竞态防护
  const loadFileSeqRef = useRef(0)
  const loadFolderSeqRef = useRef(0)

  const isSearchMode = searchQuery.trim().length > 0
  // 可拖拽侧边栏
  const { sidebarWidth, resizerProps } = useResizableSidebar(280, 200, 500)

  const showToast = useCallback((message, type = 'info') => {
    toast.show(message, type)
  }, [])

  // 加载文件夹列表
  useEffect(() => {
    loadFolders()
  }, [])

  const loadFolders = async () => {
    setFoldersLoading(true)
    try {
      const result = await window.electronAPI.docListFolders()
      if (result.success) {
        setFolders(result.data)
      }
    } catch (err) {
      console.error('Failed to load folders:', err)
    } finally {
      setFoldersLoading(false)
    }
  }

  // 添加文件夹
  const handleAddFolder = useCallback(async () => {
    const selectResult = await window.electronAPI.docSelectFolder()
    if (!selectResult.success || !selectResult.data) return

    const addResult = await window.electronAPI.docAddFolder(selectResult.data)
    if (!addResult.success) {
      showToast(addResult.error, addResult.errorCode === 'DUPLICATE' ? 'warning' : 'error')
      return
    }

    const { name, fileCount, files: scannedFiles } = addResult.data

    if (fileCount === 0) {
      showToast('文件夹下没有找到 .md 文件', 'warning')
    } else {
      showToast(`已添加文件夹「${name}」，共发现 ${fileCount} 个 .md 文件`, 'success')
    }

    // 刷新列表并自动展开新文件夹
    await loadFolders()
    setExpandedFolder(selectResult.data)
    setFiles(scannedFiles || [])
    // 缓存文件列表供搜索用
    setAllFilesCache(prev => ({ ...prev, [selectResult.data]: scannedFiles || [] }))
  }, [showToast])

  // 移除文件夹
  const handleRemoveFolder = useCallback(async (folderPath, e) => {
    e.stopPropagation()
    const folderName = folders.find(f => f.path === folderPath)?.name || ''

    try {
      const result = await window.electronAPI.docRemoveFolder(folderPath)
      if (!result.success) {
        showToast(result.error || '删除文件夹失败', 'error')
        return
      }
    } catch (err) {
      showToast(`删除失败: ${err.message}`, 'error')
      return
    }

    // 清理状态
    if (expandedFolder === folderPath) {
      setExpandedFolder(null)
      setFiles([])
    }
    if (selectedFile?.startsWith(folderPath)) {
      setSelectedFile(null)
      setFileContent('')
      setContentError(null)
    }
    setAllFilesCache(prev => {
      const next = { ...prev }
      delete next[folderPath]
      return next
    })
    await loadFolders()
    showToast(`文件夹「${folderName}」已移除`, 'success')
  }, [folders, expandedFolder, selectedFile, showToast])

  // 展开/折叠文件夹
  const handleFolderClick = useCallback(async (folder) => {
    if (!folder.valid) return

    if (expandedFolder === folder.path) {
      setExpandedFolder(null)
      setFiles([])
      return
    }

    setExpandedFolder(folder.path)
    setFilesLoading(true)
    const seq = ++loadFolderSeqRef.current

    try {
      const result = await window.electronAPI.docListFiles(folder.path)
      // 防止旧请求覆盖新结果
      if (seq !== loadFolderSeqRef.current) return
      if (result.success) {
        setFiles(result.data)
        setAllFilesCache(prev => ({ ...prev, [folder.path]: result.data }))
      }
    } catch (err) {
      if (seq !== loadFolderSeqRef.current) return
      console.error('Failed to list files:', err)
    } finally {
      if (seq === loadFolderSeqRef.current) {
        setFilesLoading(false)
      }
    }
  }, [expandedFolder])

  // 点击文件
  const handleFileClick = useCallback(async (filePath) => {
    if (selectedFile === filePath) return

    const seq = ++loadFileSeqRef.current
    setSelectedFile(filePath)
    setContentLoading(true)
    setContentError(null)

    try {
      const result = await window.electronAPI.docReadFile(filePath)
      if (seq !== loadFileSeqRef.current) return
      if (result.success) {
        setFileContent(result.data.content)
        setFileSize(result.data.size)
      } else {
        setContentError(result.error)
      }
    } catch (err) {
      if (seq !== loadFileSeqRef.current) return
      setContentError(err.message)
    } finally {
      if (seq === loadFileSeqRef.current) {
        setContentLoading(false)
      }
    }
  }, [selectedFile])

  // 重试读取
  const handleRetry = useCallback(async () => {
    if (!selectedFile) return
    const seq = ++loadFileSeqRef.current
    setContentLoading(true)
    setContentError(null)

    try {
      const result = await window.electronAPI.docReadFile(selectedFile)
      if (seq !== loadFileSeqRef.current) return
      if (result.success) {
        setFileContent(result.data.content)
        setFileSize(result.data.size)
      } else {
        setContentError(result.error)
        showToast('文件读取失败，文件可能已被删除或移动', 'error')
      }
    } catch (err) {
      if (seq !== loadFileSeqRef.current) return
      setContentError(err.message)
      showToast('文件读取失败', 'error')
    } finally {
      if (seq === loadFileSeqRef.current) {
        setContentLoading(false)
      }
    }
  }, [selectedFile, showToast])

  // 搜索：在所有已缓存的文件中按文件名过滤
  const searchResults = useMemo(() => {
    if (!isSearchMode) return []
    const keyword = searchQuery.trim().toLowerCase()
    const results = []
    for (const [folderPath, folderFiles] of Object.entries(allFilesCache)) {
      const folderName = folders.find(f => f.path === folderPath)?.name || ''
      for (const file of folderFiles) {
        if (file.name.toLowerCase().includes(keyword)) {
          results.push({ ...file, folderName, folderPath })
        }
      }
    }
    return results
  }, [searchQuery, allFilesCache, folders, isSearchMode])

  // 获取选中文件的相对路径（用于信息条）
  const selectedRelativePath = useMemo(() => {
    if (!selectedFile || !expandedFolder) return selectedFile || ''
    // 从搜索结果或文件列表中找到
    for (const f of files) {
      if (f.fullPath === selectedFile) return f.relativePath
    }
    for (const folderFiles of Object.values(allFilesCache)) {
      for (const f of folderFiles) {
        if (f.fullPath === selectedFile) return f.relativePath
      }
    }
    return selectedFile
  }, [selectedFile, files, allFilesCache, expandedFolder])

  // 文件分组
  const fileTree = useMemo(() => buildFileTree(files), [files])

  return (
    <PageShell
      title="文档查阅"
      subtitle="浏览项目中的 Markdown 文档"
      divider
      className="page-shell--no-padding"
    >
      <div className="db-layout">
        {/* 左栏 */}
        <div className="db-sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
          <div className="db-topbar">
            <input
              className="db-search-input"
              type="text"
              placeholder="搜索文件名..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="db-search-clear"
                onClick={() => setSearchQuery('')}
              >
                ✕
              </button>
            )}
            <button className="db-add-btn" onClick={handleAddFolder}>
              + 添加
            </button>
          </div>

          {/* 搜索模式 */}
          {isSearchMode && (
            <div className="db-list-area">
              {searchResults.length === 0 ? (
                <div className="db-search-empty">
                  <div className="db-search-empty-icon">🔍</div>
                  <div className="db-search-empty-text">无匹配文件</div>
                  <div className="db-search-empty-hint">试试换个关键词</div>
                </div>
              ) : (
                <>
                  <div className="db-search-count">{searchResults.length} 个匹配文件</div>
                  {searchResults.map((file) => (
                    <button
                      key={file.fullPath}
                      className={`db-search-item ${selectedFile === file.fullPath ? 'active' : ''}`}
                      onClick={() => handleFileClick(file.fullPath)}
                    >
                      <span className="db-file-icon">📄</span>
                      <div className="db-search-item-info">
                        <div className="db-file-name">{file.name}</div>
                        <div className="db-search-item-path">{file.dir ? `${file.folderName} / ${file.dir}` : file.folderName}</div>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}

          {/* 文件夹树模式 */}
          {!isSearchMode && (
            <div className="db-list-area">
              {foldersLoading ? (
                <div className="db-loading-state">
                  <div className="db-spinner" />
                  <div>加载中...</div>
                </div>
              ) : folders.length === 0 ? (
                <div className="db-empty-sidebar">
                  <div className="db-empty-sidebar-icon">📂</div>
                  <div className="db-empty-sidebar-text">还没有添加文件夹</div>
                  <div className="db-empty-sidebar-hint">添加文件夹后即可浏览其中的 Markdown 文档</div>
                  <button className="db-empty-sidebar-btn" onClick={handleAddFolder}>+ 添加文件夹</button>
                </div>
              ) : (
                folders.map(folder => (
                  <div key={folder.path} className="db-folder-group">
                    <button
                      className={`db-folder-item ${expandedFolder === folder.path ? 'active' : ''} ${!folder.valid ? 'invalid' : ''}`}
                      onClick={() => handleFolderClick(folder)}
                    >
                      <span className="db-folder-icon">
                        {!folder.valid ? '⚠' : expandedFolder === folder.path ? '▼' : '▶'}
                      </span>
                      <span className="db-folder-name">{folder.name}</span>
                      <span className={`db-folder-count ${!folder.valid ? 'invalid' : ''}`}>
                        {folder.valid ? folder.fileCount : '!'}
                      </span>
                      <button
                        className="db-folder-remove"
                        onClick={(e) => handleRemoveFolder(folder.path, e)}
                      >
                        ×
                      </button>
                    </button>

                    {expandedFolder === folder.path && folder.valid && (
                      <div className="db-file-list">
                        {filesLoading ? (
                          <div className="db-files-loading">扫描中...</div>
                        ) : files.length === 0 ? (
                          <div className="db-files-empty">
                            <div className="db-files-empty-icon">📭</div>
                            <div>此文件夹下没有 .md 文件</div>
                          </div>
                        ) : (
                          <FileTreeNode
                            node={fileTree}
                            depth={0}
                            selectedFile={selectedFile}
                            onFileClick={handleFileClick}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* 拖拽分隔线 */}
        <div {...resizerProps} />

        {/* 右栏 */}
        <div className="db-content">
          {!selectedFile && (
            <div className="db-empty-content">
              <div className="db-empty-content-icon">📖</div>
              <div className="db-empty-content-text">选择一个文档查看内容</div>
            </div>
          )}

          {selectedFile && (
            <div className="db-content-header">
              <span className="db-content-header-path">{selectedRelativePath}</span>
              <span className="db-content-header-size">
                {contentLoading ? '加载中...' : formatSize(fileSize)}
              </span>
            </div>
          )}

          {selectedFile && contentLoading && (
            <div className="db-skeleton-area">
              {[1, 2, 3].map(i => (
                <div key={i} className="db-skeleton-block">
                  <div className="db-skeleton db-skeleton-short" />
                  <div className="db-skeleton-gap" />
                  <div className="db-skeleton db-skeleton-full" />
                  <div className="db-skeleton db-skeleton-med" />
                </div>
              ))}
            </div>
          )}

          {selectedFile && !contentLoading && contentError && (
            <div className="db-empty-content">
              <div style={{ fontSize: '32px' }}>⚠️</div>
              <div className="db-empty-content-text" style={{ color: 'var(--color-danger)' }}>无法读取文件</div>
              <div className="db-empty-content-hint">文件可能已被删除或移动</div>
              <button className="db-retry-btn" onClick={handleRetry}>重试</button>
            </div>
          )}

          {selectedFile && !contentLoading && !contentError && (
            <div className="db-md-area">
              <MarkdownRenderer content={fileContent} />
            </div>
          )}
        </div>
      </div>

    </PageShell>
  )
}
