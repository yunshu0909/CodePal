/**
 * API 连通性检测卡片
 *
 * 负责：
 * - 手动触发 OpenAI + Anthropic 连通性检测
 * - 展示三段式检测结果（DNS → TLS → HTTP）
 * - 检测中 loading 状态 + 防重复触发
 * - 全部不可达时按钮文案切换 + 引导文案
 *
 * @module pages/network/ApiConnectivityCard
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import EndpointResultRow from './EndpointResultRow'

/**
 * @param {Object} props
 * @param {(message: string, type: string) => void} props.onToast - Toast 回调
 */
export default function ApiConnectivityCard({ onToast }) {
  // 检测结果数组，null=未检测
  const [results, setResults] = useState(null)
  // 是否正在检测
  const [isChecking, setIsChecking] = useState(false)
  // 上次检测时间戳
  const [lastCheckTime, setLastCheckTime] = useState(null)
  // 相对时间显示
  const [relativeTime, setRelativeTime] = useState('')
  const timerRef = useRef(null)

  // 更新"X 分钟前"显示
  useEffect(() => {
    if (!lastCheckTime) return
    const update = () => {
      const seconds = Math.floor((Date.now() - lastCheckTime) / 1000)
      if (seconds < 5) setRelativeTime('刚刚')
      else if (seconds < 60) setRelativeTime(`${seconds} 秒前`)
      else setRelativeTime(`${Math.floor(seconds / 60)} 分钟前`)
    }
    update()
    timerRef.current = setInterval(update, 1000)
    return () => clearInterval(timerRef.current)
  }, [lastCheckTime])

  const handleCheck = useCallback(async () => {
    setIsChecking(true)
    try {
      const response = await window.electronAPI.probeEndpoints()
      if (response.success && response.data) {
        setResults(response.data)
        setLastCheckTime(Date.now())

        // Toast 反馈
        const allReachable = response.data.every((r) => r.reachable)
        const noneReachable = response.data.every((r) => !r.reachable)
        if (allReachable) {
          onToast('API 连通性检测完成，全部可达', 'success')
        } else if (noneReachable) {
          onToast('API 连通性检测完成，全部不可达', 'error')
        } else {
          const failed = response.data.filter((r) => !r.reachable).map((r) => r.label).join('、')
          onToast(`API 连通性检测完成，${failed} 不可达`, 'warning')
        }
      } else {
        onToast(response.error || '检测失败', 'error')
      }
    } catch (error) {
      onToast('检测失败：' + error.message, 'error')
    } finally {
      setIsChecking(false)
    }
  }, [onToast])

  const allFailed = results && results.every((r) => !r.reachable)
  const buttonText = isChecking ? '检测中…' : allFailed ? '重新检测' : '立即检测'

  return (
    <div className="nd-card" style={{ height: '100%' }}>
      <div className="nd-card-header">
        <div>
          <div className="nd-card-title-row">
            <svg className="nd-card-title-icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M9 2v4M9 12v4M2 9h4M12 9h4"/>
              <circle cx="9" cy="9" r="3"/>
            </svg>
            API 连通性
          </div>
          <div className="nd-card-desc">检测 AI 服务是否可达，定位 DNS / TLS / HTTP 各环节耗时</div>
        </div>
        <button className="nd-btn-detect" onClick={handleCheck} disabled={isChecking}>
          {isChecking ? (
            <svg className="nd-spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2a6 6 0 1 1-4.24 1.76" strokeLinecap="round"/>
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 8a6 6 0 0 1 12 0M5 8a3 3 0 0 1 6 0"/>
              <circle cx="8" cy="8" r="1" fill="currentColor"/>
            </svg>
          )}
          {buttonText}
        </button>
      </div>

      <div className="nd-api-list">
        {results ? (
          results.map((r) => (
            <EndpointResultRow key={r.id} name={r.label} result={r} />
          ))
        ) : (
          <>
            <EndpointResultRow name="OpenAI" result={null} />
            <EndpointResultRow name="Anthropic" result={null} />
          </>
        )}
      </div>

      {lastCheckTime && (
        <div className="nd-last-checked">
          上次检测：{relativeTime}
          {allFailed && ' · 请检查 VPN 连接状态'}
        </div>
      )}
    </div>
  )
}
