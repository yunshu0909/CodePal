/**
 * 组件库预览页
 *
 * 展示所有基础组件的变体与状态，仅用于开发期间预览
 *
 * @module pages/ComponentPreviewPage
 */

import React, { useState } from 'react'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Tag from '../components/Tag/Tag'
import SearchInput from '../components/SearchInput/SearchInput'
import StateView from '../components/StateView/StateView'
import Modal from '../components/Modal/Modal'
import Toast from '../components/Toast'
import Toggle from '../components/Toggle'
import Checkbox from '../components/Checkbox'
import './ComponentPreviewPage.css'

// ── 区块容器 ──────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <section className="cp-section">
      <h2 className="cp-section__title">{title}</h2>
      <div className="cp-section__body">{children}</div>
    </section>
  )
}

// ── 单行展示 ──────────────────────────────────────────────
function Row({ label, children }) {
  return (
    <div className="cp-row">
      <span className="cp-row__label">{label}</span>
      <div className="cp-row__content">{children}</div>
    </div>
  )
}

export default function ComponentPreviewPage() {
  // SearchInput
  const [searchVal, setSearchVal] = useState('')

  // Modal
  const [modalSize, setModalSize] = useState(null)

  // StateView
  const [stateDemo, setStateDemo] = useState('loading')

  // Toast
  const [toast, setToast] = useState(null)

  // Toggle
  const [toggle1, setToggle1] = useState(true)
  const [toggle2, setToggle2] = useState(false)

  // Checkbox
  const [cb1, setCb1] = useState(true)
  const [cb2, setCb2] = useState(false)

  return (
    <PageShell title="组件库预览" subtitle="所有基础组件的变体与状态一览">

      {/* ── Button ─────────────────────────────────────── */}
      <Section title="Button">
        <Row label="变体">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost</Button>
        </Row>
        <Row label="尺寸">
          <Button variant="primary" size="lg">Large</Button>
          <Button variant="primary" size="md">Medium</Button>
          <Button variant="primary" size="sm">Small</Button>
        </Row>
        <Row label="状态">
          <Button variant="primary" loading>加载中</Button>
          <Button variant="secondary" loading>保存中</Button>
          <Button variant="primary" disabled>已禁用</Button>
          <Button variant="secondary" disabled>已禁用</Button>
        </Row>
      </Section>

      {/* ── Tag ────────────────────────────────────────── */}
      <Section title="Tag">
        <Row label="变体">
          <Tag variant="success">已推送</Tag>
          <Tag variant="danger">已停用</Tag>
          <Tag variant="warning">待处理</Tag>
          <Tag variant="info">stdio</Tag>
          <Tag variant="default">未知</Tag>
        </Row>
        <Row label="尺寸">
          <Tag variant="success" size="sm">sm 尺寸</Tag>
          <Tag variant="success" size="md">md 尺寸</Tag>
        </Row>
      </Section>

      {/* ── Toggle ─────────────────────────────────────── */}
      <Section title="Toggle">
        <Row label="开启">
          <Toggle checked={toggle1} onChange={setToggle1} />
          <span className="cp-hint">{toggle1 ? 'on' : 'off'}</span>
        </Row>
        <Row label="关闭">
          <Toggle checked={toggle2} onChange={setToggle2} />
          <span className="cp-hint">{toggle2 ? 'on' : 'off'}</span>
        </Row>
        <Row label="禁用">
          <Toggle checked={true} onChange={() => {}} disabled />
          <Toggle checked={false} onChange={() => {}} disabled />
        </Row>
      </Section>

      {/* ── Checkbox ───────────────────────────────────── */}
      <Section title="Checkbox">
        <Row label="选中">
          <div onClick={() => setCb1(!cb1)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <Checkbox checked={cb1} />
            <span className="cp-hint">点击切换</span>
          </div>
        </Row>
        <Row label="未选">
          <div onClick={() => setCb2(!cb2)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <Checkbox checked={cb2} />
            <span className="cp-hint">点击切换</span>
          </div>
        </Row>
        <Row label="半选">
          <Checkbox checked={false} indeterminate />
          <span className="cp-hint">indeterminate</span>
        </Row>
      </Section>

      {/* ── SearchInput ────────────────────────────────── */}
      <Section title="SearchInput">
        <Row label="默认">
          <div style={{ width: 280 }}>
            <SearchInput
              value={searchVal}
              onChange={(e) => setSearchVal(e.target.value)}
              placeholder="搜索 Skill..."
            />
          </div>
        </Row>
        <Row label="禁用">
          <div style={{ width: 280 }}>
            <SearchInput value="" onChange={() => {}} placeholder="搜索 MCP..." disabled />
          </div>
        </Row>
      </Section>

      {/* ── Toast ──────────────────────────────────────── */}
      <Section title="Toast">
        <Row label="触发">
          <Button variant="secondary" size="sm" onClick={() => setToast({ message: '操作成功', type: 'success' })}>success</Button>
          <Button variant="secondary" size="sm" onClick={() => setToast({ message: '发生错误，请重试', type: 'error' })}>error</Button>
          <Button variant="secondary" size="sm" onClick={() => setToast({ message: '注意：配置已变更', type: 'warning' })}>warning</Button>
          <Button variant="secondary" size="sm" onClick={() => setToast({ message: '这是一条普通提示', type: 'info' })}>info</Button>
        </Row>
        <p className="cp-desc">Toast 显示 3 秒后自动消失，点击上方按钮触发。</p>
      </Section>

      {/* ── StateView ──────────────────────────────────── */}
      <Section title="StateView">
        <Row label="切换">
          <Button variant={stateDemo === 'loading' ? 'primary' : 'secondary'} size="sm" onClick={() => setStateDemo('loading')}>Loading</Button>
          <Button variant={stateDemo === 'error'   ? 'primary' : 'secondary'} size="sm" onClick={() => setStateDemo('error')}>Error</Button>
          <Button variant={stateDemo === 'empty'   ? 'primary' : 'secondary'} size="sm" onClick={() => setStateDemo('empty')}>Empty</Button>
        </Row>
        <div className="cp-state-demo">
          <StateView
            loading={stateDemo === 'loading'}
            error={stateDemo === 'error' ? '扫描配置文件失败，请检查路径是否正确' : null}
            empty={stateDemo === 'empty'}
            onRetry={() => setToast({ message: '已触发重试', type: 'info' })}
            emptyMessage="暂无数据"
            emptyHint="请先在工具中添加配置"
          />
        </div>
      </Section>

      {/* ── Modal ──────────────────────────────────────── */}
      <Section title="Modal">
        <Row label="尺寸">
          <Button variant="secondary" size="sm" onClick={() => setModalSize('sm')}>sm</Button>
          <Button variant="secondary" size="sm" onClick={() => setModalSize('md')}>md</Button>
          <Button variant="secondary" size="sm" onClick={() => setModalSize('lg')}>lg</Button>
        </Row>
        <Row label="变体">
          <Button variant="ghost" size="sm" onClick={() => setModalSize('no-footer')}>无 Footer</Button>
        </Row>
      </Section>

      {/* Modal 实例 */}
      <Modal
        open={modalSize !== null && modalSize !== 'no-footer'}
        onClose={() => setModalSize(null)}
        title={`Modal — ${modalSize} 尺寸`}
        size={modalSize || 'md'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalSize(null)}>取消</Button>
            <Button variant="primary" onClick={() => { setModalSize(null); setToast({ message: '点击了确认', type: 'success' }) }}>确认</Button>
          </>
        }
      >
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0, lineHeight: 1.7 }}>
          这是弹窗的主体内容区。支持任意 ReactNode，内容超长时自动出现滚动条。<br />
          当前尺寸：<strong style={{ color: 'var(--text-primary)' }}>{modalSize}</strong>
        </p>
      </Modal>

      <Modal
        open={modalSize === 'no-footer'}
        onClose={() => setModalSize(null)}
        title="无 Footer 的弹窗"
      >
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0, lineHeight: 1.7 }}>
          不传 <code>footer</code> prop 时底部区域不渲染。右上角关闭按钮仍然存在，ESC 也可关闭。
        </p>
      </Modal>

      {/* Toast 实例 */}
      {toast && (
        <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}

    </PageShell>
  )
}
