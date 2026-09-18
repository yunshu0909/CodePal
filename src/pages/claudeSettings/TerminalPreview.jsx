/**
 * 终端预览
 *
 * 负责：
 * - 按 Claude Code 底部真实顺序画输入框、状态栏两行、模式行
 * - 状态栏两行用固定示例数据，只在已接入且开关开时画（与脚本关闭时整条不输出一致）
 * - 模式行按当前默认模式；每次询问与未配置显示「? for shortcuts」
 *
 * @module pages/claudeSettings/TerminalPreview
 */

import { EXAMPLE, MODE_LINES, contextBar, pctTone } from './claudeSettings'

/**
 * @param {object} props
 * @param {string|null} props.mode - 当前默认模式
 * @param {boolean} props.showStatusLine - 已接入且开关开
 * @returns {JSX.Element}
 */
export default function TerminalPreview({ mode, showStatusLine }) {
  const line = MODE_LINES[mode]
  const bar = contextBar(EXAMPLE.ctx)
  const sep = <span className="d"> | </span>
  return (
    <div className="cc-term" data-testid="cc-terminal-preview">
      <div className="rule" />
      <div><span className="d">&gt;</span> <span className="cur" /></div>
      <div className="rule" />
      {showStatusLine && (
        <>
          <div>
            <span className="b">{EXAMPLE.model}</span>{sep}
            <span className={pctTone(EXAMPLE.ctx, true)}>{bar.filled}</span><span className="d">{bar.empty}</span>{' '}
            <span className={pctTone(EXAMPLE.ctx, true)}>{EXAMPLE.ctx}%</span>{sep}
            5h:<span className={pctTone(EXAMPLE.five)}>{EXAMPLE.five}%</span>{sep}
            7d:<span className={pctTone(EXAMPLE.week)}>{EXAMPLE.week}%</span>{sep}
            <span className="d">resets {EXAMPLE.reset}</span>
          </div>
          <div>git:{EXAMPLE.branch}*</div>
        </>
      )}
      {line
        ? <div><span className={`m-${line.tone}`}>{line.text}</span> <span className="d">(shift+tab to cycle)</span></div>
        : <div className="d">? for shortcuts</div>}
    </div>
  )
}
