/**
 * 会话状态页（#41，取代原「状态灯」）
 *
 * 负责：
 * - 总开关「会话状态」（默认开）：打开 = 装钩子，关掉 = 删钩子并清空；点即生效，无确认
 * - 检测到的工具；某一边钩子没装上时写原因 + 重试
 * - 会话列表：状态文件一变就实时更新；等你确认 → 进行中 → 完成了
 * - 告诉主进程本页在前台（在前台时不弹系统通知）
 *
 * 设计事实源：specs/状态提醒重做/（状态清单草案 + _review/04 交互流程）
 *
 * @module pages/SessionStatusPage
 */

import { useCallback, useEffect, useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Toggle from '../components/Toggle'
import { toast } from '../components/Toast'
import { STATE_TAG, describeSession, describeTools, formatSessionTime } from './sessionStatus/sessionStatusView'
import './sessionStatus/sessionStatus.css'

/**
 * @returns {JSX.Element}
 */
export default function SessionStatusPage() {
  // 主进程快照：enabled / tools / failures / sessions / total / error
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  // 开关正在装 / 删钩子
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // 每 30 秒重渲染一次，让「3 分钟」这类时间往前走
  const [, setTick] = useState(0)

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI.getSessionStatus()
      if (result?.success) {
        setData(result.data)
        setLoadError(null)
      } else {
        setLoadError(result?.error || '读取失败')
      }
    } catch (error) {
      setLoadError(error?.message || '读取失败')
    }
  }, [])

  useEffect(() => {
    load()
    const api = window.electronAPI
    api.setSessionStatusPageVisible?.(true)
    const off = api.onSessionStatusChanged?.((payload) => {
      setData((prev) => (prev ? { ...prev, sessions: payload.sessions, total: payload.total, error: payload.error } : prev))
    })
    const timer = setInterval(() => setTick((n) => n + 1), 30000)
    return () => {
      api.setSessionStatusPageVisible?.(false)
      off?.()
      clearInterval(timer)
    }
  }, [load])

  const onToggle = useCallback(async (next) => {
    if (saving) return
    setSaving(true)
    try {
      const result = await window.electronAPI.setSessionStatusEnabled(next)
      if (result?.success) {
        setData(result.data)
        toast.success(next ? '已打开会话状态' : '已关闭会话状态')
      } else {
        toast.error(`${next ? '打开' : '关闭'}失败：${result?.error || '未知原因'}`)
      }
    } catch (error) {
      toast.error(`${next ? '打开' : '关闭'}失败：${error?.message || '未知原因'}`)
    } finally {
      setSaving(false)
    }
  }, [saving])

  const onRetry = useCallback(async () => {
    setRetrying(true)
    try {
      const result = await window.electronAPI.retrySessionStatus()
      if (result?.success) setData(result.data)
    } finally {
      setRetrying(false)
    }
  }, [])

  return (
    <PageShell title="会话状态" native className="ss-page">
      <div className="np-scroll">
        {!data && !loadError && <Skeleton />}
        {!data && loadError && (
          <div className="np-card"><div className="np-errline">读取会话状态失败：{loadError}<Button size="sm" onClick={load}>重试</Button></div></div>
        )}
        {data && (
          <>
            <div className="np-card np-card--form">
              <div className="np-row">
                <div className="lf">
                  <div className="lb">会话状态</div>
                  <div className="ds">会话做完、或停下来等你确认时，会弹系统通知</div>
                </div>
                <Toggle checked={data.enabled} disabled={saving} onChange={onToggle} />
              </div>
              {data.enabled && (data.failures?.length ? data.failures.slice(0, 1).map((f) => (
                <div className="np-row" key={f.tool}>
                  <div className="lf">
                    <div className="lb">{f.label}</div>
                    <div className="ds bad" title={f.message || f.error}>{f.message || `没能写入 ${f.label} 的配置：${f.error}`}</div>
                  </div>
                  <Button size="sm" disabled={retrying} onClick={onRetry}>{retrying ? '重试中...' : '重试'}</Button>
                </div>
              )) : (
                <div className="np-row">
                  <div className="lb ss-kv-l">检测到的工具</div>
                  <div className="ss-kv-v">{describeTools(data.tools)}</div>
                </div>
              ))}
            </div>
            <Sessions data={data} onRetry={load} />
          </>
        )}
      </div>
    </PageShell>
  )
}

function Sessions({ data, onRetry }) {
  const head = (count) => (
    <div className="np-glabel">会话{count != null && <span className="ss-count">{count} 个</span>}</div>
  )
  let body
  if (!data.enabled) body = <div className="np-card"><div className="np-empty">打开「会话状态」后，这里会实时显示每个会话在干嘛。</div></div>
  else if (data.error) body = <div className="np-card"><div className="np-errline">读取会话状态失败：{data.error}<Button size="sm" onClick={onRetry}>重试</Button></div></div>
  else if (!data.tools?.claude && !data.tools?.codex) body = <div className="np-card"><div className="np-empty">没检测到 Claude Code 和 Codex。装好其中一个后会自动开始。</div></div>
  else if (!data.sessions?.length) body = <div className="np-card"><div className="np-empty">现在没有进行中的会话。在 Claude Code 或 Codex 里开始干活，这里会实时显示。</div></div>
  else {
    const now = Date.now()
    body = (
      <div className="np-card np-card--form" data-testid="ss-list">
        {data.sessions.map((s) => {
          const tag = STATE_TAG[s.state]
          const desc = describeSession(s)
          return (
            <div className="np-row" key={s.key}>
              <div className="lf">
                <div className="lb ss-name" title={s.name}>{s.name}</div>
                <div className="ds" title={desc}>{desc}</div>
              </div>
              <span className="ss-acts">
                <span className={`np-tag np-tag--${tag.tone}`}>{tag.label}</span>
                <span className="ss-time">{formatSessionTime(s.epoch, s.state, now)}</span>
              </span>
            </div>
          )
        })}
      </div>
    )
  }
  return <>{head(data.enabled && data.sessions?.length ? data.total : null)}{body}</>
}

function Skeleton() {
  return (
    <div data-testid="ss-skeleton">
      <div className="np-card np-card--form">
        <div className="np-row"><span className="np-sk np-sk--pulse" style={{ width: 84 }} /><span className="np-sk" style={{ width: 36, height: 20 }} /></div>
        <div className="np-row"><span className="np-sk" style={{ width: 70 }} /><span className="np-sk" style={{ width: 120 }} /></div>
      </div>
      <div className="np-glabel">会话</div>
      <div className="np-card np-card--form">
        {[90, 120, 70].map((w) => (
          <div className="np-row" key={w}>
            <div className="lf"><span className="np-sk np-sk--pulse" style={{ width: w }} /><div><span className="np-sk" style={{ width: w + 80, height: 10 }} /></div></div>
            <span className="np-sk" style={{ width: 56, height: 16 }} />
          </div>
        ))}
      </div>
    </div>
  )
}
