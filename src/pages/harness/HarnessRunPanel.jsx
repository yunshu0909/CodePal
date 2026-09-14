/**
 * Harness 运行卡与面板骨架
 *
 * 负责：
 * - HarnessPanel：两张卡共用的卡头（状态点 / 标题 / 版本 / 一句说明 / 实体动作）与行渲染
 * - 默认导出运行卡：此刻谁在跑、能不能停
 *
 * 行结构：标签 / 值 / 动作三列，备注落第二行；设置行（开关）占标签 + 值两列。
 *
 * @module pages/harness/HarnessRunPanel
 */

import { Fragment } from 'react'
import Button from '../../components/Button/Button'
import Tag from '../../components/Tag/Tag'
import Toggle from '../../components/Toggle'

/** 分隔符留给末段：开头被省略时读作「…/最后一段」 */
function PathValue({ value }) {
  const cut = Math.max(value.lastIndexOf('/'), 0)
  return (
    <span className="harness-path" title={value}>
      <span className="harness-path__head">{value.slice(0, cut)}</span>
      <span className="harness-path__tail">{value.slice(cut)}</span>
    </span>
  )
}

function Channels({ segment, onAction }) {
  return (
    <div className="harness-channel" role="group" aria-label="更新通道">
      {segment.options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={segment.active === option.key ? 'is-active' : ''}
          aria-label={option.version ? `${option.label} ${option.version}` : option.label}
          onClick={() => onAction('channel', { channel: option.key })}
        >
          {option.label}
          {option.version && <span className="harness-mono">{option.version}</span>}
        </button>
      ))}
    </div>
  )
}

/** plain：备注里的文字直接排版，允许换行；值列里的文字不换行 */
export function Segments({ items, onAction, plain = false }) {
  return items.map((segment, index) => {
    const key = `${segment.type}-${index}`
    switch (segment.type) {
      case 'mono': return <span key={key} className="harness-mono">{segment.value}</span>
      case 'monoMuted': return <span key={key} className="harness-mono harness-mono--muted">{segment.value}</span>
      case 'monoKeep': return <span key={key} className="harness-mono harness-mono--muted harness-mono--keep">{segment.value}</span>
      case 'muted': return <span key={key} className="harness-row__text harness-row__text--muted">{segment.value}</span>
      case 'path': return <PathValue key={key} value={segment.value} />
      case 'tag': return <Tag key={key} variant={segment.variant}>{segment.value}</Tag>
      case 'channels': return <Channels key={key} segment={segment} onAction={onAction} />
      default: return plain
        ? <Fragment key={key}>{segment.value}</Fragment>
        : <span key={key} className="harness-row__text">{segment.value}</span>
    }
  })
}

function Action({ item, onAction }) {
  if (item.type === 'toggle') {
    return <Toggle checked={item.checked} disabled={item.disabled} onChange={(next) => onAction(item.key, { enabled: next })} />
  }
  return (
    <Button variant={item.variant} size="sm" loading={item.loading} disabled={item.disabled} onClick={() => onAction(item.key)}>
      {item.label}
    </Button>
  )
}

function Row({ row, onAction }) {
  return (
    <div className={`harness-row${row.setting ? ' harness-row--setting' : ''}`}>
      <div className="harness-row__label">{row.label}</div>
      {!row.setting && <div className="harness-row__value"><Segments items={row.value} onAction={onAction} /></div>}
      {row.action.length > 0 && (
        <div className="harness-row__action">
          {row.action.map((item) => <Action key={item.key} item={item} onAction={onAction} />)}
        </div>
      )}
      {row.note && <div className="harness-row__note"><Segments items={row.note} onAction={onAction} plain /></div>}
    </div>
  )
}

/**
 * @param {{ name: string, tone?: string, title: string, meta?: string|null, hint?: string|null,
 *   actions?: object[], rows: object[], foot?: string|null, onAction: Function }} props
 */
export function HarnessPanel({ name, tone, title, meta, hint, actions = [], rows, foot, onAction }) {
  return (
    <section className="harness-panel" aria-label={name}>
      <div className="harness-panel__head">
        {tone && <span className={`harness-dot harness-dot--${tone}`} />}
        <h2 className="harness-panel__title">{title}</h2>
        {meta && <span className="harness-panel__meta">{meta}</span>}
        {hint && <span className="harness-panel__hint">{hint}</span>}
        {actions.length > 0 && (
          <div className="harness-panel__actions">
            {actions.map((item) => <Action key={item.key} item={item} onAction={onAction} />)}
          </div>
        )}
      </div>
      {rows.length > 0 && (
        <div className="harness-rows">
          {rows.map((row) => <Row key={row.id} row={row} onAction={onAction} />)}
        </div>
      )}
      {foot && <div className="harness-panel__foot">{foot}</div>}
    </section>
  )
}

export default function HarnessRunPanel({ run, onAction }) {
  return <HarnessPanel name="运行" tone={run.tone} title={run.title} hint={run.hint} actions={run.actions} rows={run.rows} onAction={onAction} />
}
