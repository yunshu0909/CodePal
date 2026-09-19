/**
 * 关于 CodePal（设计总纲 3.19，品牌定稿 B2）
 *
 * 负责：
 * - App 图标、名字、版本与是否最新、三个外链（GitHub / 更新说明 / 反馈问题）、一句定位与版权
 * - 从侧栏品牌头或菜单「关于 CodePal」打开；用全局对话框（Modal），不另开窗口
 *
 * @module components/brand/AboutDialog
 */

import Modal from '../Modal/Modal'
import appIcon from '../../../assets/app-icons/icon.png'
import './brand.css'

const REPO_URL = 'https://github.com/yunshu0909/CodePal'
const LINKS = [
  { label: 'GitHub', url: REPO_URL },
  { label: '更新说明', url: `${REPO_URL}/releases` },
  { label: '反馈问题', url: `${REPO_URL}/issues` },
]

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {string} props.version - 本机版本
 * @param {object} props.update - 应用更新状态（hasUpdate / latestVersion / checked）
 * @param {() => void} props.onShowUpdate - 有新版时点版本行打开「新版本」对话框
 * @returns {JSX.Element}
 */
export default function AboutDialog({ open, onClose, version, update, onShowUpdate }) {
  const open_ = (url) => window.electronAPI?.openExternalLink?.(url)
  let status = null
  if (update?.hasUpdate) status = <button type="button" className="brand-about__update" onClick={onShowUpdate}>有新版本 {update.latestVersion}</button>
  else if (update?.checked && !update?.error) status = <span>已是最新</span>

  return (
    <Modal open={open} onClose={onClose} size="sm">
      <div className="brand-about">
        <img className="brand-about__icon" src={appIcon} alt="" />
        <div className="brand-about__name">CodePal</div>
        <div className="brand-about__ver">版本 {version}{status && <> · {status}</>}</div>
        <div className="brand-about__links">
          {LINKS.map((link) => (
            <button key={link.label} type="button" onClick={() => open_(link.url)}>{link.label} ↗</button>
          ))}
        </div>
        <div className="brand-about__foot">AI 编程的伴侣仪表盘<br />© 2026 yunshu0909</div>
      </div>
    </Modal>
  )
}
