/**
 * 新版本对话框（品牌定稿 M2：先在应用里看更新内容，再去下载）
 *
 * 负责：
 * - 新版本号、本机版本、发布说明前几条
 * - 「以后再说」关掉；「下载新版」打开 GitHub 发布页（应用未签名，不做自动替换）
 *
 * @module components/brand/UpdateDialog
 */

import Modal from '../Modal/Modal'
import Button from '../Button/Button'
import { summarizeReleaseNotes } from './releaseNotes'
import './brand.css'

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {string} props.currentVersion
 * @param {string} props.latestVersion
 * @param {string} props.releaseNotes - 发布说明原文（Markdown）
 * @param {() => void} props.onDownload
 * @returns {JSX.Element}
 */
export default function UpdateDialog({ open, onClose, currentVersion, latestVersion, releaseNotes, onDownload }) {
  const { lines, more } = summarizeReleaseNotes(releaseNotes)
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={`CodePal ${latestVersion} 可以更新了`}
      description={`你现在用的是 ${currentVersion}。`}
      showCloseButton={false}
      footer={(
        <>
          <Button onClick={onClose}>以后再说</Button>
          <Button variant="primary" onClick={() => { onDownload(); onClose() }}>下载新版</Button>
        </>
      )}
    >
      {lines.length > 0 && (
        <ul className="brand-update__notes">
          {lines.map((line, index) => <li key={index}>{line}</li>)}
          {more && <li className="brand-update__more">完整说明见下载页</li>}
        </ul>
      )}
    </Modal>
  )
}
