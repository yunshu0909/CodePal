/**
 * 模型接入页 · 模型行的展开区
 *
 * 负责：
 * - 键值行：模型名 / 思考强度（这个模型有档位时）/ 上下文上限 / 输出上限 / 终端启动 / 移除
 * - 模型名、上限：失焦或回车保存，写入期间短暂禁用；非法时红边 + 红字不保存；Esc 还原原值
 * - 思考强度：终端里启动这个模型时用的强度（存 models.json），选中即保存；审核用的强度在模型汇总里另存
 * - 复制命令拿全文；移除走全局确认对话框
 *
 * @module features/models/ModelDetail
 */

import { useEffect, useRef, useState } from 'react'
import Button from '../../components/Button/Button'
import EffortMenu from '../../components/EffortMenu'
import { toast } from '../../components/Toast'
import { MAX_OUTPUT_CAP, formatInt, modelNameError, parsePositiveInt } from './modelsView'

/**
 * 模型名输入
 * @param {{model: object, otherNames: string[], onSave: Function}} props
 */
function NameField({ model, otherNames, onSave }) {
  const [draft, setDraft] = useState(model.name)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(model.name) }, [model.name])

  const commit = async () => {
    const name = draft.trim()
    if (name === model.name) {
      setDraft(model.name)
      setError(null)
      return
    }
    const invalid = modelNameError(name, otherNames)
    if (invalid) {
      setError(invalid)
      return
    }
    setSaving(true)
    const res = await onSave({ name })
    setSaving(false)
    if (res.ok) return
    if (res.inline) {
      setError(res.message)
    } else {
      // 写入失败已弹红 Toast，控件退回原值
      setDraft(model.name)
      setError(null)
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      setDraft(model.name)
      setError(null)
    }
  }

  return (
    <div className="np-row np-kv mj-sub">
      <div className="lf">
        <div className="lb">模型名</div>
        {error && <div className="ds bad">{error}</div>}
      </div>
      <span className="np-in np-in--text mj-w-name">
        <input
          aria-label="模型名"
          value={draft}
          disabled={saving}
          aria-invalid={Boolean(error)}
          onChange={(e) => { setDraft(e.target.value); setError(null) }}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </span>
    </div>
  )
}

/**
 * 上下文 / 输出上限：千分位显示，允许带千分位输入，只收正整数（有 max 时不能超过它）
 * @param {{label: string, field: string, value: number, max?: number, onSave: Function}} props
 */
function LimitField({ label, field, value, max, onSave }) {
  const [draft, setDraft] = useState(formatInt(value))
  // 红字：null 没错；否则是要显示的那句
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(formatInt(value)) }, [value])

  const commit = async () => {
    const n = parsePositiveInt(draft)
    if (n === null) {
      setError('填正整数')
      return
    }
    if (max && n > max) {
      setError(`最多 ${formatInt(max)}`)
      return
    }
    setError(null)
    if (n === value) {
      setDraft(formatInt(n))
      return
    }
    setSaving(true)
    const res = await onSave({ [field]: n })
    setSaving(false)
    if (res.ok) setDraft(formatInt(n))
    else if (res.inline) setError(res.message || '填正整数')
    else setDraft(formatInt(value))
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      setDraft(formatInt(value))
      setError(null)
    }
  }

  return (
    <div className="np-row np-kv mj-sub">
      <div className="lf">
        <div className="lb">{label}</div>
        {error && <div className="ds bad">{error}</div>}
      </div>
      <span className="np-in mj-w-num">
        <input
          aria-label={label}
          inputMode="numeric"
          value={draft}
          disabled={saving}
          aria-invalid={Boolean(error)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </span>
    </div>
  )
}

const CHEV = <svg className="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 4 5 2 7 4M3 6 5 8 7 6" /></svg>

/**
 * 思考强度：弹出按钮 + 共用的强度菜单，选中即保存；选回当前档不保存
 * @param {{value: string, efforts: string[], onSave: Function}} props
 */
function EffortField({ value, efforts, onSave }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const anchor = useRef(null)

  const pick = async (effort) => {
    setOpen(false)
    if (effort === value) return
    setSaving(true)
    await onSave({ effort })
    setSaving(false)
  }

  return (
    <div className="np-row np-kv mj-sub">
      <div className="lf">
        <div className="lb">
          思考强度<span className="mj-note">终端手动用</span>
        </div>
        <div className="ds">终端里启动这个模型时用；审核用的强度在模型汇总里改</div>
      </div>
      <span className="mj-effort">
        <button
          ref={anchor}
          type="button"
          className="np-popbtn"
          aria-label="思考强度"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={saving}
          onClick={() => setOpen((v) => !v)}
        >
          {value}
          {CHEV}
        </button>
        {open && <EffortMenu value={value} efforts={efforts} anchorRef={anchor} onPick={pick} onClose={() => setOpen(false)} className="mj-menu" />}
      </span>
    </div>
  )
}

/**
 * 展开区
 * @param {Object} props
 * @param {object} props.model - 含 efforts（主进程按模型给出的可选强度，空数组就不显示强度行）
 * @param {string[]} props.otherNames - 同一家其他模型的名字（重名校验）
 * @param {string} props.command - 终端启动命令（不在 PATH 时是完整路径）
 * @param {boolean} props.removing
 * @param {(patch: object) => Promise<{ok: boolean, inline?: boolean, message?: string}>} props.onUpdate
 * @param {() => void} props.onRemove
 * @returns {JSX.Element}
 */
export default function ModelDetail({ model, otherNames, command, removing, onUpdate, onRemove }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      toast.success('已复制')
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <>
      <NameField model={model} otherNames={otherNames} onSave={onUpdate} />
      {model.efforts?.length > 0 && <EffortField value={model.effort} efforts={model.efforts} onSave={onUpdate} />}
      <LimitField label="上下文上限" field="contextTokens" value={model.contextTokens} onSave={onUpdate} />
      <LimitField label="输出上限" field="maxOutputTokens" value={model.maxOutputTokens} max={MAX_OUTPUT_CAP} onSave={onUpdate} />
      <div className="np-row np-kv mj-sub mj-cmdrow">
        <div className="lf">
          <div className="lb">终端启动</div>
          <div className="ds mj-cmd" title={command}>{command}</div>
        </div>
        <div className="np-card-acts">
          <Button size="sm" className="np-btn" onClick={copy}>复制命令</Button>
        </div>
      </div>
      <div className="np-row mj-sub">
        <div className="lf" />
        <Button size="sm" className="np-btn" variant="danger" disabled={removing} onClick={onRemove}>
          {removing ? '移除中…' : '移除模型'}
        </Button>
      </div>
    </>
  )
}
