/** Five checks in one card, matching the selected independent DeepSeek design. */
import { useCallback, useEffect, useState } from 'react'
import PageShell from '../../components/PageShell'
import Button from '../../components/Button/Button'
import Toggle from '../../components/Toggle'
import StateView from '../../components/StateView/StateView'
import useClaudeEnvironment from './useClaudeEnvironment'
import CheckPopover from './CheckPopover'
import './claudeEnvironment.css'

function timeText(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const today = new Date()
  const clock = date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (date.toDateString() === today.toDateString()) return clock
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`
  return `${date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}
function region(code) {
  if (!code) return '地区未知'
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) } catch { return code }
}
const kindClass = { ok: '', warn: 'warn', error: 'bad', unknown: 'off' }
const chevron = <svg className="np-disc" viewBox="0 0 10 10" aria-hidden="true"><path d="m4 2.5 2.5 2.5L4 7.5" /></svg>

function ClaudeIcon() {
  return <span className="np-ic np-ic--s20" style={{ '--c': 'var(--tool-claude)' }} aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 4.5 6.5 8 3 11.5M8 12h5" /></svg></span>
}

function Hero({ state, busy }) {
  if (!state?.checkedAt) return (
    <div>
      {busy ? <div className="np-hero-num"><span aria-hidden="true" className="np-sk-text np-sk--pulse">203.0.113.24</span></div> : <div className="np-hero-na">还没检测过</div>}
      <div className="np-hero-hint">检测后显示出口 IP、所在地区和 DNS 解析器</div>
    </div>
  )
  if (!state.egress.ip) return (
    <div>
      <div className="np-hero-num na">—</div>
      <div className={`np-sub ${state.tone === 'red' ? 'ce-error-text' : 'ce-warning-text'}`}>{state.code === 'proxy' ? '专用代理未运行，HTTP 与 DNS 本次均未检测' : '本次未取得出口结果，当前地区未知'}</div>
      {state.lastSuccess && <div className="np-sub">上次成功 <span className="ce-number">{state.lastSuccess.ip}</span> · {timeText(state.lastSuccess.checkedAt)}</div>}
    </div>
  )
  return (
    <div>
      <div className={`np-hero-num ce-ip${state.stale ? ' na' : ''}`}>{state.egress.ip}</div>
      <div className={`np-sub${state.stale ? ' ce-warning-text' : ''}`}>{region(state.egress.country)} · {state.stale ? '历史结果' : '检测于'} <span className="ce-number">{timeText(state.checkedAt)}</span></div>
    </div>
  )
}

export default function ClaudeEnvironmentPage() {
  const { state, error, saving, busy, probeOnce, toggle, retry } = useClaudeEnvironment()
  const [open, setOpen] = useState(null)
  const close = useCallback(() => setOpen(null), [])
  useEffect(() => { setOpen(null) }, [state?.checkedAt])
  const blocked = state && !state.available
  const checks = state?.checks.map(check => error ? { ...check, kind: 'unknown', label: `上次：${check.label}` } : check) || ['出口网络', 'DNS 解析器', '专用代理', '启动器固定 IP', '启动入口'].map((title, index) => ({ id: String(index), title, kind: 'unknown', label: '读取中', value: '', evidence: [], hint: '' }))
  const activeCheck = open && checks.find(check => check.id === open.id)

  return (
    <PageShell title="环境监测" native className="ce-page">
      <div className="np-scroll">
        {error && !state ? <StateView error={error} onRetry={retry} /> : blocked ? (
          <StateView empty emptyMessage={!state.supported ? '这台电脑暂不支持环境监测' : state.code === 'configuration' ? '专用环境配置需要复核' : '没有找到 Claude 专用环境'} emptyHint={!state.supported ? '第一版支持 macOS 上已有的 Claude 专用网络环境' : '这页读取已有配置，不会自动安装或修改网络设置'} emptyAction={state.supported ? <Button size="sm" variant="primary" disabled={busy} onClick={probeOnce}>{busy ? '查找中…' : '重新检查'}</Button> : undefined} />
        ) : (
          <>
            <section className="np-card">
              <div className="np-card-hd">
                <span className="np-card-title"><ClaudeIcon />Claude Code 出口<span className="np-tag np-tag--gray ce-scope">仅本机 claude 入口</span></span>
                <span className="np-card-acts"><span className={`np-tag np-tag--${error ? 'orange' : state?.tone || 'gray'}`}>{error ? '状态待核实' : state?.label || '读取中'}</span><Button size="sm" variant={state?.code === 'first' ? 'primary' : 'secondary'} disabled={busy || !state} onClick={probeOnce} data-testid="ce-probe">{busy ? '检测中…' : state?.tone === 'red' ? '重试' : '检测一次'}</Button></span>
              </div>
              <Hero state={error && state ? { ...state, stale: true } : state} busy={busy || !state} />
              {error && <div className="np-sub ce-error-text">{error}</div>}
              <div>
                {checks.map(check => (
                  <div key={check.id} role="button" tabIndex={state ? 0 : -1} aria-label={`${check.title}：${check.label}`} aria-expanded={open?.id === check.id} className="np-row np-row--rec ce-check" onClick={event => state && setOpen(open?.id === check.id ? null : { id: check.id, anchor: event.currentTarget })} onKeyDown={event => { if (state && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setOpen({ id: check.id, anchor: event.currentTarget }) } }}>
                    <div className="lf"><div className="lb">{check.title}</div></div>
                    <span className="np-card-acts"><span className={`np-st ${kindClass[check.kind]}`}><i />{check.label}</span>{check.value && <span className="ce-value ce-number">{check.value}</span>}{chevron}</span>
                  </div>
                ))}
              </div>
              <div className="np-row">
                <div className="lf"><div className="lb">持续监测</div><div className="ds">{state?.monitoring ? '每 5 分钟检查；异常与恢复时提醒' : '已关闭 · 仅在点击“检测一次”时更新'}</div></div>
                <Toggle aria-label="持续监测" checked={Boolean(state?.monitoring)} disabled={saving || !state} onChange={toggle} />
              </div>
            </section>
            <div className="np-glabel">检测记录<span className="ce-record-range">近 24 小时</span></div>
            <section className="np-card np-card--form">
              {state?.history.length ? state.history.slice(0, 3).map((record, index) => (
                <div className="np-lrow" key={`${record.at}-${index}`}><span className="t ce-record-time">{timeText(record.at)}</span><span className="ce-record-text">{record.label}{record.ip && <> · 出口 <span className="ce-number">{record.ip}</span>（{region(record.country)}）</>}</span>{['red', 'orange'].includes(record.tone) && <span className={`np-tag np-tag--${record.tone}`}>需复核</span>}</div>
              )) : <div className="np-lrow"><span className="ce-note">还没有检测记录</span></div>}
            </section>
          </>
        )}
      </div>
      {activeCheck && <CheckPopover check={activeCheck} anchor={open.anchor} checkedText={timeText(state.checkedAt)} onClose={close} />}
    </PageShell>
  )
}
