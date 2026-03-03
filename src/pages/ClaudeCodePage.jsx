/**
 * Claude Code 管理页面
 *
 * 负责：
 * - 左右分栏布局（左=状态卡片，右=详情面板）
 * - 首次挂载并行检查版本/认证/网络
 * - 面板切换与状态编排
 * - Toast 反馈
 * - Keep-alive 语义（切走不重查）
 *
 * @module pages/ClaudeCodePage
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Toast from '../components/Toast'
import StatusCard from './claude-code/StatusCard'
import VersionPanel from './claude-code/VersionPanel'
import AuthPanel from './claude-code/AuthPanel'
import NetworkPanel from './claude-code/NetworkPanel'
import '../styles/claude-code-page.css'

/**
 * 格式化当前时间为 HH:mm:ss
 * @returns {string}
 */
function formatNow() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * Claude Code 管理页面
 * @param {Object} props
 * @param {boolean} [props.isActive=true] - 当前 Tab 是否激活
 * @returns {React.ReactElement}
 */
export default function ClaudeCodePage({ isActive = true }) {
  // 当前激活面板
  const [activePanel, setActivePanel] = useState('version')

  // 版本信息 { version, newVersion, alreadyLatest, doctorHealthy, doctorDetails }
  const [versionInfo, setVersionInfo] = useState(null)
  // 认证信息 { loggedIn, authMethod, plan, rawOutput }
  const [authInfo, setAuthInfo] = useState(null)
  // 网络信息 { overall, passCount, warnCount, failCount, checks }
  const [networkInfo, setNetworkInfo] = useState(null)

  // 操作锁状态
  const [updating, setUpdating] = useState(false)
  const [doctoring, setDoctoring] = useState(false)
  const [refreshingAuth, setRefreshingAuth] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [checkingNetwork, setCheckingNetwork] = useState(false)
  // 全部检查中
  const [checkingAll, setCheckingAll] = useState(false)

  // 更新错误
  const [updateError, setUpdateError] = useState(null)

  // 各项上次检查时间
  const [versionCheckTime, setVersionCheckTime] = useState(null)
  const [authCheckTime, setAuthCheckTime] = useState(null)
  const [networkCheckTime, setNetworkCheckTime] = useState(null)

  // CLI 未安装标记
  const [cliNotInstalled, setCliNotInstalled] = useState(false)

  // Toast 提示
  const [toast, setToast] = useState(null)

  // 是否已完成首次加载
  const hasInitRef = useRef(false)

  /**
   * 显示 Toast
   * @param {string} message - 消息内容
   * @param {'info'|'success'|'error'|'warning'} type - 类型
   */
  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type })
  }, [])

  // ─── 版本检查 ───
  const fetchVersion = useCallback(async () => {
    try {
      const result = await window.electronAPI.claudeCode.getVersion()
      if (!result.success) {
        if (result.errorCode === 'NOT_INSTALLED') {
          setCliNotInstalled(true)
          return
        }
        if (result.errorCode === 'TIMEOUT') showToast('版本检查超时', 'warning')
        return
      }
      setCliNotInstalled(false)
      setVersionInfo(prev => ({ ...prev, version: result.version }))
      setVersionCheckTime(formatNow())
    } catch (err) {
      showToast(`版本检查失败: ${err.message}`, 'error')
    }
  }, [showToast])

  // ─── 检查更新 ───
  const handleCheckUpdate = useCallback(async () => {
    if (updating) return
    setUpdating(true)
    setUpdateError(null)
    try {
      const result = await window.electronAPI.claudeCode.checkUpdate()
      if (!result.success) {
        setUpdateError(result.error || '更新失败')
        showToast(`更新失败: ${result.error}`, 'error')
        return
      }
      if (result.alreadyLatest) {
        setVersionInfo(prev => ({ ...prev, alreadyLatest: true, newVersion: null }))
        showToast('已是最新版本', 'success')
      } else if (result.updated) {
        setVersionInfo(prev => ({
          ...prev,
          version: result.newVersion || prev?.version,
          newVersion: null,
          alreadyLatest: true,
        }))
        showToast(`已更新到 v${result.newVersion || '最新'}`, 'success')
      } else if (result.newVersion) {
        setVersionInfo(prev => ({ ...prev, newVersion: result.newVersion, alreadyLatest: false }))
        showToast(`发现新版本 v${result.newVersion}`, 'info')
      }
      setVersionCheckTime(formatNow())
    } catch (err) {
      setUpdateError(err.message)
      showToast(`更新失败: ${err.message}`, 'error')
    } finally {
      setUpdating(false)
    }
  }, [updating, showToast])

  // ─── Doctor 检查 ───
  const handleDoctor = useCallback(async () => {
    if (doctoring) return
    setDoctoring(true)
    try {
      const result = await window.electronAPI.claudeCode.doctor()
      if (!result.success) {
        showToast(`Doctor 检查失败: ${result.error}`, 'error')
        return
      }
      setVersionInfo(prev => ({
        ...prev,
        doctorHealthy: result.healthy,
        doctorDetails: result.details,
      }))
      if (result.healthy) {
        showToast('更新器状态正常', 'success')
      } else {
        showToast('更新器存在异常，请查看详情', 'warning')
      }
    } catch (err) {
      showToast(`Doctor 检查失败: ${err.message}`, 'error')
    } finally {
      setDoctoring(false)
    }
  }, [doctoring, showToast])

  // ─── 认证状态 ───
  const fetchAuth = useCallback(async () => {
    try {
      const result = await window.electronAPI.claudeCode.authStatus()
      if (!result.success) {
        if (result.errorCode === 'NOT_INSTALLED') {
          setCliNotInstalled(true)
          return
        }
        if (result.errorCode === 'TIMEOUT') showToast('认证检查超时', 'warning')
        return
      }
      setAuthInfo({
        loggedIn: result.loggedIn,
        authMethod: result.authMethod,
        plan: result.plan,
        rawOutput: result.rawOutput,
      })
      setAuthCheckTime(formatNow())
    } catch (err) {
      showToast(`认证检查失败: ${err.message}`, 'error')
    }
  }, [showToast])

  // ─── 刷新认证 ───
  const handleRefreshAuth = useCallback(async () => {
    if (refreshingAuth) return
    setRefreshingAuth(true)
    await fetchAuth()
    setRefreshingAuth(false)
  }, [refreshingAuth, fetchAuth])

  // ─── 重新登录 ───
  const handleLogin = useCallback(async () => {
    if (loggingIn) return
    setLoggingIn(true)
    try {
      const result = await window.electronAPI.claudeCode.authLogin()
      if (result.success) {
        showToast('已发起登录，请在浏览器中完成', 'info')
      } else {
        showToast(`登录发起失败: ${result.error}`, 'error')
      }
    } catch (err) {
      showToast(`登录发起失败: ${err.message}`, 'error')
    } finally {
      setLoggingIn(false)
    }
  }, [loggingIn, showToast])

  // ─── 网络检查 ───
  const fetchNetwork = useCallback(async () => {
    try {
      const result = await window.electronAPI.claudeCode.networkCheck()
      if (!result.success) {
        if (result.errorCode === 'SCRIPT_NOT_FOUND') {
          setNetworkInfo({ overall: null, checks: [], scriptMissing: true })
          showToast('诊断脚本不存在，请配置脚本路径', 'warning')
          return
        }
        if (result.errorCode === 'PERMISSION_DENIED') {
          showToast('诊断脚本无执行权限，请运行 chmod +x', 'warning')
          return
        }
        if (result.errorCode === 'TIMEOUT') {
          showToast('网络诊断超时', 'warning')
          return
        }
        showToast(`网络诊断失败: ${result.error}`, 'error')
        return
      }
      setNetworkInfo({
        overall: result.overall,
        passCount: result.passCount,
        warnCount: result.warnCount,
        failCount: result.failCount,
        checks: result.checks,
      })
      setNetworkCheckTime(formatNow())
    } catch (err) {
      showToast(`网络诊断失败: ${err.message}`, 'error')
    }
  }, [showToast])

  // ─── 重新检查网络 ───
  const handleCheckNetwork = useCallback(async () => {
    if (checkingNetwork) return
    setCheckingNetwork(true)
    await fetchNetwork()
    setCheckingNetwork(false)
  }, [checkingNetwork, fetchNetwork])

  // ─── 全部检查 ───
  const handleCheckAll = useCallback(async () => {
    if (checkingAll) return
    setCheckingAll(true)
    // 并行执行三项检查
    await Promise.allSettled([fetchVersion(), fetchAuth(), fetchNetwork()])
    setCheckingAll(false)
    showToast('检查完成', 'success')
  }, [checkingAll, fetchVersion, fetchAuth, fetchNetwork, showToast])

  // ─── 首次挂载自动检查 ───
  useEffect(() => {
    if (hasInitRef.current) return
    hasInitRef.current = true
    handleCheckAll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 状态卡片数据派生 ───
  const versionStatus = cliNotInstalled ? 'error'
    : !versionInfo ? 'loading'
    : versionInfo.alreadyLatest ? 'ok'
    : versionInfo.newVersion ? 'warn'
    : 'ok'

  const versionValue = cliNotInstalled ? '未安装'
    : versionInfo?.version ? `v${versionInfo.version}` : '检查中...'

  const versionDesc = cliNotInstalled ? '请安装 Claude Code CLI'
    : versionInfo?.alreadyLatest ? '已是最新'
    : versionInfo?.newVersion ? `可更新到 v${versionInfo.newVersion}`
    : ''

  const authStatus = cliNotInstalled ? 'error'
    : !authInfo ? 'loading'
    : authInfo.loggedIn ? 'ok' : 'error'

  const authValue = cliNotInstalled ? '未安装'
    : authInfo?.loggedIn === true ? '已登录'
    : authInfo?.loggedIn === false ? '未登录'
    : '检查中...'

  const authDesc = cliNotInstalled ? ''
    : authInfo?.authMethod === 'oauth' ? 'OAuth 认证'
    : authInfo?.authMethod === 'api_key' ? 'API Key'
    : ''

  const networkStatus = cliNotInstalled ? 'unknown'
    : !networkInfo ? 'loading'
    : networkInfo.scriptMissing ? 'unknown'
    : networkInfo.overall === 'pass' ? 'ok'
    : networkInfo.overall === 'warn' ? 'warn'
    : networkInfo.overall === 'fail' ? 'error'
    : 'unknown'

  const networkTotal = networkInfo
    ? (networkInfo.passCount || 0) + (networkInfo.warnCount || 0) + (networkInfo.failCount || 0)
    : 0

  const networkValue = cliNotInstalled ? '—'
    : networkInfo?.scriptMissing ? '未配置'
    : networkInfo?.overall ? `${networkInfo.passCount || 0}/${networkTotal} PASS`
    : '检查中...'

  const networkDesc = cliNotInstalled ? ''
    : networkInfo?.overall === 'pass' ? '环境正常'
    : networkInfo?.overall === 'warn' ? '存在风险'
    : networkInfo?.overall === 'fail' ? '存在异常'
    : networkInfo?.scriptMissing ? '需配置脚本'
    : ''

  return (
    <PageShell
      title="Claude Code 环境检查"
      subtitle="版本 · 认证 · 网络"
      className="page-shell--no-padding"
      actions={
        <Button
          variant="secondary"
          size="sm"
          loading={checkingAll}
          onClick={handleCheckAll}
        >
          全部检查
        </Button>
      }
    >
      {/* CLI 未安装引导 */}
      {cliNotInstalled && (
        <div className="claude-code-layout">
          <div className="not-installed-guide" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div className="not-installed-guide-icon">💻</div>
            <div className="not-installed-guide-title">未检测到 Claude Code CLI</div>
            <div className="not-installed-guide-desc">
              请先安装 Claude Code，然后返回此页面进行管理。
              <br />
              安装命令：<code style={{ background: 'var(--bg-muted)', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>npm install -g @anthropic-ai/claude-code</code>
            </div>
          </div>
        </div>
      )}

      {/* 正常内容：左右分栏 */}
      {!cliNotInstalled && (
        <div className="claude-code-layout">
          {/* 左栏：状态卡片 */}
          <aside className="claude-code-sidebar">
            <StatusCard
              title="版本"
              status={versionStatus}
              value={versionValue}
              desc={versionDesc}
              active={activePanel === 'version'}
              onClick={() => setActivePanel('version')}
            />
            <StatusCard
              title="认证"
              status={authStatus}
              value={authValue}
              desc={authDesc}
              active={activePanel === 'auth'}
              onClick={() => setActivePanel('auth')}
            />
            <StatusCard
              title="网络"
              status={networkStatus}
              value={networkValue}
              desc={networkDesc}
              active={activePanel === 'network'}
              onClick={() => setActivePanel('network')}
            />
          </aside>

          {/* 右栏：详情面板 */}
          <main className="claude-code-detail">
            {activePanel === 'version' && (
              <VersionPanel
                versionInfo={versionInfo}
                updating={updating}
                doctoring={doctoring}
                updateError={updateError}
                onCheckUpdate={handleCheckUpdate}
                onDoctor={handleDoctor}
                lastCheckTime={versionCheckTime}
              />
            )}
            {activePanel === 'auth' && (
              <AuthPanel
                authInfo={authInfo}
                refreshing={refreshingAuth}
                loggingIn={loggingIn}
                onRefresh={handleRefreshAuth}
                onLogin={handleLogin}
                lastCheckTime={authCheckTime}
              />
            )}
            {activePanel === 'network' && (
              <NetworkPanel
                networkInfo={networkInfo}
                checking={checkingNetwork}
                onCheck={handleCheckNetwork}
                lastCheckTime={networkCheckTime}
              />
            )}
          </main>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </PageShell>
  )
}
