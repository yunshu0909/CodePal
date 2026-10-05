/**
 * 模型接入页 · 供应商卡（一家一张）
 *
 * 负责：
 * - 卡头：图标 + 名称 + 类型字；右端「更换 Key / 填写 Key」，一家都没填 Key 时是主按钮，弹层打开时退回白按钮
 * - 首次读取：卡头照常，按钮位和一行模型出骨架
 * - 模型行 × N（可同时展开多个，进页面全部收起）+「＋ 添加模型」
 * - Key 弹层锚在卡头按钮下，添加弹层锚在「＋ 添加模型」下
 *
 * @module features/models/ProviderCard
 */

import { useRef, useState } from 'react'
import Button from '../../components/Button/Button'
import KeyPopover from './KeyPopover'
import AddModelPopover from './AddModelPopover'
import ModelRow from './ModelRow'
import { commandText } from './modelsView'

const CUBE = <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 13.5 5v6L8 14 2.5 11V5zM2.5 5 8 8l5.5-3M8 8v6" /></svg>

/** 卡头左侧：图标 + 名称 + 类型字 */
function Title({ preset }) {
  return (
    <span className="np-card-title">
      <span className="np-ic np-ic--s20" style={{ '--c': preset.color }}>{CUBE}</span>
      {preset.name}
      <span className="np-card-type">{preset.type}</span>
    </span>
  )
}

/**
 * @param {Object} props
 * @param {{id: string, name: string, type: string, color: string, keyPrefix: string, efforts: string[]}} props.preset
 * @param {{keySet: boolean, keyReadable: boolean, models: object[]}|null} props.provider - null = 首次读取中
 * @param {boolean} props.primaryKey - 卡头按钮是这一屏的主按钮
 * @param {boolean} props.blocked - Claude Code 没装或太旧
 * @param {Set<string>} props.testing
 * @param {Set<string>} props.removing
 * @param {object|null} props.commands - 终端命令状态（决定复制命令带不带完整路径）
 * @param {number} props.now
 * @param {'key'|'add'|null} props.popover - 这张卡上开着的弹层
 * @param {(kind: 'key'|'add'|null) => void} props.onPopover
 * @param {object} props.actions - useModels 的动作
 * @returns {JSX.Element}
 */
export default function ProviderCard({ preset, provider, primaryKey, blocked, testing, removing, commands, now, popover, onPopover, actions }) {
  // 展开的模型 id；进页面全部收起，不记忆
  const [expanded, setExpanded] = useState(() => new Set())
  const keyBtn = useRef(null)
  const addBtn = useRef(null)
  const pid = preset.id

  if (!provider) {
    return (
      <section className="np-card">
        <div className="np-card-hd">
          <Title preset={preset} />
          <span className="np-sk np-sk--pulse mj-sk-btn" />
        </div>
        <div className="np-row">
          <span className="np-sk np-sk--pulse mj-sk-name" />
          <span className="np-sk np-sk--pulse mj-sk-st" />
        </div>
      </section>
    )
  }

  const toggle = (id) => setExpanded((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  // 改名即换 id：展开状态跟着新 id 走，正在编辑的展开区不收起
  const renamed = (oldId, newId) => setExpanded((s) => {
    if (!s.has(oldId)) return s
    const next = new Set(s)
    next.delete(oldId)
    next.add(newId)
    return next
  })

  const hasKey = provider.keySet && provider.keyReadable
  const names = provider.models.map((m) => m.name)
  const closePopover = () => onPopover(null)

  return (
    <section className="np-card">
      <div className="np-card-hd">
        <Title preset={preset} />
        <span ref={keyBtn}>
          <Button
            size="sm"
            className="np-btn"
            variant={primaryKey ? 'primary' : 'secondary'}
            onClick={() => onPopover(popover === 'key' ? null : 'key')}
          >
            {hasKey ? '更换 Key' : '填写 Key'}
          </Button>
        </span>
        {/* 弹层放在卡头里：定位仍相对整张卡（卡头不定位），也不会让最后一行多出分隔线 */}
        {popover === 'key' && (
          <KeyPopover
            preset={preset}
            anchorRef={keyBtn}
            onCancel={closePopover}
            onSave={async (key) => {
              const res = await actions.saveKey(pid, key)
              if (res.ok) closePopover()
              return res
            }}
          />
        )}
      </div>

      {provider.keySet && provider.models.map((m) => (
        <ModelRow
          key={m.id}
          model={m}
          providerName={preset.name}
          keyReadable={provider.keyReadable}
          blocked={blocked}
          testing={testing.has(`${pid}__${m.id}`)}
          removing={removing.has(`${pid}__${m.id}`)}
          expanded={expanded.has(m.id)}
          otherNames={names.filter((n) => n !== m.name)}
          command={commandText(m.name, commands, pid)}
          now={now}
          onToggle={() => toggle(m.id)}
          onTest={() => actions.test(pid, m.id)}
          onUpdate={(patch) => actions.updateModel(pid, m.id, patch, (newId) => renamed(m.id, newId))}
          onRemove={() => actions.removeModel(pid, m)}
        />
      ))}

      {provider.keySet && (
        <div className="np-row">
          <span ref={addBtn}>
            <Button variant="ghost" className="np-btn-text" onClick={() => onPopover(popover === 'add' ? null : 'add')}>＋ 添加模型</Button>
          </span>
          {popover === 'add' && (
            <AddModelPopover
              names={names}
              anchorRef={addBtn}
              onCancel={closePopover}
              onAdd={async (name) => {
                const res = await actions.addModel(pid, name)
                if (res.ok) closePopover()
                return res
              }}
            />
          )}
        </div>
      )}

    </section>
  )
}
