/**
 * 模型接入页 · 模型行
 *
 * 负责：
 * - 行首箭头 + 名称 + 描述（「{时间} 测过」/ 红字原因 / 橙字 Key 读不到；未测试不写描述）
 * - 行尾状态点 + 一个按钮：测一下 / 重试（失败时原位替换）/ 测试中…（禁用，状态点不动）
 * - 展开时下面接展开区
 *
 * @module features/models/ModelRow
 */

import Button from '../../components/Button/Button'
import ModelDetail from './ModelDetail'
import { reasonText, testedAtParts } from './modelsView'

const DISC_RIGHT = <svg className="np-disc" viewBox="0 0 10 10" aria-hidden="true"><path d="M4 2.5 6.5 5 4 7.5" /></svg>
const DISC_DOWN = <svg className="np-disc" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" /></svg>

/** 状态点：绿「可用」/ 灰「未测试」/ 红「不可用」/ 橙「读不到 Key」 */
const STATUS = {
  ok: { cls: '', text: '可用' },
  none: { cls: 'off', text: '未测试' },
  bad: { cls: 'bad', text: '不可用' },
  lost: { cls: 'warn', text: '读不到 Key' },
}

/**
 * 这一行的状态
 * @param {object} model
 * @param {boolean} keyReadable
 * @returns {'ok'|'none'|'bad'|'lost'}
 */
function rowState(model, keyReadable) {
  if (!keyReadable) return 'lost'
  if (!model.lastResult) return 'none'
  return model.lastResult.ok ? 'ok' : 'bad'
}

/** 描述行：只有时分用圆体 */
function Description({ state, model, providerName, now }) {
  if (state === 'ok') {
    const { prefix, clock } = testedAtParts(model.lastResult.at, now)
    return <div className="ds">{prefix}{clock && <span className="mj-num">{clock}</span>} 测过</div>
  }
  if (state === 'bad') return <div className="ds bad">{reasonText(model.lastResult, providerName)}</div>
  if (state === 'lost') return <div className="ds warn">本机保存的 Key 找不到了，重新填写</div>
  return null
}

/**
 * @param {Object} props
 * @param {object} props.model
 * @param {string} props.providerName
 * @param {boolean} props.keyReadable
 * @param {boolean} props.blocked - Claude Code 没装或太旧，「测一下」禁用
 * @param {boolean} props.testing
 * @param {boolean} props.removing
 * @param {boolean} props.expanded
 * @param {string[]} props.otherNames
 * @param {string} props.command
 * @param {number} props.now
 * @param {() => void} props.onToggle
 * @param {() => void} props.onTest
 * @param {(patch: object) => Promise<object>} props.onUpdate
 * @param {() => void} props.onRemove
 * @returns {JSX.Element}
 */
export default function ModelRow({ model, providerName, keyReadable, blocked, testing, removing, expanded, otherNames, command, now, onToggle, onTest, onUpdate, onRemove }) {
  const state = rowState(model, keyReadable)
  const status = STATUS[state]
  const label = testing ? '测试中…' : state === 'bad' ? '重试' : '测一下'

  return (
    <>
      <div className="np-row" data-model={model.id}>
        {/* 箭头和名字那一块能展开；做成 role=button 的块，这一行真正的按钮只有右边一个 */}
        <div
          role="button"
          tabIndex={0}
          className="mj-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onToggle()
            }
          }}
        >
          {expanded ? DISC_DOWN : DISC_RIGHT}
          <div className="lf">
            <div className="lb mj-name" title={model.name}>{model.name}</div>
            <Description state={state} model={model} providerName={providerName} now={now} />
          </div>
        </div>
        <div className="np-card-acts">
          <span className={`np-st ${status.cls}`.trim()}><i />{status.text}</span>
          <Button size="sm" className="np-btn" disabled={testing || blocked || state === 'lost'} onClick={onTest}>{label}</Button>
        </div>
      </div>
      {expanded && (
        <ModelDetail model={model} otherNames={otherNames} command={command} removing={removing} onUpdate={onUpdate} onRemove={onRemove} />
      )}
    </>
  )
}
