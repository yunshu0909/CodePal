/**
 * 模型接入页 · 被挡住卡
 *
 * 负责：
 * - 页面最上面一张普通灰底卡，一个外部条件一行：没找到 Claude Code / 版本太旧（F1）、
 *   终端命令未安装或还在用另一个 CodePal（F3）
 * - 每行：名称（可带一句说明）+ 橙点 + 按钮；主按钮由页面按「填写 Key > 重新检测 > 安装命令」决定
 *
 * @module features/models/BlockCard
 */

import Button from '../../components/Button/Button'

/**
 * @param {Object} props
 * @param {{title: string, desc: string|null, status: string}|null} props.claude - Claude Code 那一行；null 不显示
 * @param {{title: string, desc: string|null, status: string}|null} props.install - 终端命令那一行；null 不显示
 * @param {'key'|'recheck'|'install'|null} props.primary - 这一屏的主按钮
 * @param {boolean} props.rechecking
 * @param {boolean} props.installing
 * @param {() => void} props.onRecheck
 * @param {() => void} props.onInstall
 * @returns {JSX.Element|null}
 */
export default function BlockCard({ claude, install, primary, rechecking, installing, onRecheck, onInstall }) {
  if (!claude && !install) return null
  return (
    <section className="np-card mj-block">
      {claude && (
        <div className="np-hstack mj-bline">
          <div className="lf">
            <div className="mj-bt">{claude.title}</div>
            {claude.desc && <div className="mj-bdesc">{claude.desc}</div>}
          </div>
          <span className="np-st warn push"><i />{claude.status}</span>
          <Button size="sm" className="np-btn" variant={primary === 'recheck' ? 'primary' : 'secondary'} disabled={rechecking} onClick={onRecheck}>
            重新检测
          </Button>
        </div>
      )}
      {install && (
        <div className="np-hstack mj-bline">
          <div className="lf">
            <div className="mj-bt">{install.title}</div>
            {install.desc && <div className="mj-bdesc">{install.desc}</div>}
          </div>
          <span className="np-st warn push"><i />{install.status}</span>
          <Button size="sm" className="np-btn" variant={primary === 'install' && !installing ? 'primary' : 'secondary'} disabled={installing} onClick={onInstall}>
            {installing ? '安装中…' : '安装命令'}
          </Button>
        </div>
      )}
    </section>
  )
}
