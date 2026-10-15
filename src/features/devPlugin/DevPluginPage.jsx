/**
 * 插件管理（开发流程 › 插件管理，v2.1.25）
 *
 * 看 dev-workflow 是哪一版、在 Claude Code 和 Codex 里开没开，按需开或关（改动即保存）。
 * 状态与写入逻辑在 useDevPlugin；本文件只负责按定稿摆放：身份卡 → 「启用」→ 两行开关。
 *
 * @module features/devPlugin/DevPluginPage
 */

import React from 'react'
import PageShell from '../../components/PageShell'
import StateView from '../../components/StateView/StateView'
import Toggle from '../../components/Toggle'
import useDevPlugin, { TOOL_NAMES } from './useDevPlugin'
import './devPlugin.css'

const PLUGIN_ICON = 'M4.5 2.5v11M4.5 9.5h4a3 3 0 0 0 3-3v-4M11.5 2.5 9.5 4.5M11.5 2.5l2 2'
const TOOL_ROWS = [
  { tool: 'claude', color: 'var(--tool-claude)', icon: 'M3 4.5 6.5 8 3 11.5M8 12h5', where: '装在 ~/.claude/skills/dev-workflow' },
  { tool: 'codex', color: 'var(--tool-codex)', icon: 'M5 5.5 2.5 8 5 10.5M11 5.5 13.5 8 11 10.5', where: '装在 ~/.codex 插件缓存' },
]

/** 图标方块 */
function Icon({ color, path, className = '' }) {
  return (
    <span className={`np-ic ${className}`} style={{ '--c': color }} aria-hidden="true">
      <svg viewBox="0 0 16 16"><path d={path} /></svg>
    </span>
  )
}

/** 一行说明：保存中 > 没装 > 被锁定 > 装在哪 */
function rowHint(row, where) {
  if (row.saving) return '正在保存…'
  if (!row.installed) return '没装这个插件'
  if (row.locked) return '被系统管理设置锁定'
  return where
}

/** 首次读取：身份卡与两行原位骨架 */
function Skeleton() {
  return (
    <>
      <div className="np-card">
        <div className="pm-hero">
          <span className="np-sk np-sk--pulse pm-sk-ic" />
          <div>
            <span className="np-sk np-sk--pulse" style={{ width: 140 }} />
            <div className="pm-sk-line"><span className="np-sk np-sk--pulse" style={{ width: 220 }} /></div>
          </div>
        </div>
      </div>
      <div className="np-glabel">启用</div>
      <div className="np-card np-card--form">
        {TOOL_ROWS.map(({ tool }) => (
          <div key={tool} className="np-row">
            <div className="np-hstack">
              <span className="np-sk np-sk--pulse" style={{ width: 20 }} />
              <div className="lf">
                <span className="np-sk np-sk--pulse" style={{ width: 90 }} />
                <div className="pm-sk-line"><span className="np-sk np-sk--pulse" style={{ width: 200 }} /></div>
              </div>
            </div>
            <span className="np-sk np-sk--pulse" style={{ width: 36 }} />
          </div>
        ))}
      </div>
    </>
  )
}

export default function DevPluginPage() {
  const { status, error, versionText, rows, retry, setEnabled } = useDevPlugin()

  return (
    <PageShell title="插件管理" native>
      <div className="np-scroll">
        <StateView error={status === 'error' ? error : null} onRetry={retry}>
          {status !== 'ready' ? <Skeleton /> : (
            <>
              <div className="np-card">
                <div className="pm-hero">
                  <Icon className="pm-ic" color="var(--ic-teal)" path={PLUGIN_ICON} />
                  <div>
                    <div className="nm">dev-workflow</div>
                    <div className="sb">需求 → 测试 → 交叉审核 → 验收的开发流程插件</div>
                  </div>
                  <span className="end">{versionText}</span>
                </div>
              </div>
              <div className="np-glabel">启用</div>
              <div className="np-card np-card--form">
                {TOOL_ROWS.map(({ tool, color, icon, where }) => {
                  const row = rows[tool]
                  const disabled = row.saving || !row.installed || row.locked
                  return (
                    <div key={tool} className="np-row" data-dev-tool={tool}>
                      <div className="np-hstack">
                        <Icon className="np-ic--s20" color={color} path={icon} />
                        <div className="lf">
                          <div className="lb">{TOOL_NAMES[tool]}</div>
                          <div className="ds">{rowHint(row, where)}</div>
                        </div>
                      </div>
                      <Toggle
                        checked={row.installed ? row.enabled : false}
                        disabled={disabled}
                        onChange={(next) => setEnabled(tool, next)}
                        aria-label={`在 ${TOOL_NAMES[tool]} 里启用 dev-workflow`}
                      />
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </StateView>
      </div>
    </PageShell>
  )
}
