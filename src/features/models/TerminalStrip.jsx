/**
 * 模型接入页 · 顶上「在终端里用」一行
 *
 * 负责：
 * - 灰底表单型卡里一行：灰色终端图标 + 名称 + 一句说明（可换行，最多两行）+ 状态点，需要动手时再跟一个按钮
 * - 首次读取（strip === undefined）原地骨架；一个模型都没加（strip === null）不出现
 * - 加入 PATH 确认框的说明（PathConfirmBody）：改哪个文件、加哪一行、新开终端才生效
 *
 * 设计定稿：specs/v2.1.22-在终端里用/模型接入-定稿/前端设计定稿-模型接入.md §2、§3、§4
 *
 * @module features/models/TerminalStrip
 */

import Button from '../../components/Button/Button'
import { PATH_LINE } from './modelsView'

const IDLE_TEXT = { install: '安装命令', update: '更新命令', path: '加入 PATH' }
const BUSY_TEXT = { install: '安装中…', update: '更新中…' }

/** 说明里的 codepal 用等宽字 */
function Desc({ text }) {
  const parts = text.split('codepal')
  return (
    <div className="ds">
      {parts.map((part, i) => (
        <span key={i}>{i > 0 && <span className="mj-cmd">codepal</span>}{part}</span>
      ))}
    </div>
  )
}

/**
 * @param {Object} props
 * @param {ReturnType<import('./modelsView').terminalStrip>|undefined} props.strip - undefined = 首次读取中
 * @param {boolean} props.primary - 按钮是不是这一屏的主按钮
 * @param {'install'|'update'|null} props.busy - 正在安装 / 更新
 * @param {() => void} props.onInstall - 安装命令、更新命令共用
 * @param {() => void} props.onAddToPath
 * @returns {JSX.Element|null}
 */
export default function TerminalStrip({ strip, primary, busy, onInstall, onAddToPath }) {
  if (strip === null) return null
  if (strip === undefined) {
    return (
      <div className="np-card np-card--form mj-strip">
        <div className="np-row">
          <span className="np-sk np-sk--pulse mj-sk-strip" />
          <span className="np-sk np-sk--pulse mj-sk-btn" />
        </div>
      </div>
    )
  }
  const { action } = strip
  const running = Boolean(busy) && action !== 'path'
  return (
    <div className="np-card np-card--form mj-strip">
      <div className="np-row">
        <div className="lf np-hstack">
          <span className="np-ic np-ic--s20" style={{ '--c': 'var(--ic-gray)' }} aria-hidden="true">
            <svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M5 6.5 7 8 5 9.5M8.5 10h2.5" /></svg>
          </span>
          <div className="lf">
            <div className="lb">在终端里用</div>
            <Desc text={strip.text} />
          </div>
        </div>
        <div className="np-card-acts">
          <span className={`np-st${strip.tone ? ` ${strip.tone}` : ''}`}><i />{strip.status}</span>
          {action && (
            <Button
              size="sm"
              className="np-btn"
              variant={primary && !running ? 'primary' : 'secondary'}
              disabled={running}
              onClick={action === 'path' ? onAddToPath : onInstall}
            >
              {running ? BUSY_TEXT[busy] || BUSY_TEXT.install : IDLE_TEXT[action]}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 加入 PATH 确认框的说明（定稿 §4）
 * @param {{profile: string}} props - 要写的文件，~ 开头
 * @returns {JSX.Element}
 */
export function PathConfirmBody({ profile }) {
  return (
    <span className="mj-pathdlg">
      <span>终端是按 PATH 里列出的文件夹去找命令的。CodePal 会在 {profile}（终端每次打开时读的设置文件）最后加上这一行：</span>
      <code className="mj-pathline">{PATH_LINE}</code>
      <span>加好后，新打开的终端窗口就能用 codepal 了；已经开着的终端窗口（包括 VS Code 里的）要关掉重开一个。</span>
    </span>
  )
}
