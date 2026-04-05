/**
 * 公网 IP 监控卡片
 *
 * 负责：
 * - 展示当前 IP、采样指标、时间线
 * - 开关控制监控启停
 * - 底栏显示轮次进度和倒计时
 * - 正常/切换/失败/关闭四种状态展示
 *
 * @module pages/network/IpMonitorCard
 */

import { useState, useEffect, useRef } from 'react'
import useIpMonitor from '../../hooks/useIpMonitor'
import { ROUND_DURATION_MS } from './constants'

const STATUS_BADGE = {
  detecting: { cls: 'nd-badge--loading', text: '检测中', pulse: true },
  stable:    { cls: 'nd-badge--success', text: '稳定', pulse: true },
  switched:  { cls: 'nd-badge--warning', text: 'IP 切换', pulse: false },
  failed:    { cls: 'nd-badge--danger',  text: '获取失败', pulse: false },
  off:       { cls: 'nd-badge--idle',    text: '已关闭', pulse: false },
}

/**
 * @param {Object} props
 * @param {(message: string, type: string) => void} props.onToast
 */
export default function IpMonitorCard({ onToast }) {
  const { state, toggle } = useIpMonitor(onToast)

  // 每秒更新底栏倒计时
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // 数据还没从主进程拉到
  if (!state) {
    return (
      <div className="nd-card" style={{ height: '100%' }}>
        <div className="nd-card-header">
          <div>
            <div className="nd-card-title-row">
              <svg className="nd-card-title-icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="9" cy="9" r="7"/><path d="M2 9h14M9 2a11 11 0 0 1 3 7 11 11 0 0 1-3 7 11 11 0 0 1-3-7 11 11 0 0 1 3-7z"/>
              </svg>
              公网 IP 监控
            </div>
            <div className="nd-card-desc">自动检测公网出口 IP 是否变化，判断 VPN 连接是否稳定</div>
          </div>
        </div>
        <div className="nd-ip-current">
          <span className="nd-ip-address nd-ip-address--placeholder">—.—.—.—</span>
        </div>
        <div className="nd-running-bar">
          <span className="nd-running-text">正在获取公网 IP…</span>
        </div>
      </div>
    )
  }

  const badge = STATUS_BADGE[state.status] || STATUS_BADGE.detecting
  const isFailed = state.status === 'failed'
  const isOff = state.status === 'off'
  const roundElapsedMs = state.roundStartTime ? Date.now() - state.roundStartTime : 0
  const roundMin = Math.floor(roundElapsedMs / 60000)
  const roundSec = Math.floor((roundElapsedMs % 60000) / 1000)
  const successRate = state.sampleCount > 0 ? Math.round((state.successCount / state.sampleCount) * 100) : 0

  return (
    <div className="nd-card" style={{ height: '100%' }}>
      <div className="nd-card-header">
        <div>
          <div className="nd-card-title-row">
            <svg className="nd-card-title-icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="9" cy="9" r="7"/><path d="M2 9h14M9 2a11 11 0 0 1 3 7 11 11 0 0 1-3 7 11 11 0 0 1-3-7 11 11 0 0 1 3-7z"/>
            </svg>
            公网 IP 监控
          </div>
          <div className="nd-card-desc">自动检测公网出口 IP 是否变化，判断 VPN 连接是否稳定</div>
        </div>
        <div className="nd-card-actions">
          <span className={`nd-badge ${badge.cls}`}>
            <span className={`nd-badge-dot${badge.pulse ? ' nd-badge-dot--pulse' : ''}`}></span>
            {badge.text}
          </span>
          <button className={`nd-toggle${state.isEnabled ? ' nd-toggle--on' : ''}`} onClick={toggle} title={state.isEnabled ? '关闭监控' : '开启监控'}>
            <span className="nd-toggle-track"><span className="nd-toggle-thumb"></span></span>
          </button>
        </div>
      </div>

      {/* 当前 IP */}
      <div className="nd-ip-current">
        {state.currentIp && !isFailed ? (
          <>
            <span className="nd-ip-address">{state.currentIp}</span>
            {state.currentSource && <span className="nd-ip-source">via {state.currentSource}</span>}
          </>
        ) : isFailed ? (
          <span className="nd-ip-address nd-ip-address--fail">无法获取</span>
        ) : (
          <span className="nd-ip-address nd-ip-address--placeholder">—.—.—.—</span>
        )}
      </div>

      {/* 指标 */}
      <div className="nd-ip-metrics">
        <div className="nd-metric-item">
          <div className="nd-metric-label">已采样</div>
          <div className="nd-metric-value">{state.sampleCount} 次</div>
        </div>
        {isFailed ? (
          <>
            <div className="nd-metric-item">
              <div className="nd-metric-label">成功率</div>
              <div className="nd-metric-value nd-metric-value--danger">{successRate}%</div>
            </div>
            <div className="nd-metric-item">
              <div className="nd-metric-label">连续失败</div>
              <div className="nd-metric-value nd-metric-value--danger">{state.consecutiveFailCount} 次</div>
            </div>
          </>
        ) : (
          <>
            <div className="nd-metric-item">
              <div className="nd-metric-label">唯一 IP</div>
              <div className={`nd-metric-value${state.switchCount > 0 ? ' nd-metric-value--warning' : ''}`}>
                {state.uniqueIps.length || '—'}
              </div>
            </div>
            <div className="nd-metric-item">
              <div className="nd-metric-label">IP 切换</div>
              <div className={`nd-metric-value${state.switchCount > 0 ? ' nd-metric-value--warning' : ''}`}>
                {state.switchCount} 次
              </div>
            </div>
          </>
        )}
      </div>

      {/* 时间线 */}
      {state.timeline.length > 0 && (
        <>
          <div className="nd-timeline-title">采样时间线（最近 {state.timeline.length} 次）</div>
          <div className="nd-timeline">
            {state.timeline.map((point, i) => (
              <div
                key={i}
                className={`nd-timeline-dot${
                  point.type === 'switch' ? ' nd-timeline-dot--switch' :
                  point.type === 'fail' ? ' nd-timeline-dot--fail' : ''
                }`}
                title={point.ip || '获取失败'}
              />
            ))}
          </div>
        </>
      )}

      {/* 底栏 */}
      <div className="nd-running-bar">
        {isOff ? (
          <span className="nd-running-text">监控已关闭 · 打开开关重新开始检测</span>
        ) : !state.currentIp && state.sampleCount === 0 ? (
          <span className="nd-running-text">正在获取公网 IP…</span>
        ) : isFailed ? (
          <span className="nd-running-text nd-running-text--danger">请检查网络连接或 VPN 状态</span>
        ) : (
          <>
            <span className="nd-running-text">
              本轮 <strong>{roundMin} 分 {roundSec} 秒</strong> / 30 分钟
            </span>
            <span className="nd-running-text">后台持续监控中</span>
          </>
        )}
      </div>
    </div>
  )
}
