/**
 * Harness 安装卡
 *
 * 负责：装在哪、什么版本、怎么更新。卡头只写「安装」+ 当前版本（版本号全页只出现这一次）；
 * PATH 版拿不到版本号，卡头只写「安装」。
 *
 * @module pages/harness/HarnessInstallPanel
 */

import { HarnessPanel } from './HarnessRunPanel'

export default function HarnessInstallPanel({ install, onAction }) {
  return <HarnessPanel name="安装" title="安装" meta={install.meta} rows={install.rows} foot={install.foot} onAction={onAction} />
}
