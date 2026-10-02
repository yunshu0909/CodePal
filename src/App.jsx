/**
 * 应用根组件
 *
 * 负责：
 * - 始终渲染 WorkbenchLayout（含侧边栏），按活跃模块渲染对应页面（只组装，不写业务）
 * - 管理活跃模块状态（Skills / 用量看板 / Claude 专属页等），记住上次停在哪一页
 * - 同步主进程的新版提醒状态
 *
 * Skills 的读取与写入都在 Skills 页自己的模块里（进页面时读、你点了才写）；
 * 旧的导入 / 推送后台任务已于 2026-10 退役（specs/v2.1.9-Skills只留一套引擎）。
 *
 * @module App
 */

import React, { useState, useEffect } from 'react'
import WorkbenchLayout from './components/WorkbenchLayout'
import SkillsPage from './pages/skills/SkillsPage'
import UsageMonitorModule from './components/UsageMonitorModule'
import PlanManagementPage from './pages/PlanManagementPage'
import ProjectInitPage from './pages/ProjectInitPage'
import PermissionModePage from './pages/PermissionModePage'
import NetworkDiagnosticsPage from './pages/NetworkDiagnosticsPage'
import ModelsPage from './features/models/ModelsPage'
import SessionBrowserPage from './pages/SessionBrowserPage'
import DocBrowserPage from './pages/DocBrowserPage'
import SessionStatusPage from './pages/SessionStatusPage'
import { setPricingOverride } from './store/costCalculator'
import useMainNavigation from './hooks/useMainNavigation'

// 首次打开、或记住的页面已下线时进侧栏第一项（2026-09-19 用户定）
const DEFAULT_ACTIVE_MODULE = 'usage'
export const VALID_ACTIVE_MODULES = new Set(['skills', 'usage', 'claude-usage', 'project-init', 'permission', 'models', 'network', 'session-status', 'sessions', 'doc-browser'])
const INITIAL_APP_UPDATE_STATE = Object.freeze({
  checked: false,
  checking: false,
  hasUpdate: false,
  currentVersion: '',
  latestVersion: '',
  releaseUrl: '',
  releaseNotes: '',
  error: null,
  checkedAt: null,
})

/**
 * 读取上次访问的模块，并过滤已下线模块
 * @returns {'skills'|'usage'|'claude-usage'|'project-init'|'permission'|'models'|'network'|'session-status'|'sessions'|'doc-browser'}
 */
export function getInitialActiveModule() {
  // 原「状态灯」已改名为「会话状态」（#41），记住的旧模块直接带过去
  const storedModule = localStorage.getItem('codepal-active-module') === 'k28-status-light'
    ? 'session-status'
    : localStorage.getItem('codepal-active-module')
  return VALID_ACTIVE_MODULES.has(storedModule) ? storedModule : DEFAULT_ACTIVE_MODULE
}

export default function App() {
  // 活跃模块：从 localStorage 恢复上次页面；已下线模块统一回落到默认页（用量监测）
  const [activeModule, setActiveModule] = useState(getInitialActiveModule)
  // Usage 页面是否已访问（已访问后保持挂载，支持后台继续汇总重周期）
  const [hasVisitedUsage, setHasVisitedUsage] = useState(false)
  // 应用更新状态：由主进程统一检查并推送，渲染层只负责展示
  const [appUpdateState, setAppUpdateState] = useState(INITIAL_APP_UPDATE_STATE)

  // 启动时异步加载最新 pricing 覆盖 import 的默认值
  // 失败静默，不影响应用运行（会 fallback 到打包的 pricing.json）
  useEffect(() => {
    const loadRemotePricing = async () => {
      try {
        const result = await window.electronAPI.getPricingRegistry()
        if (result?.success && result.registry) {
          setPricingOverride(result.registry)
        }
      } catch (error) {
        console.warn('[cost] getPricingRegistry failed:', error?.message || error)
      }
    }
    loadRemotePricing()
  }, [])

  /**
   * 处理模块切换
   * 同时持久化到 localStorage，下次打开恢复上次页面
   * @param {string} moduleId - 模块 ID
   */
  const handleModuleChange = (moduleId) => {
    setActiveModule(moduleId)
    localStorage.setItem('codepal-active-module', moduleId)
  }

  // 主进程要求切页（点系统通知后切到网络诊断）
  useMainNavigation((moduleId) => handleModuleChange(moduleId), VALID_ACTIVE_MODULES)

  useEffect(() => {
    if (activeModule === 'usage') {
      setHasVisitedUsage(true)
    }
  }, [activeModule])

  useEffect(() => {
    if (!window.electronAPI?.getAppUpdateState) return undefined

    let isDisposed = false

    const applyNextState = (nextState) => {
      if (isDisposed || !nextState) return
      setAppUpdateState((prev) => ({ ...prev, ...nextState }))
    }

    const loadInitialAppUpdateState = async () => {
      try {
        const nextState = await window.electronAPI.getAppUpdateState()
        applyNextState(nextState)
      } catch (error) {
        console.error('Error loading app update state:', error)
      }
    }

    loadInitialAppUpdateState()

    const unsubscribe = window.electronAPI.onAppUpdateState?.((nextState) => {
      applyNextState(nextState)
    }) || (() => {})

    return () => {
      isDisposed = true
      unsubscribe()
    }
  }, [])

  // 启动时静默尝试接入 Claude Code 会员额度状态，不打断用户主流程
  useEffect(() => {
    let isDisposed = false

    const bootstrapClaudeUsageStatus = async () => {
      if (!window.electronAPI?.ensureClaudeUsageStatusInstalled) return

      try {
        const result = await window.electronAPI.ensureClaudeUsageStatusInstalled({ force: false, intent: 'silent' })
        if (isDisposed) return

        // 检测失败只记日志，不弹窗，避免启动噪音过大
        if (!result?.success && result?.error) {
          console.warn('[claude-usage-status] bootstrap skipped:', result.error)
        }
      } catch (error) {
        if (!isDisposed) {
          console.warn('[claude-usage-status] bootstrap failed:', error?.message || error)
        }
      }
    }

    bootstrapClaudeUsageStatus()

    return () => {
      isDisposed = true
    }
  }, [])

  /**
   * 打开新版下载页
   */
  const handleUpdateClick = () => {
    window.electronAPI?.openAppUpdatePage?.().catch((error) => {
      console.error('Error opening update page:', error)
    })
  }

  // 始终渲染 WorkbenchLayout
  return (
    <div className="app">
      <WorkbenchLayout
        activeModule={activeModule}
        onModuleChange={handleModuleChange}
        appUpdate={appUpdateState}
        onDownloadUpdate={handleUpdateClick}
      >
        {activeModule === 'skills' && <SkillsPage />}
        {(activeModule === 'usage' || hasVisitedUsage) && (
          <div className="keep-alive-wrapper" hidden={activeModule !== 'usage'}>
            <UsageMonitorModule isActive={activeModule === 'usage'} />
          </div>
        )}
        {activeModule === 'claude-usage' && <PlanManagementPage />}
        {activeModule === 'project-init' && <ProjectInitPage />}
        {activeModule === 'permission' && <PermissionModePage />}
        {activeModule === 'models' && <ModelsPage />}
        {activeModule === 'network' && <NetworkDiagnosticsPage />}
        {activeModule === 'session-status' && <SessionStatusPage />}
        {activeModule === 'sessions' && <SessionBrowserPage />}
        {activeModule === 'doc-browser' && <DocBrowserPage />}
      </WorkbenchLayout>

    </div>
  )
}
