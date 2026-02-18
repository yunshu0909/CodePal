/**
 * 新建项目页面
 *
 * 负责：
 * - 收集项目初始化参数（名称、路径、Git、模板）
 * - 实时预览将创建的目录结构
 * - 调用主进程 validate/execute 完成初始化闭环
 * - 展示校验结果、失败详情与成功确认弹窗
 *
 * @module pages/ProjectInitPage
 */

import React, { useEffect, useMemo, useState } from 'react'
import PathPickerField from '../components/PathPickerField'
import ProjectInitSuccessModal from '../components/ProjectInitSuccessModal'
import Toast from '../components/Toast'
import '../styles/project-init.css'

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
  { key: 'agents', label: 'AGENTS.md' },
  { key: 'claude', label: 'CLAUDE.md' },
  { key: 'design', label: 'design-system' },
]

const GIT_MODES = [
  { key: 'root', icon: '🌿', title: '根目录初始化', desc: '全项目纳入版本控制' },
  { key: 'code', icon: '📦', title: '仅代码目录', desc: '只在 code/ 文件夹初始化' },
  { key: 'none', icon: '🚫', title: '跳过 Git', desc: '稍后手动执行 git init' },
]

/**
 * 新建项目页面组件
 * @returns {JSX.Element}
 */
export default function ProjectInitPage() {
  // 项目名称输入值（用于创建根目录名）
  const [projectName, setProjectName] = useState('')
  // 目标路径输入值（用于计算项目落盘位置）
  const [targetPath, setTargetPath] = useState(DEFAULT_TARGET_PATH)
  // Git 模式选择（root/code/none）
  const [gitMode, setGitMode] = useState('root')
  // 模板勾选状态（控制复制哪些模板）
  const [templateSelection, setTemplateSelection] = useState({
    agents: true,
    claude: true,
    design: true,
  })
  // 预览是否展开（小屏默认收起，大屏默认展开）
  const [isPreviewExpanded, setIsPreviewExpanded] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return true
    }
    return !window.matchMedia(PREVIEW_MEDIA_QUERY).matches
  })
  // 是否正在提交创建请求（用于防重复点击）
  const [isSubmitting, setIsSubmitting] = useState(false)
  // 最近一次校验结果
  const [validationResult, setValidationResult] = useState(null)
  // 最近一次执行结果
  const [executionResult, setExecutionResult] = useState(null)
  // 成功弹窗是否可见
  const [isSuccessModalVisible, setIsSuccessModalVisible] = useState(false)
  // 成功弹窗摘要信息
  const [successModalSummary, setSuccessModalSummary] = useState(DEFAULT_SUCCESS_MODAL_SUMMARY)
  // Toast 提示消息
  const [toastMessage, setToastMessage] = useState(null)

  /**
   * 当前勾选模板 key 列表
   */
  const selectedTemplates = useMemo(
    () => TEMPLATE_OPTIONS.filter((item) => templateSelection[item.key]).map((item) => item.key),
    [templateSelection]
  )

  /**
   * 预览根目录名
   */
  const previewProjectName = useMemo(
    () => (projectName.trim().length > 0 ? projectName.trim() : 'my-awesome-project'),
    [projectName]
  )

  /**
   * 项目名称是否为空（用于禁用按钮，不显示错误）
   */
  const isProjectNameEmpty = useMemo(() => projectName.trim().length === 0, [projectName])

  /**
   * 项目名错误提示（仅非法字符，空值不算错误）
   */
  const projectNameError = useMemo(() => {
    const trimmedName = projectName.trim()
    if (trimmedName === '.' || trimmedName === '..' || PROJECT_NAME_INVALID_CHARS.test(trimmedName)) {
      return '项目名称包含非法字符'
    }
    return ''
  }, [projectName])

  /**
   * 创建按钮是否可用
   */
  const canCreate = !isProjectNameEmpty && !projectNameError && !isSubmitting && !isSuccessModalVisible

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return undefined
    }

    const mediaQueryList = window.matchMedia(PREVIEW_MEDIA_QUERY)

    // 与断点保持一致，避免窗口尺寸切换后展开状态和布局语义不一致。
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
   * 切换模板勾选
   * @param {string} templateKey - 模板 key
   */
  const handleToggleTemplate = (templateKey) => {
    setTemplateSelection((prev) => ({
      ...prev,
      [templateKey]: !prev[templateKey],
    }))
  }

  /**
   * 选择目标路径
   */
  const handlePickFolder = async () => {
    if (!window.electronAPI?.selectFolder) {
      setToastMessage('当前环境不支持路径浏览')
      return
    }

    try {
      const result = await window.electronAPI.selectFolder()
      if (!result.success) {
        setToastMessage(result.error || '选择路径失败')
        return
      }
      if (!result.canceled && result.path) {
        setTargetPath(result.path)
      }
    } catch (error) {
      console.error('Error selecting target folder:', error)
      setToastMessage('选择路径失败')
    }
  }

  /**
   * 执行创建流程：先 validate，再 execute
   */
  const handleCreateProject = async () => {
    if (!window.electronAPI?.validateProjectInit || !window.electronAPI?.executeProjectInit) {
      setToastMessage('当前版本未接入项目初始化 IPC')
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
        setToastMessage(validateResponse.error || '创建前校验异常')
        return
      }

      if (!validateResponse.valid) {
        setToastMessage('创建前校验未通过')
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
        setToastMessage('项目初始化失败，请查看结果明细')
      }
    } catch (error) {
      console.error('Error creating project:', error)
      setToastMessage('项目初始化失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * 成功弹窗确认：关闭弹窗并重置表单状态
   */
  const handleConfirmSuccessModal = () => {
    setIsSuccessModalVisible(false)
    setProjectName('')
    setTargetPath(DEFAULT_TARGET_PATH)
    setGitMode('root')
    setTemplateSelection({
      agents: true,
      claude: true,
      design: true,
    })
    setValidationResult(null)
    setExecutionResult(null)
    setSuccessModalSummary(DEFAULT_SUCCESS_MODAL_SUMMARY)
    setToastMessage('页面已重置，可以开始新的配置')
  }

  return (
    <div className="project-init-page" data-testid="project-init-page">
      <div className="pi-two-column" data-testid="project-init-two-column">
        <section className="pi-form-panel" data-testid="project-init-form-panel">
          <header className="pi-page-header">
            <h1 className="pi-page-title" data-testid="project-init-title">新建项目</h1>
            <p className="pi-page-subtitle">一键初始化项目结构</p>
          </header>

          <div className="pi-form-section">
            <div className="pi-section-title">📁 基本信息</div>
            <div className="pi-form-group">
              <label className="pi-form-label">项目名称</label>
              <input
                className={`pi-input ${projectNameError ? 'is-error' : ''}`}
                type="text"
                value={projectName}
                placeholder="请输入项目名称（必填）"
                onChange={(event) => setProjectName(event.target.value)}
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

          <div className="pi-form-section">
            <div className="pi-section-title">🌿 Git 模式</div>
            <div className="pi-radio-cards">
              {GIT_MODES.map((mode) => (
                <button
                  key={mode.key}
                  type="button"
                  className={`pi-radio-card ${gitMode === mode.key ? 'selected' : ''}`}
                  onClick={() => setGitMode(mode.key)}
                  disabled={isSubmitting}
                  data-testid={`git-mode-${mode.key}`}
                >
                  <div className="pi-radio-card__icon">{mode.icon}</div>
                  <div className="pi-radio-card__title">{mode.title}</div>
                  <div className="pi-radio-card__desc">{mode.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="pi-form-section">
            <div className="pi-section-title">📄 初始化模板</div>
            <div className="pi-checkbox-inline">
              {TEMPLATE_OPTIONS.map((template) => (
                <button
                  key={template.key}
                  type="button"
                  className={`pi-checkbox-pill ${templateSelection[template.key] ? 'selected' : ''}`}
                  onClick={() => handleToggleTemplate(template.key)}
                  disabled={isSubmitting}
                  data-testid={`template-pill-${template.key}`}
                >
                  <span className="pi-checkbox-dot" />
                  <span>{template.label}</span>
                </button>
              ))}
            </div>
          </div>

        </section>

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
                  <span>{previewProjectName}</span>/
                </div>

                {gitMode === 'root' && (
                  <div className="pi-tree-item pi-tree-indent pi-tree-connector">
                    <span className="pi-tree-folder pi-tree-success">📁</span>
                    <span className="pi-tree-success" data-testid="project-tree-git-root">.git/</span>
                  </div>
                )}

                {templateSelection.agents && (
                  <div className="pi-tree-item pi-tree-indent pi-tree-connector" data-testid="project-tree-agents">
                    <span className="pi-tree-file">📄</span>
                    AGENTS.md
                  </div>
                )}

                {templateSelection.claude && (
                  <div className="pi-tree-item pi-tree-indent pi-tree-connector" data-testid="project-tree-claude">
                    <span className="pi-tree-file">📄</span>
                    CLAUDE.md
                  </div>
                )}

                <div className="pi-tree-item pi-tree-indent pi-tree-connector">
                  <span className="pi-tree-folder">📁</span>
                  prd/
                </div>

                <div className="pi-tree-item pi-tree-indent pi-tree-connector">
                  <span className="pi-tree-folder">📁</span>
                  design/
                </div>

                {templateSelection.design && (
                  <div className="pi-tree-item pi-tree-indent-2 pi-tree-connector" data-testid="project-tree-design-system">
                    <span className="pi-tree-file">📄</span>
                    design-system.html
                  </div>
                )}

                <div className="pi-tree-item pi-tree-indent pi-tree-connector">
                  <span className="pi-tree-folder">📁</span>
                  code/
                </div>

                {gitMode === 'code' && (
                  <div className="pi-tree-item pi-tree-indent-2 pi-tree-connector">
                    <span className="pi-tree-folder pi-tree-success">📁</span>
                    <span className="pi-tree-success" data-testid="project-tree-git-code">.git/</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <div className="pi-card-footer" data-testid="project-init-footer">
          <button
            type="button"
            className="pi-btn pi-btn-primary"
            onClick={handleCreateProject}
            disabled={!canCreate}
            title={isProjectNameEmpty ? '请填写项目名称' : projectNameError ? projectNameError : ''}
            data-testid="create-project-button"
          >
            {isSubmitting ? '创建中...' : '创建项目'}
          </button>
        </div>
      </div>

      {validationResult && !validationResult.valid && (
        <section className="pi-result pi-result-error" data-testid="project-init-validation-result">
          <h3>创建前校验未通过</h3>
          <ul>
            {(validationResult.data?.errors || []).map((errorItem, index) => (
              <li key={`${errorItem.code}-${index}`}>
                <strong>{errorItem.code}</strong> - {errorItem.message}
                {errorItem.path ? ` (${errorItem.path})` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {executionResult && !executionResult.success && (
        <section
          className="pi-result pi-result-error"
          data-testid="project-init-execution-failed"
        >
          <h3>初始化失败</h3>
          <ul>
            {(executionResult.data?.steps || []).map((stepItem, index) => (
              <li key={`${stepItem.step}-${index}`}>
                <strong>[{stepItem.status}]</strong> {stepItem.step}
                {stepItem.path ? ` - ${stepItem.path}` : ''}
                {stepItem.code ? ` (${stepItem.code})` : ''}
                {stepItem.message ? `：${stepItem.message}` : ''}
              </li>
            ))}
          </ul>

          {executionResult.data?.rollback?.attempted && (
            <div className="pi-rollback">
              回滚状态：{executionResult.data.rollback.success ? '成功' : '部分失败'}
            </div>
          )}
        </section>
      )}

      <ProjectInitSuccessModal
        visible={isSuccessModalVisible}
        projectPath={successModalSummary.projectPath}
        createdDirectoryCount={successModalSummary.createdDirectoryCount}
        configStatus={successModalSummary.configStatus}
        onConfirm={handleConfirmSuccessModal}
      />

      {toastMessage && <Toast message={toastMessage} onClose={() => setToastMessage(null)} />}
    </div>
  )
}
