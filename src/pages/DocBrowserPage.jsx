/**
 * 文档查阅页（Native+）
 *
 * 负责：
 * - 新样式外壳，页名「文档查阅」在工具栏；下面是双栏：左栏文件夹与目录树 / 搜索结果，右栏 Markdown 正文
 * - 左栏：栏头搜索框，栏体文件夹根行 + 展开那一个的目录树（或搜索结果），栏底「＋ 添加文件夹」；两栏之间可拖动调宽（默认 220，200–500）
 * - 右栏：栏头文件名 + 所在文件夹路径与大小，正文 MarkdownRenderer（np-read np-doc），开头元数据与 HTML 注释不显示
 * - 规则见 docs/design-operating-system.md 3.8「双栏」「目录树」「长文阅读」、3.12「状态呈现」
 * - 切回（#100）：先显示上次的文件夹、展开的目录树、搜索词、选中的文档和正文（本次运行内存里，照 #56 Skills 先例），
 *   后台静默重读文件夹列表、展开那个的文件、选中文档的正文，不出转圈和正文骨架；重读失败留着上次的，那一栏顶上提示没更新。
 *   滚动位置、添加中不保留
 *
 * 设计事实源：specs/docs-browser-redesign/文档查阅-定稿/
 *
 * @module pages/DocBrowserPage
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import StateView from '../components/StateView/StateView'
import MarkdownRenderer from '../components/MarkdownRenderer/MarkdownRenderer'
import { toast } from '../components/Toast'
import StaleNotice from '../components/StaleNotice'
import useResizableSidebar from '../hooks/useResizableSidebar'
import { pageMemory, useRemember } from '../store/pageMemory'
import './docs/docs.css'

// 空态图标：文件夹（viewBox 0 0 16 16，画在整块状态的灰色方块里）
const FOLDER_EMPTY_ICON = <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" />

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
 * 路径显示：超过三级时中间省略，保留开头（文件夹名）和最后一级（总纲 3.5「路径」）
 * @param {string[]} segs - 路径各级
 * @returns {{short: string, full: string}}
 */
function shortPath(segs) {
  const full = segs.join(' / ')
  const short = segs.length > 3 ? `${segs[0]} / … / ${segs[segs.length - 1]}` : full
  return { short, full }
}

/**
 * 交给渲染器之前去掉只给作者 / AI 看的内容：开头两行横线包着的元数据、<!-- --> 注释
 * 只影响页面显示，不改文件
 * @param {string} content - 文件原文
 * @returns {string}
 */
function stripForDisplay(content) {
  return content
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
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
    let current = root
    // 按路径逐级放入子目录，最后一段是文件名
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i]
      if (!current.dirs.has(dirName)) {
        current.dirs.set(dirName, { files: [], dirs: new Map() })
      }
      current = current.dirs.get(dirName)
    }
    current.files.push(file)
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
 * 让整行可点的 div 也能用键盘触发（回车 / 空格）
 * @param {() => void} fn - 点击时要做的事
 * @returns {(e: KeyboardEvent) => void}
 */
function onActivateKey(fn) {
  return (e) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fn()
    }
  }
}

/** 展开箭头：收起朝右、展开朝下（直接换图形，不做旋转动画） */
function Chevron({ open }) {
  return (
    <svg className="chev" viewBox="0 0 10 10" aria-hidden="true">
      <path d={open ? 'M2.5 4 5 6.5 7.5 4' : 'M4 2.5 6.5 5 4 7.5'} />
    </svg>
  )
}

/** 树行图标：14px 灰色线形（文件夹 / 文档） */
function TreeIcon({ kind }) {
  return (
    <svg className="np-ti" viewBox="0 0 14 14" aria-hidden="true">
      <path d={kind === 'file' ? 'M3 1.5h5.2L11 4.3v8.2H3zM8 1.5v3h3' : 'M1.5 3.5h4l1.2 1.3h5.8v6.7h-11z'} />
    </svg>
  )
}

/**
 * 目录树的一层：先子目录（右端文件数），再文件；各自按名称排序
 * 子目录的展开状态由页面统一保存（expandedDirs），搜索前后不丢
 * @param {object} props
 * @param {{files: Array, dirs: Map}} props.node - 这一层的节点
 * @param {string} props.path - 这一层相对文件夹根的路径（根下为 ''）
 * @param {number} props.level - 缩进级别（根为 0，直接子项为 1）
 * @param {Set<string>} props.expandedDirs - 展开着的子目录路径
 * @param {(dirPath: string) => void} props.onToggleDir - 展开 / 收起子目录
 * @param {string|null} props.selectedFile - 当前选中文件的完整路径
 * @param {(fullPath: string) => void} props.onFileClick - 点文件
 */
function FileTreeLevel({ node, path, level, expandedDirs, onToggleDir, selectedFile, onFileClick }) {
  const sortedDirs = useMemo(
    () => [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    [node.dirs]
  )
  const sortedFiles = useMemo(
    () => [...node.files].sort((a, b) => a.name.localeCompare(b.name)),
    [node.files]
  )

  return (
    <>
      {sortedDirs.map(([dirName, dirNode]) => {
        const dirPath = path ? `${path}/${dirName}` : dirName
        const open = expandedDirs.has(dirPath)
        return (
          <div key={dirPath} className="np-tree-group">
            <div
              className="np-tr"
              style={{ '--lv': level }}
              role="button"
              tabIndex={0}
              aria-expanded={open}
              title={dirName}
              onClick={() => onToggleDir(dirPath)}
              onKeyDown={onActivateKey(() => onToggleDir(dirPath))}
            >
              <Chevron open={open} />
              <TreeIcon kind="dir" />
              <span className="nm">{dirName}</span>
              <span className="cnt">{countTreeFiles(dirNode)}</span>
            </div>
            {open && (
              <FileTreeLevel
                node={dirNode}
                path={dirPath}
                level={level + 1}
                expandedDirs={expandedDirs}
                onToggleDir={onToggleDir}
                selectedFile={selectedFile}
                onFileClick={onFileClick}
              />
            )}
          </div>
        )
      })}
      {sortedFiles.map(file => (
        <div
          key={file.fullPath}
          className={`np-tr${selectedFile === file.fullPath ? ' on' : ''}`}
          style={{ '--lv': level }}
          role="button"
          tabIndex={0}
          title={file.name}
          onClick={() => onFileClick(file.fullPath)}
          onKeyDown={onActivateKey(() => onFileClick(file.fullPath))}
        >
          <span className="sp" />
          <TreeIcon kind="file" />
          <span className="nm">{file.name}</span>
        </div>
      ))}
    </>
  )
}

export default function DocBrowserPage() {
  // 切回时的上次（#100）；第一次进是 undefined，下面全按原来的初始值
  const memory = pageMemory('doc-browser')
  const [last] = useState(() => memory.value)
  // 文件夹列表
  const [folders, setFolders] = useState(() => last?.folders ?? [])
  const [foldersLoading, setFoldersLoading] = useState(() => !last)
  // 当前展开的文件夹（同一时间只展开一个）和它里面展开着的子目录
  const [expandedFolder, setExpandedFolder] = useState(() => last?.expandedFolder ?? null)
  const [expandedDirs, setExpandedDirs] = useState(() => last?.expandedDirs ?? new Set())
  // 展开文件夹的文件列表（上次切走时还在扫描的，回来接着显示扫描中，等这次重读）
  const [files, setFiles] = useState(() => last?.files ?? [])
  const [filesLoading, setFilesLoading] = useState(() => Boolean(last?.expandedFolder) && !last?.files)
  // 当前选中的文件与它的内容（上次切走时正文还在读的，回来接着出正文骨架，等这次重读）
  const [selectedFile, setSelectedFile] = useState(() => last?.selectedFile ?? null)
  const [fileContent, setFileContent] = useState(() => last?.fileContent ?? '')
  const [fileSize, setFileSize] = useState(() => last?.fileSize ?? 0)
  const [contentLoading, setContentLoading] = useState(() => Boolean(last?.selectedFile) && last?.fileContent == null)
  const [contentError, setContentError] = useState(() => last?.contentError ?? null)
  // 搜索
  const [searchQuery, setSearchQuery] = useState(() => last?.searchQuery ?? '')
  // 展开过的文件夹的文件缓存（搜索只搜这些）
  const [allFilesCache, setAllFilesCache] = useState(() => last?.allFilesCache ?? {})
  // 切回后这次重读失败：左栏（文件夹 / 文件列表）、右栏（正文）各自留着上次的并提示
  const [listStale, setListStale] = useState(false)
  const [contentStale, setContentStale] = useState(false)
  // 添加文件夹扫描期间，栏底按钮禁用
  const [adding, setAdding] = useState(false)
  // 竞态防护：快速连点时旧请求不覆盖新结果
  const loadFileSeqRef = useRef(0)
  const loadFolderSeqRef = useRef(0)

  const isSearchMode = searchQuery.trim().length > 0
  // 两栏之间可拖动调宽：默认 220，范围 200–500
  const { sidebarWidth, resizerProps } = useResizableSidebar(220, 200, 500)

  /** @param {{quiet?: boolean}} [options] - quiet：切回时的静默重读，不转圈，失败标左栏没更新 */
  const loadFolders = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setFoldersLoading(true)
    try {
      const result = await window.electronAPI.docListFolders()
      if (result.success) {
        setFolders(result.data)
        if (quiet) setListStale(false)
      } else if (quiet) setListStale(true)
    } catch (err) {
      console.error('Failed to load folders:', err)
      if (quiet) setListStale(true)
    } finally {
      setFoldersLoading(false)
    }
  }, [])

  /** 切回时静默重读展开着的那个文件夹的文件（不出扫描中，失败标左栏没更新） */
  const relistFolder = useCallback(async (folderPath) => {
    const seq = ++loadFolderSeqRef.current
    try {
      const result = await window.electronAPI.docListFiles(folderPath)
      if (seq !== loadFolderSeqRef.current) return
      if (!result.success) throw new Error(result.error)
      setFiles(result.data)
      setAllFilesCache(prev => ({ ...prev, [folderPath]: result.data }))
    } catch {
      if (seq === loadFolderSeqRef.current) setListStale(true)
    } finally {
      if (seq === loadFolderSeqRef.current) setFilesLoading(false)
    }
  }, [])

  // 添加文件夹：选目录 → 登记（扫描期间按钮禁用）→ 刷新列表并自动展开它
  const handleAddFolder = useCallback(async () => {
    const selectResult = await window.electronAPI.docSelectFolder()
    if (!selectResult.success || !selectResult.data) return

    setAdding(true)
    let addResult
    try {
      addResult = await window.electronAPI.docAddFolder(selectResult.data)
    } finally {
      setAdding(false)
    }
    if (!addResult.success) {
      if (addResult.errorCode === 'DUPLICATE') toast.warning(addResult.error)
      else toast.error(addResult.error)
      return
    }

    const { name, fileCount, files: scannedFiles } = addResult.data

    if (fileCount === 0) {
      toast.warning('文件夹下没有找到 .md 文件')
    } else {
      toast.success(`已添加文件夹「${name}」，共发现 ${fileCount} 个 .md 文件`)
    }

    await loadFolders()
    setExpandedFolder(selectResult.data)
    setExpandedDirs(new Set())
    setFiles(scannedFiles || [])
    setAllFilesCache(prev => ({ ...prev, [selectResult.data]: scannedFiles || [] }))
  }, [loadFolders])

  // 移除文件夹：只从列表里拿掉，不动磁盘上的文件
  const handleRemoveFolder = useCallback(async (folderPath, e) => {
    e.stopPropagation()
    const folderName = folders.find(f => f.path === folderPath)?.name || ''

    try {
      const result = await window.electronAPI.docRemoveFolder(folderPath)
      if (!result.success) {
        toast.error(result.error || '删除文件夹失败')
        return
      }
    } catch (err) {
      toast.error(`删除失败: ${err.message}`)
      return
    }

    if (expandedFolder === folderPath) {
      setExpandedFolder(null)
      setExpandedDirs(new Set())
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
    toast.success(`文件夹「${folderName}」已移除`)
  }, [folders, expandedFolder, selectedFile, loadFolders])

  // 展开 / 收起文件夹；路径失效的点了不展开
  const handleFolderClick = useCallback(async (folder) => {
    if (!folder.valid) return

    if (expandedFolder === folder.path) {
      setExpandedFolder(null)
      setExpandedDirs(new Set())
      setFiles([])
      return
    }

    setExpandedFolder(folder.path)
    setExpandedDirs(new Set())
    setFilesLoading(true)
    const seq = ++loadFolderSeqRef.current

    try {
      const result = await window.electronAPI.docListFiles(folder.path)
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

  const handleToggleDir = useCallback((dirPath) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }, [])

  /**
   * 读取文件内容进右栏
   * @param {string} filePath - 完整路径
   * @param {boolean} isRetry - 重试时失败要弹提示
   * @param {boolean} [quiet=false] - 切回时的静默重读：不出骨架，失败留着上次的正文、标右栏没更新
   */
  const readFile = useCallback(async (filePath, isRetry, quiet = false) => {
    const seq = ++loadFileSeqRef.current
    if (!quiet) {
      setContentLoading(true)
      setContentError(null)
      setContentStale(false)
    }

    try {
      const result = await window.electronAPI.docReadFile(filePath)
      if (seq !== loadFileSeqRef.current) return
      if (result.success) {
        setFileContent(result.data.content)
        setFileSize(result.data.size)
        setContentError(null)
        setContentStale(false)
      } else if (quiet) {
        setContentStale(true)
      } else {
        setContentError(result.error)
        if (isRetry) toast.error('文件读取失败，文件可能已被删除或移动')
      }
    } catch (err) {
      if (seq !== loadFileSeqRef.current) return
      if (quiet) {
        setContentStale(true)
        return
      }
      setContentError(err.message)
      if (isRetry) toast.error('文件读取失败')
    } finally {
      if (seq === loadFileSeqRef.current) {
        setContentLoading(false)
      }
    }
  }, [])

  const handleFileClick = useCallback((filePath) => {
    if (selectedFile === filePath) return
    setSelectedFile(filePath)
    readFile(filePath, false)
  }, [selectedFile, readFile])

  const handleRetry = useCallback(() => {
    if (selectedFile) readFile(selectedFile, true)
  }, [selectedFile, readFile])

  // 进页读文件夹列表；切回时（有上次的）三样都静默重读
  useEffect(() => {
    loadFolders({ quiet: Boolean(last) })
    if (!last) return
    if (last.expandedFolder) relistFolder(last.expandedFolder)
    if (last.selectedFile) readFile(last.selectedFile, false, true)
  }, [last, loadFolders, relistFolder, readFile])

  // 左栏「重试」：按现在展开着的那个重读
  const retryList = useCallback(() => {
    loadFolders({ quiet: true })
    if (expandedFolder) relistFolder(expandedFolder)
  }, [loadFolders, relistFolder, expandedFolder])

  // 记下这次看到的（文件夹列表第一次读完之后才记；还在扫描 / 读正文时不记那份半截的）
  useRemember(memory, useMemo(() => (foldersLoading ? null : {
    folders, expandedFolder, expandedDirs, searchQuery, allFilesCache, selectedFile, fileSize, contentError,
    files: filesLoading ? null : files,
    fileContent: contentLoading ? null : fileContent,
  }), [foldersLoading, folders, expandedFolder, expandedDirs, searchQuery, allFilesCache, selectedFile, fileSize, contentError, filesLoading, files, contentLoading, fileContent]))

  // 搜索：在展开过的文件夹里按文件名过滤，不区分大小写
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

  // 选中文件所在的文件夹路径各级（右栏元信息）：文件夹名 + 子目录
  const selectedWhere = useMemo(() => {
    if (!selectedFile) return null
    for (const [folderPath, folderFiles] of Object.entries({ ...allFilesCache, [expandedFolder || '']: files })) {
      const hit = folderFiles.find(f => f.fullPath === selectedFile)
      if (hit) {
        const folderName = folders.find(f => f.path === folderPath)?.name || folderPath
        return shortPath([folderName, ...(hit.dir ? hit.dir.split('/') : [])])
      }
    }
    return { short: selectedFile, full: selectedFile }
  }, [selectedFile, files, allFilesCache, expandedFolder, folders])

  const selectedName = selectedFile ? selectedFile.split(/[\\/]/).pop() : ''
  const fileTree = useMemo(() => buildFileTree(files), [files])
  const displayContent = useMemo(() => stripForDisplay(fileContent), [fileContent])
  // 还没有文件夹时整块空态里已经有「添加文件夹」，栏底那行不重复
  const showFooter = foldersLoading || folders.length > 0

  /** 左栏：搜索结果 */
  const renderSearch = () => {
    if (searchResults.length === 0) {
      return (
        <div className="np-hstack db-search-empty">
          <span className="np-empty">无匹配文件</span>
          <Button variant="ghost" className="np-btn-text" onClick={() => setSearchQuery('')}>清除搜索</Button>
        </div>
      )
    }
    return (
      <>
        <div className="np-lg"><span><span className="num">{searchResults.length}</span> 个匹配文件</span></div>
        {searchResults.map(file => {
          const where = shortPath([file.folderName, ...(file.dir ? file.dir.split('/') : [])])
          return (
            <div
              key={file.fullPath}
              className={`np-li${selectedFile === file.fullPath ? ' on' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => handleFileClick(file.fullPath)}
              onKeyDown={onActivateKey(() => handleFileClick(file.fullPath))}
            >
              <b title={file.name}>{file.name}</b>
              <span className="d" title={where.full}>{where.short}</span>
            </div>
          )
        })}
      </>
    )
  }

  /** 左栏：文件夹根行 + 展开的那一个的目录树 */
  const renderFolders = () => folders.map(folder => {
    const open = expandedFolder === folder.path && folder.valid
    return (
      <div key={folder.path} className="np-tree-group">
        <div
          className="np-tr np-tr--root"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          title={folder.path}
          onClick={() => handleFolderClick(folder)}
          onKeyDown={onActivateKey(() => handleFolderClick(folder))}
        >
          {folder.valid ? <Chevron open={open} /> : <span className="sp" />}
          <TreeIcon kind="dir" />
          <span className="nm">{folder.name}</span>
          {folder.valid
            ? <span className="cnt">{folder.fileCount}</span>
            : <span className="np-tag np-tag--orange">找不到</span>}
          <Button variant="ghost" className="np-btn-text np-tr-rm" onClick={(e) => handleRemoveFolder(folder.path, e)}>移除</Button>
        </div>
        {open && (
          filesLoading ? <div className="np-empty db-tree-note">扫描中...</div>
            : files.length === 0 ? <div className="np-empty db-tree-note">此文件夹下没有 .md 文件</div>
              : (
                <FileTreeLevel
                  node={fileTree}
                  path=""
                  level={1}
                  expandedDirs={expandedDirs}
                  onToggleDir={handleToggleDir}
                  selectedFile={selectedFile}
                  onFileClick={handleFileClick}
                />
              )
        )}
      </div>
    )
  })

  /** 右栏正文：读取中出骨架、读不出整块错误、读到了是正文 */
  const renderDetailBody = () => {
    if (contentLoading) {
      return (
        <div className="db-sk" aria-hidden="true">
          {[1, 2, 3].map(i => (
            <div key={i} className="db-sk-block">
              <span className="np-sk np-sk--pulse db-sk-40" />
              <span className="np-sk np-sk--pulse db-sk-100" />
              <span className="np-sk np-sk--pulse db-sk-75" />
            </div>
          ))}
        </div>
      )
    }
    if (contentError) {
      return <StateView error="文件可能已被删除或移动" errorTitle="无法读取文件" onRetry={handleRetry} />
    }
    return (
      <>
        {contentStale && <StaleNotice bare className="db-stale db-stale--doc" onRetry={() => readFile(selectedFile, false, true)} />}
        <MarkdownRenderer className="np-read np-doc" content={displayContent} />
      </>
    )
  }

  return (
    <PageShell title="文档查阅" native className="db-page">
      <div className="np-split" style={{ '--db-list-w': `${sidebarWidth}px` }}>
        {/* 左栏：栏头搜索，栏体文件夹与目录树 / 搜索结果，栏底添加文件夹 */}
        <div className="np-pane np-pane--list">
          <div className="np-pane-hd">
            <label className="np-sf">
              <svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="5" cy="5" r="3.6" /><path d="M7.8 7.8 10.5 10.5" /></svg>
              <input
                type="text"
                placeholder="搜索文件名..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button type="button" className="np-sf-clear" aria-label="清空搜索框" onClick={() => setSearchQuery('')}>×</button>
              )}
            </label>
          </div>
          <div className="np-pane-body">
            {listStale && <StaleNotice bare className="db-stale" onRetry={retryList} />}
            {isSearchMode ? renderSearch() : (
              <StateView
                loading={foldersLoading}
                empty={folders.length === 0}
                emptyMessage="还没有添加文件夹"
                emptyHint="添加文件夹后即可浏览其中的 Markdown 文档"
                emptyIcon={FOLDER_EMPTY_ICON}
                emptyAction={<Button size="sm" variant="primary" onClick={handleAddFolder}>添加文件夹</Button>}
              >
                {renderFolders()}
              </StateView>
            )}
          </div>
          {showFooter && (
            <div className="np-pane-ft">
              <Button variant="ghost" className="np-btn-text" disabled={adding} onClick={handleAddFolder}>
                {adding ? '添加中…' : '＋ 添加文件夹'}
              </Button>
            </div>
          )}
        </div>

        {/* 两栏之间的拖动条：盖在 0.5px 竖线上，看不见，只换光标 */}
        <div {...resizerProps} />

        {/* 右栏：没选中一句话；选中后栏头 + 正文 */}
        <div className="np-pane np-pane--detail">
          {!selectedFile ? (
            <div className="np-pane-empty">选择一个文档查看内容</div>
          ) : (
            <>
              <div className="np-pane-hd">
                <div className="ttl" title={selectedName}>{selectedName}</div>
                <div className="meta">
                  <span title={selectedWhere.full}>{selectedWhere.short}</span>
                  {!contentLoading && !contentError && <span className="num">{formatSize(fileSize)}</span>}
                </div>
              </div>
              <div className="np-pane-body">{renderDetailBody()}</div>
            </>
          )}
        </div>
      </div>
    </PageShell>
  )
}
