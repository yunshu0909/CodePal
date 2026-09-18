/**
 * Claude Code 设置页面
 *
 * 负责：
 * - 默认权限模式：读取、弹出菜单选择即写入、托管覆盖提示
 * - 状态栏：接入状态与接入 / 接管、显示状态栏开关（开写 always、关写 off，阈值原样带回）
 * - 终端预览：固定示例数据示意终端底部效果
 *
 * 合并了原「启动模式」与「状态栏设置」两页；模块 ID 仍为 permission。
 * 设计事实源：specs/redesign-CodePal视觉重做/Claude设置-定稿/。
 *
 * @module pages/PermissionModePage
 */

import { useCallback, useEffect, useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Toast from '../components/Toast'
import Toggle from '../components/Toggle'
import ClaudeStatusLineTakeoverModal from './usage/components/ClaudeStatusLineTakeoverModal'
import useClaudeUsageStatus from './usage/useClaudeUsageStatus'
import PermissionModeSelect from './claudeSettings/PermissionModeSelect'
import TerminalPreview from './claudeSettings/TerminalPreview'
import {
  CONNECTED_STATES,
  SWITCH_ERROR_MESSAGES,
  findMode,
  integrationView,
  isStatusLineShown,
} from './claudeSettings/claudeSettings'
import './claudeSettings/claudeSettings.css'

/**
 * 默认权限模式的读取与写入
 * @param {(message: string, type: string) => void} notify - Toast 回调
 * @returns {object}
 */
function usePermissionMode(notify) {
  // 读取结果：mode 为 null 表示未配置；error 为读取失败
  const [perm, setPerm] = useState({ loading: true, error: false, mode: null })
  // 写入进行中：禁用弹出按钮，防重复写
  const [switching, setSwitching] = useState(false)
  // 托管覆盖提示：写入后得知，本次打开页面期间保留
  const [managedNotice, setManagedNotice] = useState(null)

  // 首次读取显示骨架；点「重试」重读时保持当前行内状态，不回到骨架
  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI.getPermissionModeConfig()
      if (result?.success) setPerm({ loading: false, error: false, mode: result.isConfigured ? result.mode : null })
      else setPerm({ loading: false, error: true, mode: null })
    } catch {
      setPerm({ loading: false, error: true, mode: null })
    }
  }, [])

  // 进页读取一次，不轮询、获焦不重读
  useEffect(() => { load() }, [load])

  const select = useCallback(async (mode) => {
    if (switching || mode === perm.mode) return
    setSwitching(true)
    try {
      const result = await window.electronAPI.setPermissionMode(mode)
      if (result?.success) {
        setPerm({ loading: false, error: false, mode })
        if (result.managedNotice) {
          // 写入成功但被托管配置覆盖：不能宣称「已切换」
          setManagedNotice(result.managedNotice)
          notify(result.managedNotice, 'error')
        } else {
          notify(`已切换至「${findMode(mode)?.name || mode}」`, 'success')
        }
      } else {
        notify(SWITCH_ERROR_MESSAGES[result?.errorCode] || result?.error || '切换失败', 'error')
      }
    } catch (err) {
      notify(err?.message || '切换失败，未知错误', 'error')
    } finally {
      setSwitching(false)
    }
  }, [notify, perm.mode, switching])

  return { perm, switching, managedNotice, reload: load, select }
}

/**
 * @returns {JSX.Element}
 */
export default function PermissionModePage() {
  // Toast：key 递增让同文案也能重新出现
  const [toast, setToast] = useState(null)
  // 接管确认弹窗
  const [takeoverOpen, setTakeoverOpen] = useState(false)
  const notify = useCallback((message, type) => setToast({ message, type, key: Date.now() }), [])
  const closeToast = useCallback(() => setToast(null), [])

  const { perm, switching, managedNotice, reload: reloadPerm, select } = usePermissionMode(notify)
  const {
    statusState, loading: statusLoading, installing, saving, error: statusError,
    loadStatus, ensureInstalled, saveConfig,
  } = useClaudeUsageStatus()

  const integration = statusState?.integrationState || (statusError ? 'read_error' : null)
  const connected = CONNECTED_STATES.has(integration)
  const config = statusState?.config || {}
  const shown = connected && isStatusLineShown(config.displayMode)
  const view = integrationView(integration || 'read_error', { committed: statusState?.committed })

  const onToggle = useCallback(async (next) => {
    if (saving) return
    const ok = await saveConfig({
      displayMode: next ? 'always' : 'off',
      fiveHourThreshold: config.fiveHourThreshold ?? 70,
      sevenDayThreshold: config.sevenDayThreshold ?? 70,
    })
    notify(ok ? '显示设置已保存' : '保存失败，请重试', ok ? 'success' : 'error')
  }, [config.fiveHourThreshold, config.sevenDayThreshold, notify, saveConfig, saving])

  const onAction = useCallback(async (kind) => {
    if (kind === 'install') await ensureInstalled({ intent: 'explicit' })
    else if (kind === 'takeover') setTakeoverOpen(true)
    else await loadStatus()
  }, [ensureInstalled, loadStatus])

  const confirmTakeover = useCallback(async () => {
    const ok = await ensureInstalled({ force: true, intent: 'explicit' })
    notify(ok ? 'Claude statusLine 已由 CodePal 接管' : '接管失败，请检查配置权限后重试', ok ? 'success' : 'error')
    return ok
  }, [ensureInstalled, notify])

  const loading = perm.loading || (statusLoading && !statusState && !statusError)
  const mode = findMode(perm.mode)

  let modeDesc
  // 说明行单行省略，悬停给出全文
  const descLine = (text, tone = '') => <div className={`ds${tone ? ` ${tone}` : ''}`} title={text}>{text}</div>
  if (perm.error) modeDesc = descLine('无法读取当前配置', 'bad')
  else if (managedNotice) modeDesc = descLine(managedNotice, 'warn')
  else if (mode) modeDesc = descLine(mode.desc)
  else if (perm.mode) modeDesc = descLine('未知模式')
  else modeDesc = descLine('未配置 · 由 Claude 决定')

  return (
    <PageShell title="Claude Code 设置" className="cc-page">
      <div className="cc-scroll">
        {loading ? (
          <div data-testid="cc-skeleton">
            <div className="cc-card"><div className="cc-row"><span className="cc-sk" style={{ width: 110 }} /><span className="cc-sk" style={{ width: 128, height: 24 }} /></div></div>
            <div className="cc-gl">状态栏</div>
            <div className="cc-card">{[70, 80].map((w) => <div className="cc-row" key={w}><span className="cc-sk" style={{ width: w }} /><span className="cc-sk" style={{ width: 64, height: 20 }} /></div>)}</div>
            <div className="cc-gl">终端预览</div>
            <div className="cc-term sk" />
          </div>
        ) : (
          <>
            <div className="cc-card">
              <div className="cc-row">
                <div className="lf"><div className="lb">默认权限模式</div>{modeDesc}</div>
                {perm.error
                  ? <Button size="sm" className="cc-btn" onClick={reloadPerm}>重试</Button>
                  : <PermissionModeSelect mode={perm.mode} disabled={switching} onSelect={select} />}
              </div>
            </div>
            <div className="cc-gl">状态栏</div>
            <div className="cc-card">
              <div className="cc-row">
                <div className="lb">接入状态</div>
                <span className="cc-acts">
                  <span className={`cc-st ${view.tone}`}><i />{view.text}</span>
                  {view.action && (
                    <Button
                      size="sm"
                      variant={view.action.primary ? 'primary' : 'secondary'}
                      className="cc-btn"
                      disabled={installing}
                      onClick={() => onAction(view.action.kind)}
                    >
                      {installing && view.action.kind === 'install' ? '处理中...' : view.action.label}
                    </Button>
                  )}
                </span>
              </div>
              <div className={`cc-row${connected ? '' : ' dis'}`}>
                <div className="lb">显示状态栏</div>
                <Toggle checked={shown} disabled={!connected || saving} onChange={onToggle} />
              </div>
            </div>
            <div className="cc-gl">终端预览</div>
            <TerminalPreview mode={perm.error ? null : perm.mode} showStatusLine={shown} />
          </>
        )}
      </div>
      <ClaudeStatusLineTakeoverModal
        open={takeoverOpen}
        loading={installing}
        onClose={() => setTakeoverOpen(false)}
        onConfirm={confirmTakeover}
      />
      {toast && <Toast key={toast.key} message={toast.message} type={toast.type} onClose={closeToast} />}
    </PageShell>
  )
}
