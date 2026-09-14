/**
 * Harness 管理页
 *
 * 负责：
 * - 展示 DeepSeek Harness（dsh）的安装、版本与运行状态
 * - 提供安装、升级、启动、停止、重启、卸载，以及自动重启偏好
 *
 * 页面模型：一个实体、三种状态，骨架固定不变。
 * - 未安装 / 已停止 / 运行中，只换内容与「主动词」，结构永不变形
 * - 按钮遵循全站规则：header 最多两个页面级按钮（主动词 + 刷新）；
 *   重启 / 停止是实体动作，贴在状态总览条右端（K28 音频条同款）
 *
 * 启停一律交给「当前守护者」：有 launchd 服务走 launchctl，否则 CodePal 自己 spawn。
 * 直接 kill 一个 KeepAlive 的服务会被立刻拉起，表现为「停了但还活着」。
 *
 * 边界：不读取 ~/.dsh 内的任何配置或凭证。
 *
 * @module pages/HarnessPage
 */

import { useCallback, useEffect, useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import StateView from '../components/StateView/StateView'
import Modal from '../components/Modal/Modal'
import Tag from '../components/Tag/Tag'
import Toggle from '../components/Toggle'
import Toast from '../components/Toast'
import useHarnessControl from '../hooks/useHarnessControl'
import '../styles/harness.css'

/** 更新通道 → 中文短名 */
const CHANNEL_LABEL = { latest: '稳定', next: '预览' }

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

/** 长路径收成 `…/末两段`，完整值留在 title 里，避免把状态条撑破 */
function shortenPath(value) {
  if (typeof value !== 'string' || value === '') return ''
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= 3) return value
  return `…/${parts.slice(-2).join('/')}`
}

export default function HarnessPage() {
  const { status, snapshot, error, pendingKeys, urlRef, refresh, checkVersions, execute } = useHarnessControl()
  const [toast, setToast] = useState(null)
  const [channel, setChannel] = useState('latest')
  const [takeoverOpen, setTakeoverOpen] = useState(false)
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [purgeData, setPurgeData] = useState(false)
  const [copied, setCopied] = useState(false)

  const runAction = useCallback(async (action, params, messages) => {
    const result = await execute(action, params)
    if (result.success) {
      setToast({ type: 'success', message: messages.success })
    } else {
      setToast({ type: 'error', message: errorText(result.error) })
    }
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
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setToast({ type: 'error', message: '复制失败，请手动选择地址' })
    }
  }, [urlRef])

  const install = snapshot?.install
  const runtime = snapshot?.runtime
  const supervisor = snapshot?.supervisor
  const node = snapshot?.node
  const registry = snapshot?.registry
  const running = Boolean(runtime?.running)
  const managed = install?.kind === 'managed'
  const underLaunchd = supervisor?.kind === 'launchd'
  const notInstalled = install?.kind === 'none' && !running
  const platformOk = snapshot?.supportedPlatform !== false

  const channelVersion = registry?.channels?.[channel] || null
  /** 升级判定由主进程算好；只有已装托管版才谈升级 */
  const upgradeTarget = managed && install?.version ? registry?.upgradeTargets?.[channel] || null : null
  const canSwitchChannel = Boolean(managed && install?.version && channelVersion && channelVersion !== install.version && !upgradeTarget)

  // 源码目录的更新判定走 git，不走 npm 通道
  const source = snapshot?.source
  const sourceDirty = install?.kind === 'source' && (source?.dirty || 0) > 0
  const sourceBehind = install?.kind === 'source' && typeof source?.behind === 'number' ? source.behind : null
  const hasSourceUpdate = sourceBehind !== null && sourceBehind > 0
  const canTakeOver = install?.kind === 'source'
    && platformOk
    && node?.supported === true
    && (!source?.updatable || sourceDirty)

  /** 状态总览条：语义色只来自 9px 状态点（K28 同款） */
  const tone = notInstalled ? 'danger' : running ? 'success' : 'idle'
  const stateLabel = notInstalled ? '未安装' : running ? '运行中' : '已停止'
  const whereFull = managed ? install?.runtimeDir : install?.kind === 'path' ? install?.pathBinary : install?.sourceDir
  const whereText = managed ? 'CodePal 安装' : shortenPath(whereFull || '')
  /** 能被 CodePal 控制才给重启/停止——手动在终端跑起来的实例不归我们管 */
  const controllable = running && (underLaunchd || runtime?.mode === 'sidecar')
  const manualExternal = running && !controllable
  /** 指标区有内容才渲染，否则会留下一条悬空的分隔线（未安装态就是这样） */
  const showMetrics = Boolean(
    install?.version
    || (running && (runtime?.port || runtime?.pid || runtime?.url))
    || (node?.available && !node.supported),
  )

  const fatalError = status === 'error'
    ? <><strong>Harness 状态读取失败</strong><br /><span>没有安装或修改任何东西</span></>
    : null
  const emptyMachine = status === 'ready' && notInstalled && !node?.available

  const doInstall = useCallback((force) => runAction('install', { channel, force: force === true }, {
    success: `已安装 ${CHANNEL_LABEL[channel]}通道的 DeepSeek Harness`,
  }), [channel, runAction])

  /** header 主动词：未安装→安装，已停止→启动，运行中→打开界面 */
  const primary = notInstalled
    ? { label: '安装 DeepSeek Harness', loading: pendingKeys.has(`install:${channel}`), disabled: !install?.canInstall || !platformOk, onClick: () => doInstall(true) }
    : running
      ? { label: '打开界面', loading: false, disabled: !runtime?.url, onClick: openUi }
      : { label: '启动', loading: pendingKeys.has('start'), disabled: !install?.canInstall || !platformOk, onClick: () => runAction('start', {}, { success: 'DeepSeek Harness 已启动，正在打开界面' }).then((result) => { if (result.success) void openUi() }) }

  return (
    <PageShell
      title="Harness 管理"
      subtitle="安装、升级、启停 DeepSeek Harness"
      className="page-shell--no-padding harness-page"
      actions={(
        <>
          <Button variant="primary" size="sm" loading={primary.loading} disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</Button>
          <Button variant="secondary" size="sm" onClick={refresh}>刷新</Button>
        </>
      )}
    >
      <StateView
        loading={status === 'loading'}
        loadingMessage="正在读取 DeepSeek Harness 状态"
        error={fatalError}
        onRetry={refresh}
        empty={emptyMachine}
        emptyMessage="这台机器上没有可用的 Node"
        emptyHint={node?.version ? `当前 ${node.version}，DeepSeek Harness 需要 ${node.required}` : '请先安装 Node 22.19+ 或 24+，再回到这一页安装'}
      >
        <>
          {/* 状态总览条 */}
          <div className="harness-statusbar">
            <div className="harness-statusbar__lead">
              <span className={`harness-statusbar__dot harness-statusbar__dot--${tone}`} />
              <span className="harness-statusbar__state">{stateLabel}</span>
              {whereText && <span className="harness-statusbar__where" title={whereFull || ''}>{whereText}</span>}
            </div>
            {showMetrics && <div className="harness-statusbar__divider" />}
            <div className="harness-statusbar__metrics">
              {install?.version && (
                <div className="harness-metric"><span className="harness-metric__label">版本</span><span className="harness-metric__value harness-metric__value--mono">{install.version}</span></div>
              )}
              {running && runtime?.port && (
                <div className="harness-metric"><span className="harness-metric__label">端口</span><span className="harness-metric__value harness-metric__value--mono">{runtime.port}</span></div>
              )}
              {running && runtime?.pid && (
                <div className="harness-metric"><span className="harness-metric__label">PID</span><span className="harness-metric__value harness-metric__value--mono">{runtime.pid}</span></div>
              )}
              {running && runtime?.url && (
                <div className="harness-metric">
                  <span className="harness-metric__label">地址</span>
                  <span className="harness-metric__value harness-metric__value--mono">{runtime.url}</span>
                  <Button variant="ghost" size="sm" onClick={copyUrl}>{copied ? '已复制' : '复制'}</Button>
                </div>
              )}
              {node?.available && !node.supported && (
                <div className="harness-metric">
                  <span className="harness-metric__label">Node</span>
                  <span className="harness-metric__value harness-metric__value--mono">{node.version}</span>
                  <Tag variant="warning">不满足</Tag>
                </div>
              )}
            </div>
            {controllable && (
              <div className="harness-statusbar__actions">
                <Button variant="secondary" size="sm" loading={pendingKeys.has('restart')} onClick={() => runAction('restart', {}, { success: '已重启，界面稍后可用' })}>重启</Button>
                <Button variant="secondary" size="sm" loading={pendingKeys.has('stop')} onClick={() => runAction('stop', {}, { success: '已停止 DeepSeek Harness' })}>停止</Button>
              </div>
            )}
          </div>

          {!platformOk && (
            <div className="harness-notice">当前系统（{snapshot?.platform}）暂不支持托管式启停：v1 只覆盖 macOS 与 Linux。</div>
          )}
          {manualExternal && (
            <div className="harness-notice">这个实例是在终端里手动启动的，CodePal 只能打开它，不能停止或重启它。</div>
          )}

          {notInstalled ? (
            /* 未安装：K28 InstallGuide 同款居中引导卡，不放版本/偏好卡 */
            <div className="harness-install">
              <div className="harness-install__title">尚未安装 DeepSeek Harness</div>
              <div className="harness-install__text">DeepSeek Harness 是 DeepSeek 的开源编程 agent，装好后在浏览器里用。点「安装」将完成：</div>
              <ul className="harness-install__steps">
                <li>下载发布包到 <span className="harness-code">{install?.runtimeDir}</span></li>
                <li>不写入全局 npm，不需要管理员权限</li>
                <li>装完即可在此启动、停止、升级、卸载</li>
              </ul>
              <Button variant="primary" loading={pendingKeys.has(`install:${channel}`)} disabled={!install?.canInstall || !platformOk} onClick={() => doInstall(true)}>安装 DeepSeek Harness</Button>
              <div className="harness-install__hint">
                {node?.supported
                  ? `需要 Node ${node.required}，已满足（${node.version}）；卸载即整目录删除，会话数据默认保留`
                  : `需要 Node ${node.required}，当前 ${node?.version || '未检测到'}——升级 Node 后即可安装`}
              </div>
            </div>
          ) : (
            <>
              {/* 版本卡 */}
              <div className="harness-card">
                <div className="harness-card__head">
                  <div className="harness-card__title">版本</div>
                  <Button variant="secondary" size="sm" loading={pendingKeys.has('versions')} onClick={checkVersions}>检查更新</Button>
                </div>
                <div className="harness-card__body">
                  <div className="harness-facts">
                    <div>
                      <span>当前版本</span>
                      <strong><span className="harness-code">{install?.version || '未知'}</span></strong>
                    </div>
                    {install?.kind === 'source' && (
                      <div>
                        <span>当前分支</span>
                        <strong>
                          <span className="harness-code">{source?.branch || '未知'}</span>
                          {source?.commit ? <span className="harness-note">{source.commit}</span> : null}
                        </strong>
                      </div>
                    )}
                    {/* 只有 CodePal 自己装的才有「通道 / 升级」这套 npm 概念；
                        其他安装方式给一句怎么更新就走，不摊分类标签也不需要死胡同 */}
                    {managed ? (
                      <>
                        <div>
                          <span>可用更新</span>
                          <strong>
                            {upgradeTarget ? (
                              <>
                                <span className="harness-code">{upgradeTarget}</span>
                                <Button variant="primary" size="sm" loading={pendingKeys.has(`install:${channel}`)} onClick={() => doInstall(true)}>升级</Button>
                              </>
                            ) : canSwitchChannel ? (
                              <>
                                <span className="harness-code">{channelVersion}</span>
                                <Button variant="secondary" size="sm" loading={pendingKeys.has(`install:${channel}`)} onClick={() => doInstall(true)}>重装</Button>
                                <span className="harness-note">与当前版本不同，重装即切换</span>
                              </>
                            ) : (
                              <>已是最新 <span className="harness-note">（{CHANNEL_LABEL[channel]}通道 {channelVersion || '未知'}）</span></>
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>更新通道</span>
                          <strong>
                            <div className="harness-channel" role="group" aria-label="版本通道">
                              <button type="button" className={channel === 'latest' ? 'is-active' : ''} onClick={() => setChannel('latest')}>稳定</button>
                              <button type="button" className={channel === 'next' ? 'is-active' : ''} onClick={() => setChannel('next')}>预览</button>
                              <span className="harness-note">{channelVersion || '未知'}</span>
                            </div>
                          </strong>
                        </div>
                      </>
                    ) : install?.kind === 'source' ? (
                      <div>
                        <span>可用更新</span>
                        <strong>
                          {!source?.updatable ? (
                            /* 本地分支在远端没有对应分支（如本地 release 分支）：
                               把远端默认分支合进来是另一回事，不能算更新，所以只给参考 */
                            <>
                              — 无法自动更新
                              <span className="harness-note harness-note--block">
                                {source?.upstream
                                  ? <>这个分支在远端没有对应分支；参考：<span className="harness-code">{source.upstream}</span> 领先 {source.behind ?? '未知'} 个提交</>
                                  : '这个仓库没有可用的远端分支'}
                              </span>
                            </>
                          ) : sourceBehind === null ? (
                            <>— <span className="harness-note">暂时无法检查远端</span></>
                          ) : hasSourceUpdate ? (
                            <>
                              <span className="harness-code">{sourceBehind} 个新提交</span>
                              <Button
                                variant="primary"
                                size="sm"
                                loading={pendingKeys.has('update')}
                                disabled={sourceDirty}
                                onClick={() => runAction('update', {}, { success: '已更新到最新代码并重新构建' })}
                              >
                                更新
                              </Button>
                              {sourceDirty && (
                                <span className="harness-note">先提交或暂存本地改动才能更新（CodePal 不动你的改动）</span>
                              )}
                            </>
                          ) : (
                            <>已是最新 <span className="harness-note">（{source?.branch || '当前分支'} @ {source?.commit || '未知'}）</span></>
                          )}
                          {canTakeOver && (
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={pendingKeys.has('update')}
                              onClick={() => setTakeoverOpen(true)}
                            >
                              交给 CodePal 管理
                            </Button>
                          )}
                        </strong>
                      </div>
                    ) : (
                      <div>
                        <span>更新方式</span>
                        <strong>用你自己的方式更新这份安装，再回到本页刷新</strong>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 偏好卡：同一时刻只可能有一个管事的守护者 */}
              {(underLaunchd || managed || runtime?.mode === 'sidecar') && (
                <div className="harness-card">
                  <div className="harness-card__head"><div className="harness-card__title">偏好</div></div>
                  <div className="harness-card__body">
                    <div className="harness-facts">
                      {underLaunchd ? (
                        <div>
                          <span>崩溃后自动重启</span>
                          <strong>
                            <Toggle
                              checked={supervisor?.keepAlive === true}
                              disabled={pendingKeys.has('setKeepAlive')}
                              onChange={(next) => runAction('setKeepAlive', { enabled: next }, {
                                success: next ? '已开启崩溃自动重启' : '已关闭崩溃自动重启',
                              })}
                            />
                            <span className="harness-note">进程意外退出时由系统服务自动拉起</span>
                          </strong>
                        </div>
                      ) : (
                        <div>
                          <span>退出 CodePal 时一并停止</span>
                          <strong>
                            <Toggle
                              checked={snapshot?.stopOnQuit !== false}
                              disabled={pendingKeys.has('setStopOnQuit')}
                              onChange={(next) => runAction('setStopOnQuit', { enabled: next }, {
                                success: next ? '退出时会一并停止 dsh' : '退出时保留 dsh 继续运行',
                              })}
                            />
                            <span className="harness-note">关掉后继续在后台跑，下次启动 CodePal 仍能接管</span>
                          </strong>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {install?.canUninstall && (
                <div className="harness-danger-row">
                  <span>卸载 DeepSeek Harness</span>
                  <Button variant="danger" size="sm" onClick={() => setUninstallOpen(true)}>卸载</Button>
                </div>
              )}
            </>
          )}

          {error && status === 'ready' && <div className="harness-notice">{errorText(error)}</div>}
        </>
      </StateView>

      <Modal
        open={takeoverOpen}
        onClose={() => setTakeoverOpen(false)}
        title="交给 CodePal 管理"
        size="sm"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setTakeoverOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={pendingKeys.has('update')}
              onClick={async () => {
                const result = await runAction('update', { takeover: true }, {
                  success: '已切换到 CodePal 托管运行时，源码与 ~/.dsh 保持不变',
                })
                if (result.success) setTakeoverOpen(false)
              }}
            >
              确认接管
            </Button>
          </>
        )}
      >
        <div className="harness-takeover">
          <p>CodePal 会另装一份托管运行时，保留你的源码目录，不会提交、暂存或删除其中任何文件。</p>
          <ul>
            <li>保留 ~/.dsh 中的会话、凭证与模型配置</li>
            <li>只安装不低于当前源码版的 npm 版本，避免降级</li>
            <li>备份并切换现有 launchd 启动项；失败时自动恢复原服务</li>
          </ul>
        </div>
      </Modal>

      <Modal
        open={uninstallOpen}
        onClose={() => { setUninstallOpen(false); setPurgeData(false) }}
        title="卸载 DeepSeek Harness"
        size="sm"
        footer={(
          <>
            <Button variant="secondary" onClick={() => { setUninstallOpen(false); setPurgeData(false) }}>取消</Button>
            <Button
              variant="danger"
              loading={pendingKeys.has('uninstall')}
              onClick={async () => {
                const result = await runAction('uninstall', { purgeData }, {
                  success: purgeData ? '已卸载，并清除了 ~/.dsh' : '已卸载，会话历史与凭证保留在 ~/.dsh',
                })
                if (result.success) {
                  setUninstallOpen(false)
                  setPurgeData(false)
                }
              }}
            >
              确认卸载
            </Button>
          </>
        )}
      >
        <div className="harness-uninstall">
          <p>
            {install?.kind === 'source'
              ? '将停止它并移除 CodePal 的启动项（原文件会先备份），不会删除你的源码目录。'
              : '将删除 CodePal 安装的 DeepSeek Harness，运行中的实例会先被停止。'}
          </p>
          <label className="harness-uninstall__purge">
            <Toggle checked={purgeData} onChange={setPurgeData} />
            <span>
              <strong>同时清除 ~/.dsh</strong>
              <span>会话历史、凭证与模型配置会一起删除，不可恢复。默认保留。</span>
            </span>
          </label>
        </div>
      </Modal>

      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </PageShell>
  )
}
