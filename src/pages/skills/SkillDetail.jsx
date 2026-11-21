/**
 * Skill 管理页右栏：一个 Skill 的详情
 *
 * 负责：
 * - 栏头：名字（折行显示全）+ 来源 · 近 30 天次数（v2.1.11 起「外部」与栏头收进资产库下线，收进走「要处理」）
 * - 最近收进卡（这个名字最近一次还没撤回的收进，见 InboxDetail 的 RecentCard）
 * - 启用：每个工具一个开关（只读的是状态点 + 去哪关；工具读不出 / 没找到禁用）；工具的全局位置被一份不是资产库链接的占着时
 *   开关灰、写原因，一样的独立文件夹和指向别处的链接给「换成链接」（定稿 C13）；没做完的收进或撤回时开关都先停着；隶属插件；装了两份
 * - 近 30 天调用记录（子代理那一串合成一行，不计入次数，#81）、说明、位置（名字一行、完整路径一行）、删除
 *
 * @module pages/skills/SkillDetail
 */

import React from 'react'
import Button from '../../components/Button/Button'
import Toggle from '../../components/Toggle'
import { RecentCard } from './InboxDetail'
import { TOOLS, formatRecordTime, isReadOnly, readOnlyKind, recordProject, sourceLabel, subagentRunText, toolStatus } from './skillsModel'

const TOOL_ICON = {
  'claude-code': { className: 'sk-ic-claude', path: 'M3 4.5 6.5 8 3 11.5M8 12h5' },
  codex: { className: 'sk-ic-codex', path: 'M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5' },
}

/**
 * 工具的 20px 图标方块
 * @param {{toolId: string}} props
 * @returns {JSX.Element}
 */
export function ToolIcon({ toolId }) {
  const icon = TOOL_ICON[toolId]
  return (
    <span className={`np-ic np-ic--s20 ${icon.className}`} aria-hidden="true">
      <svg viewBox="0 0 16 16"><path d={icon.path} /></svg>
    </span>
  )
}

const LOCATION_LABEL = { central: '资产库', 'claude-code': 'Claude Code', codex: 'Codex' }

const GATE_TEXT = {
  pending: (label) => `${label} 全局目录里还有一份没处理，先处理上面那份`,
  ignored: (label) => `${label} 用的是全局目录里自己那份（已忽略）；要改用资产库的，先到「已忽略」取消，再收进`,
  same: (label) => `${label} 全局目录里是一份和资产库一样的独立文件夹；换成资产库的链接后才能在这里开关`,
  external: (label) => `${label} 全局目录里是指向别处的链接；换成资产库的链接后才能在这里开关（别处的原件不动）`,
}

/**
 * 启用卡里一个工具的一行
 * @param {object} props
 * @param {boolean} [props.frozen] - 这个名字有没做完的收进或撤回：开关先停着
 * @param {(toolId: string) => void} [props.onFixGate] - 占位里「换成链接」
 * @returns {JSX.Element|null}
 */
export function ToolRow({ tool, skill, snapshot, pending, frozen = false, onToggle, onFixGate }) {
  const state = skill.tools?.[tool.id]
  const status = toolStatus(snapshot, tool.id)
  const readOnly = isReadOnly(skill)
  if (readOnly) {
    if (state?.enabled !== true) return null
    const where = readOnlyKind(skill).where
    return (
      <div className="np-row">
        <div className="lf sk-tool">
          <ToolIcon toolId={tool.id} />
          <div className="lf"><div className="lb">{tool.label}</div><div className="ds">{where}</div></div>
        </div>
        <span className="np-st"><i />装载中</span>
      </div>
    )
  }
  let note = ''
  let disabled = pending || frozen
  const gate = skill.gate?.[tool.id]
  if (status === 'missing') {
    note = '没找到 Codex'
    disabled = true
  } else if (status === 'unreadable' || state?.state === 'unavailable') {
    note = `${tool.label} 状态读不出`
    disabled = true
  } else if (gate && GATE_TEXT[gate.why]) {
    note = GATE_TEXT[gate.why](tool.label)
    disabled = true
  }
  const canFix = gate && (gate.why === 'same' || gate.why === 'external') && onFixGate
  return (
    <div className="np-row">
      <div className="lf sk-tool">
        <ToolIcon toolId={tool.id} />
        <div className="lf"><div className="lb">{tool.label}</div>{note && <div className="ds">{note}</div>}</div>
      </div>
      <span className="acts sk-acts">
        {canFix && <Button size="sm" className="np-btn" onClick={() => onFixGate(tool.id)} disabled={frozen}>换成链接</Button>}
        <Toggle checked={state?.enabled === true} disabled={disabled} onChange={(next) => onToggle(tool.id, next)} />
      </span>
    </div>
  )
}

/**
 * @param {object} props
 * @param {object} props.skill
 * @param {object|null} props.snapshot
 * @param {object|undefined} props.usage - { total, claude, codex }
 * @param {boolean} props.usageFailed
 * @param {'loading'|'refreshing'|'error'|'ready'} [props.usageStatus='ready'] - 数字读取中时清除旧数字与记录；
 *   refreshing（#101）时次数照旧显示、旁边标「更新中」，记录等新批次。
 * @param {() => void} props.onRetryUsage
 * @param {{status: string, records: Array, runs?: Array, unrecognized?: number}} props.records - runs 是子代理按派出合成的行；
 *   unrecognized 是认不出的调用次数（#97，只在明细里提示，不进次数）
 * @param {string[]} props.pluginNames - 同名的插件
 * @param {Set<string>} props.pendingKeys
 * @param {(toolId: string, enabled: boolean) => void} props.onToggle
 * @param {(toolId: string) => void} props.onFixGate - 占位里「换成链接」
 * @param {object|null} props.op - 这个名字最近一次还没撤回的收进
 * @param {boolean} props.showNext - 最近收进卡上出「下一个要处理」
 * @param {() => void} props.onUndo
 * @param {() => void} props.onResume
 * @param {() => void} props.onNext
 * @param {() => void} props.onDelete
 * @returns {JSX.Element}
 */
export default function SkillDetail({ skill, snapshot, usage, usageFailed, usageStatus = 'ready', onRetryUsage, records, pluginNames, pendingKeys, onToggle, onFixGate, op = null, showNext = false, onUndo, onResume, onNext, onDelete }) {
  const readOnly = isReadOnly(skill)
  const frozen = op?.state === 'partial'
  const opBusy = Boolean(op && (pendingKeys.has(`${skill.name}:undo:${op.operationId}`) || pendingKeys.has(`${skill.name}:resume:${op.operationId}`)))
  const total = usage?.total || 0
  const loading = usageStatus === 'loading'
  const usageUnavailable = usageFailed || usage?.availability === 'error'
  const failed = usageUnavailable || records?.status === 'error'
  // #97：认不出的调用只提示、不算数；确认数 0 时栏头写「近 30 天 0 次」，免得和提示打架
  const unrecognized = !loading && records?.status === 'ready' ? records.unrecognized || 0 : 0
  const countText = loading ? <span className="np-sk np-sk--pulse" style={{ width: 48, height: 12 }} />
    : usageUnavailable ? <>近 30 天 <span className="num">—</span> 次</>
      : total > 0 || unrecognized > 0 ? <>近 30 天 <span className="num">{total}</span> 次</> : <span>近 30 天没用</span>
  const updating = usageStatus === 'refreshing' && !usageUnavailable
  const duplicateTool = TOOLS.find((tool) => skill.tools?.[tool.id]?.duplicate)
  const shown = !loading && records?.status !== 'loading'
  // 主会话记录和子代理合成行按时间混排，新的在上；子代理行只换中间那栏的字
  const recordList = shown ? [
    ...(records?.records || []).map((record) => ({ ...record, rowKey: record.invocationId, label: record.tool === 'codex' ? 'Codex' : 'Claude Code' })),
    ...(records?.runs || []).map((run) => ({ ...run, rowKey: run.runId, label: subagentRunText(run) })),
  ].sort((a, b) => Date.parse(b.triggeredAt) - Date.parse(a.triggeredAt)) : []
  const recordRows = recordList.map((record) => (
    <div key={record.rowKey} className="np-lrow">
      <span className="t">{formatRecordTime(record.triggeredAt)}</span>
      <span>{record.label}</span>
      <span className="e">{recordProject(record)}</span>
    </div>
  ))

  return (
    <div className="np-pane np-pane--detail">
      <div className="np-pane-hd">
        <h2 className="ttl">{skill.displayName || skill.name}</h2>
        <div className="meta">
          <span>{sourceLabel(skill)}{readOnly ? '' : <> · {countText}{updating && <span className="sk-updating-inline"> · 更新中</span>}</>}</span>
        </div>
      </div>
      <div className="np-pane-body">
        {op && <RecentCard op={op} busy={opBusy} showNext={showNext} onUndo={onUndo} onResume={onResume} onNext={onNext} />}
        <div className="np-glabel">启用</div>
        <div className="np-card np-card--form">
          {TOOLS.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={tool}
              skill={skill}
              snapshot={snapshot}
              pending={pendingKeys.has(`${skill.name}:${tool.id}`)}
              frozen={frozen}
              onToggle={onToggle}
              onFixGate={onFixGate}
            />
          ))}
          {pluginNames.length > 0 && (
            <div className="np-row np-kv"><span className="lb">隶属插件</span><span className="v">{pluginNames.join('、')}</span></div>
          )}
          {duplicateTool && (
            <div className="np-row">
              <div className="lf">
                <div className="lb">{duplicateTool.label} 里有两份</div>
                <div className="ds warn">一份来自资产库，一份是旧目录里的副本，内容不一样，两份都在装载</div>
              </div>
            </div>
          )}
        </div>

        {!readOnly && (
          <>
            <div className="np-glabel">近 30 天调用{!loading && !failed && total > 0 && <span className="cnt">{total} 次</span>}</div>
            <div className="np-card np-card--form">
              {failed ? (
                <div className="np-row">
                  <span className="np-errline">调用数据读取失败</span>
                  <Button size="sm" className="np-btn" onClick={onRetryUsage}>重试</Button>
                </div>
              ) : loading || records?.status === 'loading' ? (
                <div className="np-row"><span className="np-empty">读取中…</span></div>
              ) : recordList.length === 0 ? (
                <div className="np-row"><span className="np-empty">{unrecognized > 0 ? `有 ${unrecognized} 次调用没认出来，次数可能偏少` : '近 30 天没有记录到调用'}</span></div>
              ) : (
                <>
                  {unrecognized > 0 && <div className="np-row"><span className="np-empty">另有 {unrecognized} 次调用没认出来，次数可能偏少</span></div>}
                  {recordRows}
                </>
              )}
            </div>
          </>
        )}

        <div className="np-glabel">说明</div>
        <div className="np-read sk-desc"><p>{skill.description || '暂无说明'}</p></div>

        <div className="np-glabel">位置</div>
        <div className="np-card np-card--form">
          {(skill.locations || []).map((location, index) => (
            <div key={`${location.toolId}-${index}`} className="np-row sk-prow">
              <div className="lf">
                <div className="lb">{LOCATION_LABEL[location.toolId] || location.toolId}</div>
                <div className="sk-p">{location.path}</div>
                {location.target && <div className="sk-p sk-to">→ {location.target}</div>}
                {location.missing && <div className="sk-p sk-bad">找不到这个文件夹</div>}
              </div>
            </div>
          ))}
        </div>

        {skill.managed && (
          <>
            <div className="np-glabel">删除</div>
            <div className="np-card np-card--form">
              <div className="np-row">
                <div className="lf"><div className="lb">从资产库删除</div><div className="ds">资产库和各工具里的都会删掉</div></div>
                <Button size="sm" variant="danger" className="np-btn" onClick={onDelete} disabled={frozen}>删除</Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
