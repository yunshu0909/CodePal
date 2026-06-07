/**
 * V1.7 数据迁移进度屏（US-01）
 *
 * 显示场景：
 * - 用户第一次升级到 V1.7、bootstrap 触发 migration.shouldMigrate=true → 进度屏出现
 * - 迁移成功 → 短暂显示 "V1.7 已升级，X 个账号已就位" 后关闭
 * - 迁移失败 → 显示错误屏 + "联系支持" 入口（CodePal 自动降级到只读 V1.6 兼容模式）
 *
 * @module pages/codex-account/CodexMigrationProgressV17
 */

import React from 'react'
import Modal from '../../components/Modal/Modal'
import Button from '../../components/Button/Button'

/**
 * @param {{
 *   open: boolean,
 *   phase: 'started' | 'done',
 *   migrationResult?: { ok: boolean, stage?: string, accounts?: string[], active?: string | null, error?: { code?: string, message?: string } },
 *   onClose: () => void,
 * }} props
 */
export default function CodexMigrationProgressV17({ open, phase, migrationResult, onClose }) {
  if (!open) return null

  if (phase === 'started') {
    // V1.7 P1-2 修复：用 Modal footer prop 而不是内联 children div
    return (
      <Modal open={open} title="正在升级到 V1.7…" onClose={() => {}} closeOnOverlay={false}>
        <div className="codex-migration">
          <div className="codex-migration__spinner"><span className="codex-spinner" /></div>
          <p>正在重组本地账户目录，约 2-5 秒。</p>
          <p className="codex-migration__hint">旧数据会冷备份保留 90 天，本次升级永不删除任何账号。</p>
        </div>
      </Modal>
    )
  }

  // phase === 'done'
  if (migrationResult?.ok) {
    const count = migrationResult.accounts?.length ?? 0
    return (
      <Modal
        open={open}
        title="V1.7 升级完成"
        onClose={onClose}
        footer={<Button variant="primary" onClick={onClose}>知道了</Button>}
      >
        <div className="codex-migration">
          <p><strong>{count}</strong> 个账号已就位。</p>
          {migrationResult.active && <p>当前激活：{migrationResult.active}</p>}
          <p className="codex-migration__hint">下次切换更稳定。旧数据冷备份 90 天后自动清理。</p>
        </div>
      </Modal>
    )
  }

  // 失败
  const stage = migrationResult?.stage || 'unknown'
  const errMsg = migrationResult?.error?.message || '未知错误'
  const errCode = migrationResult?.error?.code || ''
  // V1.7 P0-7 修复：shell.openExternal 未在 preload 暴露，改用 a 标签 target=_blank
  // （Electron renderer 默认会拦截 navigation，但 _blank 链接会被 default OS browser 打开，
  //  通过 main.js 的 will-navigate 处理；若未来需要明确暴露 shell，再补 preload）
  const supportUrl = 'https://github.com/yunshu0909/CodePal/issues'
  return (
    <Modal
      open={open}
      title="V1.7 升级失败"
      onClose={() => {}}
      closeOnOverlay={false}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>稍后再说</Button>
          <a
            href={supportUrl}
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: 'none' }}
          >
            <Button variant="primary">联系支持</Button>
          </a>
        </>
      )}
    >
      <div className="codex-migration codex-migration--error">
        <p>升级过程中出现错误：</p>
        <pre className="codex-migration__error-detail">
{`stage: ${stage}
code: ${errCode}
message: ${errMsg}`}
        </pre>
        <p>你的旧账号数据未被改动，CodePal 已进入只读兼容模式（不允许保存 / 切换 / 续期，可以查看列表）。</p>
        <p className="codex-migration__hint">请联系支持团队，把上面的错误信息一并提供。</p>
      </div>
    </Modal>
  )
}
