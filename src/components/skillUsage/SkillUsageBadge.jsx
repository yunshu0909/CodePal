/**
 * SkillUsageBadge — 单个 skill 的「调用·近30天」徽标
 *
 * 5 态：加载骨架 / 读取失败「—」/ 0 次（灰）/ N 次（蓝）/ ≥1000 显「999+」。
 * 数字/0 次复用 Tag 组件，不另造样式。
 *
 * @module components/skillUsage/SkillUsageBadge
 */
import React from 'react'
import Tag from '../Tag/Tag'
import './skillUsage.css'

/**
 * @param {object} props
 * @param {{total:number}|undefined} props.usage - 该 skill 的统计（无记录则 undefined）
 * @param {boolean} [props.loading] - 扫描进行中
 * @param {boolean} [props.error] - 扫描失败
 */
export default function SkillUsageBadge({ usage, loading = false, error = false }) {
  if (loading) return <span className="usage-skel" aria-label="加载中" />
  if (error) return <span className="usage-dash" title="调用数据读取失败，本次显示为 —">—</span>

  const total = usage?.total || 0
  if (total === 0) return <Tag variant="default">0 次</Tag>
  return <Tag variant="info">{total >= 1000 ? '999+' : total} 次</Tag>
}
