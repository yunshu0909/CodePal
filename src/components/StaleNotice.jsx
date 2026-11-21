/**
 * 「这次没更新」的一行（#100）
 *
 * 切回页面后后台重读失败、屏上还留着上次的内容时，放在内容上方：红字 + 重试。
 * 样式照会话状态页已有的读取失败卡片（np-card + np-errline），文案照 Skills 已有的说法（#56「失败保留旧内容并提示」）。
 *
 * @module components/StaleNotice
 */

import Button from './Button/Button'

/**
 * @param {object} props
 * @param {() => void} [props.onRetry] - 重试；不给就不出按钮
 * @param {boolean} [props.bare=false] - 不包卡片（放在栏里时用）
 * @param {string} [props.className] - 不包卡片时这一行的位置类
 * @returns {JSX.Element}
 */
export default function StaleNotice({ onRetry, bare = false, className = '' }) {
  const line = (
    <div className={`np-errline${bare && className ? ` ${className}` : ''}`} role="status">
      读取失败，下面是上次读到的结果
      {onRetry && <Button size="sm" onClick={onRetry}>重试</Button>}
    </div>
  )
  return bare ? line : <div className="np-card">{line}</div>
}
