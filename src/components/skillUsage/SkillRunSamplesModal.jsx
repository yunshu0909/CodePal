/**
 * SkillRunSamplesModal — 展示单个 Skill 的调用记录
 *
 * 负责：
 * - 按需调用兼容 API `listSkillRunSamples`
 * - 展示时间、工具、触发方式、session 与日志可用性
 * - 不展示用户正文、分类内部信息或 transcript 内容
 *
 * @module components/skillUsage/SkillRunSamplesModal
 */
import React, { useEffect, useState } from 'react'
import Modal from '../Modal/Modal'
import Button from '../Button/Button'
import Tag from '../Tag/Tag'
import './skillUsage.css'

function formatTime(value) {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return value
  }
}

function labelForTrigger(triggerType) {
  const labels = {
    claude_tool_use: 'Claude Tool',
    claude_slash: 'Claude Slash',
    codex_dollar: 'Codex $',
    goal_directive: '/goal',
  }
  return labels[triggerType] || triggerType || 'unknown'
}

function shortSessionId(value) {
  const source = String(value || 'unknown')
  if (source.length <= 16) return source
  return `${source.slice(0, 8)}…${source.slice(-4)}`
}

/**
 * @param {object} props
 * @param {boolean} props.open - 是否显示
 * @param {Function} props.onClose - 关闭回调
 * @param {{name:string, displayName?:string}|null} props.skill - 当前 Skill
 * @param {number} [props.windowDays=30] - 时间窗
 */
export default function SkillRunSamplesModal({ open, onClose, skill, windowDays = 30 }) {
  const [status, setStatus] = useState('idle')
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!open || !skill?.name) return
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api || typeof api.listSkillRunSamples !== 'function') {
      setStatus('error')
      return
    }

    let cancelled = false
    setStatus('loading')
    setData(null)
    api
      .listSkillRunSamples({ skillName: skill.name, windowDays })
      .then((res) => {
        if (cancelled) return
        if (!res || !res.success || !res.data) {
          setStatus('error')
          return
        }
        setData(res.data)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [open, skill?.name, windowDays])

  const records = data?.records || []

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${skill?.displayName || skill?.name || 'Skill'} · 调用记录`}
      size="lg"
      footer={<Button variant="secondary" onClick={onClose}>关闭</Button>}
    >
      <div className="skill-run-modal">
        <div className="skill-run-summary">
          <span>近 {windowDays} 天</span>
          <span>{records.length} 条调用记录</span>
        </div>

        {status === 'loading' && <div className="skill-run-state">正在读取调用记录...</div>}
        {status === 'error' && <div className="skill-run-state skill-run-state--error">调用记录读取失败</div>}
        {status === 'ready' && data?.migrationRequired && (
          <div className="skill-run-state skill-run-state--error">
            调用账本升级失败，暂时无法列出完整记录；主数字仍为旧口径。
          </div>
        )}
        {status === 'ready' && !data?.migrationRequired && records.length === 0 && (
          <div className="skill-run-state">
            近 {windowDays} 天没有记录到调用。0 次不等于一定没用过，可能是隐式触发或日志已被清理。
          </div>
        )}

        {status === 'ready' && !data?.migrationRequired && records.length > 0 && (
          <div className="skill-run-list">
            {records.map((record) => (
              <div className="skill-run-item" key={record.invocationId}>
                <div className="skill-run-item-head">
                  <span className="skill-run-time">{formatTime(record.triggeredAt)}</span>
                  <Tag variant="info">{record.tool}</Tag>
                  <Tag variant="default">{labelForTrigger(record.triggerType)}</Tag>
                  <Tag variant={record.sourceAvailable === 'available' ? 'success' : 'warning'}>
                    {record.sourceAvailable === 'available' ? '日志可用' : '日志已失效'}
                  </Tag>
                </div>
                <div className="skill-run-meta">
                  <span>Session</span>
                  <span className="skill-run-session" title={record.session?.id || ''}>
                    {shortSessionId(record.session?.id)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
