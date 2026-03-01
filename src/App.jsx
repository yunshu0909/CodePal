/**
 * 应用根组件
 *
 * 负责：
 * - 始终渲染 WorkbenchLayout（含侧边栏）
 * - 根据中央仓库状态决定 SkillManager 初始子页面（import/manage）
 * - 导入完成后初始化推送目标
 * - 管理活跃模块状态（技能管理/用量监测/API配置）
 * - 工作台下定时执行自动增量刷新（每 5 分钟）
 *
 * @module App
 */

import React, { useState, useEffect } from 'react'
import WorkbenchLayout from './components/WorkbenchLayout'
import SkillManagerModule from './components/SkillManagerModule'
import UsageMonitorModule from './components/UsageMonitorModule'
import ApiConfigPage from './pages/ApiConfigPage'
import ProjectInitPage from './pages/ProjectInitPage'
import PermissionModePage from './pages/PermissionModePage'
import McpPage from './pages/McpPage'
import Toast from './components/Toast'
import { dataStore } from './store/data'

const AUTO_INCREMENTAL_REFRESH_INTERVAL_MS = 5 * 60 * 1000

export default function App() {
  // SkillManager 初始子页面：null=加载中, 'manage'=管理页, 'import'=导入页
  const [initialSkillManagerPage, setInitialSkillManagerPage] = useState(null)
  // Toast 提示消息 { message, type }
  const [toast, setToast] = useState(null)
  // 活跃模块：'skills' | 'mcp' | 'project-init' | 'usage' | 'api' | 'permission'
  const [activeModule, setActiveModule] = useState('skills')
  // MCP 页面是否已访问（已访问后保持挂载，支持切回时静默刷新）
  const [hasVisitedMcp, setHasVisitedMcp] = useState(false)
  // 技能模块刷新信号（自动增量导入新增 skill 后触发）
  const [skillsRefreshSignal, setSkillsRefreshSignal] = useState(0)

  // 启动时检查中央仓库状态，决定初始页面
  useEffect(() => {
    const checkInitialPage = async () => {
      try {
        const hasData = await dataStore.hasCentralSkills()
        setInitialSkillManagerPage(hasData ? 'manage' : 'import')
      } catch (error) {
        console.error('Error checking central repo:', error)
        setInitialSkillManagerPage('import')
      }
    }

    checkInitialPage()
  }, [])

  // 确定初始页面后，若为 manage 则执行推送目标初始化检查
  useEffect(() => {
    if (initialSkillManagerPage === 'manage') {
      initPushTargetsIfNeeded()
    }
  }, [initialSkillManagerPage])

  // 工作台下启用自动增量刷新任务：每 5 分钟扫描一次导入来源并仅新增
  useEffect(() => {
    // 加载中不启动定时任务
    if (initialSkillManagerPage === null) {
      return undefined
    }

    let isDisposed = false

    const runAutoRefresh = async () => {
      try {
        // 方向 2 会写入中央仓库，先获取同步锁避免触发方向 1
        await window.electronAPI?.acquireSyncLock?.()
        const refreshResult = await dataStore.autoIncrementalRefresh()
        if (isDisposed) return

        if (refreshResult?.added > 0 || refreshResult?.updated > 0) {
          // 通过信号通知技能模块刷新数据；不弹 toast，避免打断用户操作
          setSkillsRefreshSignal((prev) => prev + 1)
        }
      } catch (error) {
        // 自动任务失败仅记录日志，避免影响用户主流程
        console.error('Auto incremental refresh failed:', error)
      } finally {
        // 释放同步锁（主进程会延迟 1s 再解锁）
        window.electronAPI?.releaseSyncLock?.().catch(() => {})
      }
    }

    // 进入工作台后先执行一次，避免首次等待 5 分钟
    runAutoRefresh()
    const timerId = window.setInterval(runAutoRefresh, AUTO_INCREMENTAL_REFRESH_INTERVAL_MS)

    return () => {
      isDisposed = true
      window.clearInterval(timerId)
    }
  }, [initialSkillManagerPage])

  // 方向 1：监听中央仓库文件变更，自动推送到已启用工具
  useEffect(() => {
    if (!window.electronAPI?.onCentralRepoChanged) return undefined
    const unsubscribe = window.electronAPI.onCentralRepoChanged(async (changedSkillNames) => {
      try {
        const result = await dataStore.handleCentralRepoChanged(changedSkillNames)
        if (result.syncedCount > 0) {
          setSkillsRefreshSignal((prev) => prev + 1)
        }
      } catch (error) {
        console.error('[auto-sync] Central → tools failed:', error)
      }
    })
    return () => unsubscribe()
  }, [])

  /**
   * 导入后首次进入管理页时初始化推送目标
   * 根据导入时选中的工具决定默认推送目标
   */
  async function initPushTargetsIfNeeded() {
    try {
      // 1. 检查是否是导入后首次进入
      const isFirstEntry = await dataStore.isFirstEntryAfterImport()
      if (!isFirstEntry) return

      // 2. 获取上次导入时选中的工具
      const importedTools = dataStore.getLastImportedToolIds()

      // 3. 调用初始化方法
      await dataStore.initPushTargetsAfterImport(importedTools)

      // 4. 重置标记
      await dataStore.setFirstEntryAfterImport(false)

      // 5. 显示成功提示
      setToast({ message: '已根据导入选择初始化推送目标', type: 'success' })
    } catch (error) {
      console.error('Error initializing push targets:', error)
    }
  }

  /**
   * 导入完成后的回调：初始化推送目标并更新初始页面状态
   */
  const handleAfterImport = async () => {
    await initPushTargetsIfNeeded()
    setInitialSkillManagerPage('manage')
  }

  /**
   * 处理模块切换
   * @param {string} moduleId - 模块 ID
   */
  const handleModuleChange = (moduleId) => {
    setActiveModule(moduleId)
  }

  useEffect(() => {
    if (activeModule === 'mcp') {
      setHasVisitedMcp(true)
    }
  }, [activeModule])

  // 始终渲染 WorkbenchLayout；加载中时内容区显示 loading
  return (
    <div className="app">
      <WorkbenchLayout activeModule={activeModule} onModuleChange={handleModuleChange}>
        {activeModule === 'skills' && (
          initialSkillManagerPage === null
            ? <div className="manage-container"><div className="loading-state">加载中...</div></div>
            : <SkillManagerModule
                initialPage={initialSkillManagerPage}
                onAfterImport={handleAfterImport}
                refreshSignal={skillsRefreshSignal}
              />
        )}
        {(activeModule === 'mcp' || hasVisitedMcp) && (
          <div style={{ display: activeModule === 'mcp' ? 'block' : 'none', height: '100%' }}>
            <McpPage isActive={activeModule === 'mcp'} />
          </div>
        )}
        {activeModule === 'usage' && <UsageMonitorModule />}
        {activeModule === 'api' && <ApiConfigPage />}
        {activeModule === 'project-init' && <ProjectInitPage />}
        {activeModule === 'permission' && <PermissionModePage />}
      </WorkbenchLayout>

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
