/**
 * 新建项目页面
 *
 * 负责：
 * - 收集项目初始化参数（名称、路径、Git、模板、记忆系统）
 * - Git 可用性预检
 * - 模板依赖联动（记忆系统依赖指引文件）
 * - 实时预览将创建的目录结构（含文件注释）
 * - 调用主进程 validate/execute 完成初始化闭环
 * - 展示校验结果、失败详情与成功确认弹窗
 *
 * @module pages/ProjectInitPage
 */

import React, { useEffect, useMemo, useState } from 'react'
import PathPickerField from '../components/PathPickerField'
import ProjectInitSuccessModal, { ProjectInitErrorModal } from '../components/ProjectInitSuccessModal'
import Toast from '../components/Toast'
import '../styles/project-init.css'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'

const DEFAULT_TARGET_PATH = '~/Documents/projects/'
const PROJECT_NAME_INVALID_CHARS = /[\\/:*?"<>|]/
const PREVIEW_COLLAPSE_BREAKPOINT = 1024
const PREVIEW_MEDIA_QUERY = `(max-width: ${PREVIEW_COLLAPSE_BREAKPOINT}px)`
const DEFAULT_SUCCESS_MODAL_SUMMARY = Object.freeze({
  projectPath: '',
  createdDirectoryCount: 0,
  configStatus: '未生成',
})

const TEMPLATE_OPTIONS = [
  {
    key: 'agents',
    label: 'AGENTS.md',
    desc: 'Codex 项目指引文件 — 包含编程规范、注释标准、文件体量红线，让 Codex 按统一标准写代码',
    isGuideFile: true,
  },
  {
    key: 'claude',
    label: 'CLAUDE.md',
    desc: 'Claude Code 项目指引文件 — 包含编程规范、注释标准、文件体量红线，让 Claude Code 按统一标准写代码',
    isGuideFile: true,
  },
  {
    key: 'memory',
    label: '记忆系统',
    desc: '生成 MEMORY.md + memory/ 目录，让 AI 跨对话记住项目上下文、工作偏好和关键决策。首次对话时 AI 会自动引导你完成初始化',
    depHint: '需要至少启用一个指引文件（AGENTS.md 或 CLAUDE.md）',
    isGuideFile: false,
  },
]

const GIT_MODES = [
  { key: 'root', icon: '🌿', title: '根目录初始化', desc: '全项目纳入版本控制' },
  { key: 'code', icon: '📦', title: '仅代码目录', desc: '只在 code/ 文件夹初始化' },
  { key: 'none', icon: '🚫', title: '跳过 Git', desc: '稍后手动执行 git init' },
]

// 预览区文件注释
const TREE_ANNOTATIONS = {
  '.git/': '版本控制',
  'AGENTS.md': 'Codex 指引',
  'CLAUDE.md': 'Claude Code 指引',
  'MEMORY.md': '长期记忆',
  'memory/': '每日记忆',
  'docs/': 'PRD + 设计文档',
  'code/': '项目代码',
}

/**
 * 新建项目页面组件
 * @returns {JSX.Element}
 */
export default function ProjectInitPage() {
  // 项目名称输入值
  const [projectName, setProjectName] = useState('')
  // 目标路径输入值
  const [targetPath, setTargetPath] = useState(DEFAULT_TARGET_PATH)
  // Git 模式选择
  const [gitMode, setGitMode] = useState('root')
  // Git 是否可用（预检结果）
  const [gitAvailable, setGitAvailable] = useState(true)
  // 模板勾选状态
  const [templateSelection, setTemplateSelection] = useState({
    agents: true,
    claude: true,
    memory: true,
  })
  // 预览是否展开
  const [isPreviewExpanded, setIsPreviewExpanded] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    return !window.matchMedia(PREVIEW_MEDIA_QUERY).matches
  })
  // 是否正在提交
  const [isSubmitting, setIsSubmitting] = useState(false)
  // 最近一次校验结果
  const [validationResult, setValidationResult] = useState(null)
  // 最近一次执行结果
  const [executionResult, setExecutionResult] = useState(null)
  // 成功弹窗
  const [isSuccessModalVisible, setIsSuccessModalVisible] = useState(false)
  const [successModalSummary, setSuccessModalSummary] = useState(DEFAULT_SUCCESS_MODAL_SUMMARY)
  // 失败弹窗
  const [isErrorModalVisible, setIsErrorModalVisible] = useState(false)
  const [errorModalData, setErrorModalData] = useState({
    errorTitle: '',
    errorMessage: '',
    errorHint: '',
    failedSteps: [],
    rollback: null,
  })
  // Toast
  const [toast, setToast] = useState(null)

  // 是否有指引文件被勾选（记忆系统的依赖条件）
  const hasGuideFile = templateSelection.agents || templateSelection.claude

  // 当前勾选的模板 key 列表
  const selectedTemplates = useMemo(
    () => TEMPLATE_OPTIONS.filter((item) => templateSelection[item.key]).map((item) => item.key),
    [templateSelection]
  )

  // 预览根目录名
  const previewProjectName = useMemo(
    () => (projectName.trim().length > 0 ? projectName.trim() : 'my-awesome-project'),
    [projectName]
  )

  // 项目名称是否为空
  const isProjectNameEmpty = useMemo(() => projectName.trim().length === 0, [projectName])

  // 项目名错误提示
  const projectNameError = useMemo(() => {
    const trimmedName = projectName.trim()
    if (trimmedName === '.' || trimmedName === '..' || PROJECT_NAME_INVALID_CHARS.test(trimmedName)) {
      return '项目名称包含非法字符'
    }
    return ''
  }, [projectName])

  // 创建按钮是否可用
  const canCreate = !isProjectNameEmpty && !projectNameError && !isSubmitting && !isSuccessModalVisible

  // Git 预检
  useEffect(() => {
    if (!window.electronAPI?.checkGitAvailable) return

    window.electronAPI.checkGitAvailable().then((result) => {
      if (result?.success && result.data) {
        const available = result.data.available
        setGitAvailable(available)
        if (!available) {
          setGitMode('none')
        }
      }
    }).catch(() => {
      // 检测失败不阻塞页面，保持默认可用
    })
  }, [])

  // 响应式预览展开
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined

    const mediaQueryList = window.matchMedia(PREVIEW_MEDIA_QUERY)
    const syncPreviewExpandedByViewport = (event) => {
      setIsPreviewExpanded(!event.matches)
    }

    syncPreviewExpandedByViewport(mediaQueryList)

    if (mediaQueryList.addEventListener) {
      mediaQueryList.addEventListener('change', syncPreviewExpandedByViewport)
      return () => mediaQueryList.removeEventListener('change', syncPreviewExpandedByViewport)
    }

    mediaQueryList.addListener(syncPreviewExpandedByViewport)
    return () => mediaQueryList.removeListener(syncPreviewExpandedByViewport)
  }, [])

  /**
   * 切换模板勾选（含记忆依赖逻辑）
   */
  const handleToggleTemplate = (templateKey) => {
    setTemplateSelection((prev) => {
      const next = { ...prev, [templateKey]: !prev[templateKey] }

      // 如果取消的是指引文件，检查记忆依赖
      const option = TEMPLATE_OPTIONS.find((o) => o.key === templateKey)
      if (option?.isGuideFile && !next[templateKey]) {
        const stillHasGuide = TEMPLATE_OPTIONS
          .filter((o) => o.isGuideFile && o.key !== templateKey)
          .some((o) => next[o.key])

        if (!stillHasGuide) {
          next.memory = false
        }
      }

      return next
    })
  }

  /**
   * 选择目标路径
   */
  const handlePickFolder = async () => {
    if (!window.electronAPI?.selectFolder) {
      setToast({ message: '当前环境不支持路径浏览', type: 'warning' })
      return
    }

    try {
      const result = await window.electronAPI.selectFolder()
      if (!result.success) {
        setToast({ message: result.error || '选择路径失败', type: 'error' })
        return
      }
      if (!result.canceled && result.path) {
        setTargetPath(result.path)
      }
    } catch (error) {
      console.error('Error selecting target folder:', error)
      setToast({ message: '选择路径失败', type: 'error' })
    }
  }

  /**
   * 执行创建流程
   */
  const handleCreateProject = async () => {
    if (!window.electronAPI?.validateProjectInit || !window.electronAPI?.executeProjectInit) {
      setErrorModalData({
        errorTitle: '功能不可用',
        errorMessage: '当前版本未接入项目初始化 IPC',
        errorHint: '请检查应用版本或联系技术支持',
        failedSteps: [],
        rollback: null,
      })
      setIsErrorModalVisible(true)
      return
    }

    const requestPayload = {
      projectName: projectName.trim(),
      targetPath: targetPath.trim(),
      gitMode,
      templates: selectedTemplates,
      overwrite: false,
      autoCommit: false,
    }

    setIsSubmitting(true)
    setValidationResult(null)
    setExecutionResult(null)
    setIsSuccessModalVisible(false)

    try {
      const validateResponse = await window.electronAPI.validateProjectInit(requestPayload)
      setValidationResult(validateResponse)

      if (!validateResponse.success) {
        setErrorModalData({
          errorTitle: '创建前校验异常',
          errorMessage: validateResponse.error || '校验过程发生错误',
          errorHint: '请检查网络连接或稍后重试',
          failedSteps: [],
          rollback: null,
        })
        setIsErrorModalVisible(true)
        return
      }

      if (!validateResponse.valid) {
        const errors = validateResponse.data?.errors || []
        const firstError = errors[0]
        setErrorModalData({
          errorTitle: '创建前校验未通过',
          errorMessage: firstError?.message || '参数校验失败',
          errorHint: firstError?.code === 'TARGET_CONFLICT'
            ? '请更换项目名称或删除现有目录后重试'
            : '请检查输入参数后重试',
          failedSteps: errors.map((e) => ({ step: e.code || '校验', status: 'failed', message: e.message })),
          rollback: null,
        })
        setIsErrorModalVisible(true)
        return
      }

      const executeResponse = await window.electronAPI.executeProjectInit(requestPayload)
      setExecutionResult(executeResponse)

      if (executeResponse.success) {
        const projectPath = executeResponse.data?.validation?.data?.resolvedPaths?.projectRoot
          || `${requestPayload.targetPath.replace(/[\\/]+$/, '')}/${requestPayload.projectName}`
        const createdDirectoryCount = executeResponse.data?.validation?.data?.plannedDirectories?.length
          || executeResponse.data?.summary?.createdDirectories?.length
          || 0

        setSuccessModalSummary({
          projectPath,
          createdDirectoryCount,
          configStatus: requestPayload.templates.length > 0 ? '已生成' : '未生成',
        })
        setIsSuccessModalVisible(true)
      } else {
        const steps = executeResponse.data?.steps || []
        const failedSteps = steps.filter((s) => s.status === 'failed' || s.status === 'error')
        const rollback = executeResponse.data?.rollback
        setErrorModalData({
          errorTitle: '项目创建失败',
          errorMessage: executeResponse.error || '初始化过程中发生错误',
          errorHint: failedSteps[0]?.message || '请检查日志或更换项目路径后重试',
          failedSteps,
          rollback: rollback || null,
        })
        setIsErrorModalVisible(true)
      }
    } catch (error) {
      console.error('Error creating project:', error)
      setErrorModalData({
        errorTitle: '项目初始化失败',
        errorMessage: error?.message || '未知错误',
        errorHint: '请检查网络连接或稍后重试',
        failedSteps: [],
        rollback: null,
      })
      setIsErrorModalVisible(true)
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * 成功弹窗确认：关闭并重置
   */
  const handleConfirmSuccessModal = () => {
    setIsSuccessModalVisible(false)
    setProjectName('')
    setTargetPath(DEFAULT_TARGET_PATH)
    setGitMode(gitAvailable ? 'root' : 'none')
    setTemplateSelection({ agents: true, claude: true, memory: true })
    setValidationResult(null)
    setExecutionResult(null)
    setSuccessModalSummary(DEFAULT_SUCCESS_MODAL_SUMMARY)
    setToast({ message: '页面已重置，可以开始新的配置', type: 'info' })
  }

  const handleCloseErrorModal = () => setIsErrorModalVisible(false)

  const handleRetryErrorModal = () => {
    setIsErrorModalVisible(false)
    handleCreateProject()
  }

  /**
   * 渲染预览区树形节点
   */
  const renderTreeItem = (name, icon, indent, extraClass = '', visible = true) => {
    if (!visible) return null
    const indentClass = indent === 2 ? 'pi-tree-indent-2' : indent === 1 ? 'pi-tree-indent' : ''
    return (
      <div className={`pi-tree-item ${indentClass} ${indent > 0 ? 'pi-tree-connector' : ''} ${extraClass}`}>
        <span className={icon === '📁' ? 'pi-tree-folder' : 'pi-tree-file'}>{icon}</span>
        {name}
        {TREE_ANNOTATIONS[name] && (
          <span className="pi-tree-annotation">{TREE_ANNOTATIONS[name]}</span>
        )}
      </div>
    )
  }

  return (
    <PageShell title="新建项目" subtitle="一键初始化 AI 编程项目结构" className="page-shell--no-padding" divider data-testid="project-init-page">
      <div className="pi-two-column" data-testid="project-init-two-column">
        <section className="pi-form-panel" data-testid="project-init-form-panel">

          {/* 基本信息 */}
          <div className="pi-form-section">
            <div className="pi-section-title">基本信息</div>
            <div className="pi-form-group">
              <label className="pi-form-label">项目名称</label>
              <input
                className={`pi-input ${projectNameError ? 'is-error' : ''}`}
                type="text"
                value={projectName}
                placeholder="请输入项目名称（必填）"
                onChange={(event) => setProjectName(event.target.value)}
                disabled={isSubmitting}
                data-testid="project-name-input"
              />
              {projectNameError && (
                <div className="pi-error-text" data-testid="project-name-error">{projectNameError}</div>
              )}
            </div>

            <PathPickerField
              label="目标路径"
              value={targetPath}
              onChange={setTargetPath}
              onPick={handlePickFolder}
              disabled={isSubmitting}
              inputTestId="target-path-input"
              pickButtonTestId="target-path-browse-button"
            />
          </div>

          {/* Git 模式 */}
          <div className="pi-form-section">
            <div className="pi-section-title">Git 模式</div>
            <div className="pi-radio-cards">
              {GIT_MODES.map((mode) => (
                <button
                  key={mode.key}
                  type="button"
                  className={`pi-radio-card ${gitMode === mode.key ? 'selected' : ''} ${!gitAvailable && mode.key !== 'none' ? 'disabled' : ''}`}
                  onClick={() => setGitMode(mode.key)}
                  disabled={isSubmitting || (!gitAvailable && mode.key !== 'none')}
                  data-testid={`git-mode-${mode.key}`}
                >
                  <div className="pi-radio-card__icon">{mode.icon}</div>
                  <div className="pi-radio-card__title">{mode.title}</div>
                  <div className="pi-radio-card__desc">{mode.desc}</div>
                </button>
              ))}
            </div>
            {!gitAvailable && (
              <div className="pi-section-hint" data-testid="git-not-available-hint">
                未检测到 Git，已自动选择"跳过 Git"。安装 Git 后重新打开此页面即可使用。
              </div>
            )}
          </div>

          {/* 初始化内容 */}
          <div className="pi-form-section">
            <div className="pi-section-title">初始化内容</div>
            <div className="pi-template-list">
              {TEMPLATE_OPTIONS.map((template) => {
                const isMemoryDisabled = template.key === 'memory' && !hasGuideFile
                const isSelected = templateSelection[template.key]
                const isDisabled = isSubmitting || isMemoryDisabled

                return (
                  <button
                    key={template.key}
                    type="button"
                    className={`pi-template-item ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                    onClick={() => handleToggleTemplate(template.key)}
                    disabled={isDisabled}
                    data-testid={`template-item-${template.key}`}
                  >
                    <div className="pi-template-checkbox">
                      <span className="pi-template-checkbox-tick">&#10003;</span>
                    </div>
                    <div className="pi-template-info">
                      <div className="pi-template-name">{template.label}</div>
                      <div className="pi-template-desc">{template.desc}</div>
                      {template.depHint && isMemoryDisabled && (
                        <div className="pi-template-dep">{template.depHint}</div>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

        </section>

        {/* 预览区 */}
        <section
          className={`pi-preview-panel ${isPreviewExpanded ? 'expanded' : 'collapsed'}`}
          data-testid="project-init-preview-panel"
        >
          <div
            className="pi-preview-header"
            onClick={() => setIsPreviewExpanded(!isPreviewExpanded)}
            style={{ cursor: 'pointer' }}
          >
            <span>👁</span> 实时预览
            <span className="pi-preview-toggle">{isPreviewExpanded ? '▲' : '▼'}</span>
          </div>
          {isPreviewExpanded && (
            <div className="pi-preview-content" data-testid="project-tree-preview">
              <div className="pi-tree">
                <div className="pi-tree-item root" data-testid="project-tree-root">
                  <span className="pi-tree-folder">📁</span>
                  <span>{previewProjectName}</span> /
                </div>

                {/* .git/ */}
                {gitMode === 'root' && (
                  <div className="pi-tree-item pi-tree-indent pi-tree-connector">
                    <span className="pi-tree-folder pi-tree-success">📁</span>
                    <span className="pi-tree-success">.git/</span>
                    <span className="pi-tree-annotation">{TREE_ANNOTATIONS['.git/']}</span>
                  </div>
                )}

                {/* AGENTS.md */}
                {templateSelection.agents && (
                  <div className="pi-tree-item pi-tree-indent pi-tree-connector" data-testid="project-tree-agents">
                    <span className="pi-tree-file">📄</span>
                    AGENTS.md
                    <span className="pi-tree-annotation">{TREE_ANNOTATIONS['AGENTS.md']}</span>
                  </div>
                )}

                {/* CLAUDE.md */}
                {templateSelection.claude && (
                  <div className="pi-tree-item pi-tree-indent pi-tree-connector" data-testid="project-tree-claude">
                    <span className="pi-tree-file">📄</span>
                    CLAUDE.md
                    <span className="pi-tree-annotation">{TREE_ANNOTATIONS['CLAUDE.md']}</span>
                  </div>
                )}

                {/* MEMORY.md */}
                {templateSelection.memory && (
                  <div className="pi-tree-item pi-tree-indent pi-tree-connector" data-testid="project-tree-memory">
                    <span className="pi-tree-file">📄</span>
                    MEMORY.md
                    <span className="pi-tree-annotation">{TREE_ANNOTATIONS['MEMORY.md']}</span>
                  </div>
                )}

                {/* memory/ */}
                {templateSelection.memory && (
                  <div className="pi-tree-item pi-tree-indent pi-tree-connector" data-testid="project-tree-memory-dir">
                    <span className="pi-tree-folder">📁</span>
                    memory/
                    <span className="pi-tree-annotation">{TREE_ANNOTATIONS['memory/']}</span>
                  </div>
                )}

                {/* docs/ */}
                <div className="pi-tree-item pi-tree-indent pi-tree-connector">
                  <span className="pi-tree-folder">📁</span>
                  docs/
                  <span className="pi-tree-annotation">{TREE_ANNOTATIONS['docs/']}</span>
                </div>

                {/* code/ */}
                <div className="pi-tree-item pi-tree-indent pi-tree-connector">
                  <span className="pi-tree-folder">📁</span>
                  code/
                  <span className="pi-tree-annotation">{TREE_ANNOTATIONS['code/']}</span>
                </div>

                {/* code/.git/ */}
                {gitMode === 'code' && (
                  <div className="pi-tree-item pi-tree-indent-2 pi-tree-connector">
                    <span className="pi-tree-folder pi-tree-success">📁</span>
                    <span className="pi-tree-success">.git/</span>
                    <span className="pi-tree-annotation">{TREE_ANNOTATIONS['.git/']}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Footer */}
        <div className="pi-card-footer" data-testid="project-init-footer">
          <Button
            variant="primary"
            loading={isSubmitting}
            disabled={!canCreate}
            onClick={handleCreateProject}
            title={isProjectNameEmpty ? '请填写项目名称' : projectNameError ? projectNameError : ''}
            data-testid="create-project-button"
          >
            创建项目
          </Button>
        </div>
      </div>

      <ProjectInitSuccessModal
        visible={isSuccessModalVisible}
        projectPath={successModalSummary.projectPath}
        createdDirectoryCount={successModalSummary.createdDirectoryCount}
        configStatus={successModalSummary.configStatus}
        onConfirm={handleConfirmSuccessModal}
      />

      <ProjectInitErrorModal
        visible={isErrorModalVisible}
        errorTitle={errorModalData.errorTitle}
        errorMessage={errorModalData.errorMessage}
        errorHint={errorModalData.errorHint}
        onClose={handleCloseErrorModal}
        onRetry={handleRetryErrorModal}
      />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </PageShell>
  )
}
