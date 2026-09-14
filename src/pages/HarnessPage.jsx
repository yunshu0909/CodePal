/**
 * Harness 管理页
 *
 * 负责：
 * - 展示 DeepSeek Harness（dsh）的运行与安装状态，提供安装、升级、启停、更新、转为托管、卸载
 * - 页面 = PageShell（默认内边距）+ 两张卡：运行卡（此刻谁在跑）与安装卡（装在哪、什么版本）
 *
 * 显示规则全部在 harness/harnessView.js；本组件只接事件、调主进程、给 Toast。
 * 按钮背后的主进程操作与 v1 完全相同；首次加载与读取失败才走整页 StateView。
 *
 * 边界：不渲染一次性 token，不读取 ~/.dsh 内的任何配置或凭证。
 *
 * @module pages/HarnessPage
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import StateView from '../components/StateView/StateView'
import Toast from '../components/Toast'
import useHarnessControl from '../hooks/useHarnessControl'
import { buildHarnessView, CHANNEL_LABEL } from './harness/harnessView'
import HarnessRunPanel from './harness/HarnessRunPanel'
import HarnessInstallPanel from './harness/HarnessInstallPanel'
import { TakeoverDialog, UninstallDialog } from './harness/HarnessDialogs'
import '../styles/harness.css'

/** 错误码 → 用户可读说明；不透传任何原始 stderr */
const ERROR_TEXT = {
  HARNESS_NOT_INSTALLED: '尚未安装 DeepSeek Harness',
  HARNESS_NODE_UNSUPPORTED: 'Node 版本不满足要求，请先升级 Node',
  HARNESS_MANAGED_ONLY: '这个实例不归 CodePal 管，不能从这停止它',
  HARNESS_SPAWN_FAILED: '启动失败，进程没有正常运行起来',
  HARNESS_START_TIMEOUT: '启动超时，已停止本次尝试',
  HARNESS_NPM_FAILED: '安装命令执行失败，请检查网络与 npm 配置',
  HARNESS_ALREADY_RUNNING: '已经有一个实例在运行',
  HARNESS_NOT_RUNNING: '当前没有正在运行的实例',
  HARNESS_OP_NOT_ALLOWED: '该操作不被允许',
  HARNESS_PORT_UNKNOWN: '拿不到监听端口',
  HARNESS_UNKNOWN_ERROR: '操作失败，未做任何修改',
  LAUNCHD_START_FAILED: 'launchd 启动失败，请检查服务是否被系统策略拦截',
  LAUNCHD_STOP_FAILED: 'launchd 停止失败',
  PLIST_MISSING: '找不到 launchd 服务文件',
  PLIST_WRITE_FAILED: '写入 launchd 服务文件失败',
  SOURCE_NOT_A_REPO: '源码目录不是 git 仓库，无法自动更新',
  SOURCE_DIRTY: '源码目录有未提交改动，先提交或暂存后再更新',
  SOURCE_NO_UPSTREAM: '源码目录没有配置远端分支，无法自动更新',
  SOURCE_FETCH_FAILED: '拉取远端失败，请检查网络',
  SOURCE_PULL_FAILED: '合并失败（本地与远端可能已分叉），未做任何改动',
  SOURCE_INSTALL_FAILED: '依赖安装失败，已回滚到更新前的版本',
  SOURCE_BUILD_FAILED: '构建失败，已回滚到更新前的版本',
  SOURCE_PNPM_MISSING: '找不到 pnpm，源码版构建需要它',
  HARNESS_TAKEOVER_VERSION_UNAVAILABLE: 'npm 上没有不低于当前源码版的版本，未做任何修改',
  HARNESS_TAKEOVER_REQUIRES_STOP: '这个源码实例由外部进程运行，请先在原位置停止后再接管',
  HARNESS_TAKEOVER_FAILED: '接管失败，已恢复原启动项并保留源码与数据',
  LAUNCHD_REPOINT_FAILED: '切换 launchd 入口失败，已恢复原服务',
  API_NOT_AVAILABLE: '主进程接口不可用，请重启 CodePal',
}

function errorText(code) {
  return ERROR_TEXT[code] || ERROR_TEXT.HARNESS_UNKNOWN_ERROR
}

export default function HarnessPage() {
  const { status, snapshot, refreshing, pendingKeys, urlRef, refresh, execute } = useHarnessControl()
  const [toast, setToast] = useState(null)
  const [channel, setChannel] = useState('latest')
  const [dialog, setDialog] = useState(null)
  const [purgeData, setPurgeData] = useState(false)
  const [copied, setCopied] = useState(false)

  const view = useMemo(
    () => (snapshot ? buildHarnessView(snapshot, { channel, pendingKeys, copied }) : null),
    [snapshot, channel, pendingKeys, copied],
  )

  const runAction = useCallback(async (action, params, success) => {
    const result = await execute(action, params)
    setToast(result.success ? { type: 'success', message: success } : { type: 'error', message: errorText(result.error) })
    return result
  }, [execute])

  const openUi = useCallback(async () => {
    const url = urlRef.current
    if (!url) {
      setToast({ type: 'warning', message: '还没有可打开的地址，请先启动' })
      return
    }
    const result = await window.electronAPI?.openExternalLink?.(url)
    if (!result?.success) setToast({ type: 'error', message: '打开浏览器失败' })
  }, [urlRef])

  const copyUrl = useCallback(async () => {
    const url = urlRef.current
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setToast({ type: 'error', message: '复制失败，请手动选择地址' })
    }
  }, [urlRef])

  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const onRefresh = useCallback(async () => {
    const result = await refresh()
    if (!result.success && result.error !== 'STALE_REQUEST' && status === 'ready') {
      setToast({ type: 'error', message: 'Harness 状态读取失败，没有安装或修改任何东西' })
    }
  }, [refresh, status])

  const closeDialog = useCallback(() => {
    setDialog(null)
    setPurgeData(false)
  }, [])

  const install = useCallback(() => runAction('install', { channel, force: true }, `已安装${CHANNEL_LABEL[channel]}通道的 DeepSeek Harness`), [channel, runAction])

  const onPrimary = useCallback(async () => {
    if (!view?.primary) return
    if (view.primary.action === 'install') return install()
    if (view.primary.action === 'open') return openUi()
    const result = await runAction('start', {}, 'DeepSeek Harness 已启动，正在打开界面')
    if (result.success) await openUi()
  }, [install, openUi, runAction, view])

  /** 卡片里所有按钮与开关的统一出口 */
  const onAction = useCallback((key, params) => {
    switch (key) {
      case 'channel': return setChannel(params.channel)
      case 'copy': return copyUrl()
      case 'restart': return runAction('restart', {}, '已重启，界面稍后可用')
      case 'stop': return runAction('stop', {}, '已停止 DeepSeek Harness')
      case 'upgrade': return install()
      case 'update': return runAction('update', {}, '已更新到最新代码并重新构建')
      case 'takeover': return setDialog('takeover')
      case 'uninstall': return setDialog('uninstall')
      case 'setKeepAlive': return runAction('setKeepAlive', params, params.enabled ? '已开启崩溃自动重启' : '已关闭崩溃自动重启')
      case 'setStopOnQuit': return runAction('setStopOnQuit', params, params.enabled ? '退出时会一并停止 dsh' : '退出时保留 dsh 继续运行')
      default: return undefined
    }
  }, [copyUrl, install, runAction])

  const confirmTakeover = useCallback(async () => {
    const result = await runAction('update', { takeover: true }, '已切换到 CodePal 托管运行时，源码与 ~/.dsh 保持不变')
    if (result.success) closeDialog()
  }, [closeDialog, runAction])

  const confirmUninstall = useCallback(async () => {
    const result = await runAction('uninstall', { purgeData }, purgeData ? '已卸载，并清除了 ~/.dsh' : '已卸载，会话历史与凭证保留在 ~/.dsh')
    if (result.success) closeDialog()
  }, [closeDialog, purgeData, runAction])

  const ready = status === 'ready' && view
  const primary = ready ? view.primary : null

  return (
    <PageShell
      title="Harness 管理"
      subtitle="安装、升级、启停 DeepSeek Harness"
      actions={(
        <>
          {primary && (
            <Button variant="primary" size="sm" loading={primary.loading} disabled={primary.disabled} onClick={onPrimary}>
              {primary.label}
            </Button>
          )}
          <Button variant="secondary" size="sm" loading={refreshing} onClick={onRefresh}>刷新</Button>
        </>
      )}
    >
      <StateView
        loading={status === 'loading'}
        loadingMessage="正在读取 DeepSeek Harness 状态"
        error={status === 'error' ? <><strong>Harness 状态读取失败</strong><br /><span>没有安装或修改任何东西</span></> : null}
        onRetry={refresh}
      >
        {ready && (
          <div className="harness">
            <HarnessRunPanel run={view.run} onAction={onAction} />
            <HarnessInstallPanel install={view.install} onAction={onAction} />
          </div>
        )}
      </StateView>

      <TakeoverDialog
        open={dialog === 'takeover'}
        version={view?.takeoverVersion}
        loading={pendingKeys.has('update')}
        onCancel={closeDialog}
        onConfirm={confirmTakeover}
      />
      <UninstallDialog
        open={dialog === 'uninstall'}
        kind={view?.uninstallKind}
        purgeData={purgeData}
        loading={pendingKeys.has('uninstall')}
        onTogglePurge={() => setPurgeData((value) => !value)}
        onCancel={closeDialog}
        onConfirm={confirmUninstall}
      />

      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </PageShell>
  )
}
