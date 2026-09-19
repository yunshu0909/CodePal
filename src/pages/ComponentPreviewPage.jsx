/**
 * 组件库预览页
 *
 * 展示所有基础组件的变体与状态，仅用于开发期间预览
 *
 * @module pages/ComponentPreviewPage
 */

import React, { useState } from 'react'
import PlanCard from './plan/components/PlanCard'
import './plan/plan.css'
import PageShell from '../components/PageShell'
import Button from '../components/Button/Button'
import Tag from '../components/Tag/Tag'
import SearchInput from '../components/SearchInput/SearchInput'
import StateView from '../components/StateView/StateView'
import Modal from '../components/Modal/Modal'
import { confirmDialog } from '../components/Modal/confirmDialog'
import SegmentedControl from '../components/SegmentedControl/SegmentedControl'
import { toast } from '../components/Toast'
import Toggle from '../components/Toggle'
import Checkbox from '../components/Checkbox'
import './ComponentPreviewPage.css'
import DayRing from './usage/components/DayRing'
import UsageCalendar from './usage/components/UsageCalendar'
import './usage/calendar.css'

const COLOR_TOKEN_PREVIEW = [
  { name: 'Primary', token: '--color-primary', value: '#2563eb' },
  { name: 'Success', token: '--color-success', value: '#16a34a' },
  { name: 'Warning', token: '--color-warning', value: '#d97706' },
  { name: 'Danger', token: '--color-danger', value: '#dc2626' },
  { name: 'Text', token: '--text-primary', value: '#1a1d23' },
  { name: 'Muted', token: '--bg-muted', value: '#eef0f4' },
]

const TEXT_TOKEN_PREVIEW = ['--text-xl', '--text-lg', '--text-md', '--text-base', '--text-sm', '--text-xs']
const RADIUS_TOKEN_PREVIEW = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-3xl']

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

/**
 * 组件库预览页
 * @returns {React.ReactElement}
 */
export default function ComponentPreviewPage() {
  // SearchInput
  const [searchVal, setSearchVal] = useState('')

  // Modal
  const [modalSize, setModalSize] = useState(null)

  // StateView
  const [stateDemo, setStateDemo] = useState('loading')


  // SegmentedControl
  const [segment, setSegment] = useState('all')

  // Toggle
  const [toggle1, setToggle1] = useState(true)
  const [toggle2, setToggle2] = useState(false)

  // Checkbox
  const [cb1, setCb1] = useState(true)
  const [cb2, setCb2] = useState(false)

  return (
    <PageShell title="组件库预览" subtitle="所有基础组件的变体与状态一览">

      <Section title="订阅管理 · 定稿卡片"><div className="plan-page plan-preview np-scope"><PlanCard planId="claude" plan={{version:1,price:20,billingDay:20,autoRenew:false,stopped:false,cycles:[{id:'preview',start:'2026-08-20',end:'2026-09-20',price:20}]}} cycle={{id:'preview',start:'2026-08-20',end:'2026-09-20',price:20}} metadata={{type:'Pro'}} today="2026-09-16" usage={{total:751,models:[{name:'Claude Opus 5',cost:562},{name:'Claude Fable 5.1',cost:183},{name:'Claude Sonnet 5',cost:6}]}} onSave={async()=>({success:false})} onAction={()=>{}} onNavigate={()=>{}}/></div></Section>
      {/* ── Native+ 共用组件（styles/native.css，前缀 np-）──── */}
      <Section title="Native+ 共用组件">
        <div className="np-scope cp-native">
          <Row label="灰底卡 / 表单型卡 / 分组小标题">
            <div className="cp-native__col">
              <div className="np-card">普通灰底卡：内边距 14 16，圆角 12，不画线不加阴影</div>
              <div className="np-glabel">分组小标题</div>
              <div className="np-card np-card--form">
                <div className="np-row"><div className="lf"><div className="lb">表单行</div><div className="ds">一行描述，放不下单行省略</div></div><span className="np-st"><i />已接入</span></div>
                <div className="np-row"><div className="lb">带开关</div><Toggle checked onChange={() => {}} /></div>
                <div className="np-row dis"><div className="lf"><div className="lb">禁用行</div><div className="ds">名称和说明一起 .5</div></div><Toggle checked={false} disabled onChange={() => {}} /></div>
              </div>
            </div>
          </Row>
          <Row label="小号按钮">
            <Button size="sm">重试</Button>
            <Button size="sm" variant="primary">立即接入</Button>
            <Button size="sm" variant="danger">从工具移除</Button>
            <Button size="sm" disabled>禁用</Button>
          </Row>
          <Row label="状态标签">
            {['blue', 'green', 'purple', 'orange', 'red', 'gray'].map((c) => <span key={c} className={`np-tag np-tag--${c}`}>{{ blue: '还差 180M', green: '已达成', purple: '优秀', orange: '快到期', red: '已到期 · 待确认', gray: '已停' }[c]}</span>)}
          </Row>
          <Row label="状态点">
            <span className="np-st"><i />已接入</span>
            <span className="np-st off"><i />未接入</span>
            <span className="np-st warn"><i />检测到已有自定义 statusLine</span>
            <span className="np-st bad"><i />无法读取额度状态</span>
          </Row>
          <Row label="弹层与输入框">
            <div className="np-pop cp-native__pop">
              <b>订阅设置</b>
              <input className="np-in" defaultValue="$100" aria-label="正常输入框" />
              <input className="np-in" defaultValue="每月 32 号" aria-invalid="true" aria-label="非法输入框" />
            </div>
          </Row>
          <Row label="条形行">
            <div className="cp-native__col">
              {[['Claude Opus 5', 72, '$562', 'var(--m0)'], ['Claude Fable 5.1', 31, '$183', 'var(--m1)'], ['其他 2 个', 4, '$6', 'var(--fg-4)']].map(([n, w, v, c]) => (
                <div key={n} className="np-meter cp-native__meter" style={{ '--mc': c }}><span>{n}</span><span className="np-meter-bar"><i style={{ width: `${w}%` }} /></span><b>{v}</b></div>
              ))}
            </div>
          </Row>
          <Row label="骨架">
            <span className="np-sk" style={{ width: 96 }} />
            <span className="np-sk np-sk--pulse" style={{ width: 64 }} />
          </Row>
        </div>
      </Section>

      {/* ── 列表与阅读（styles/native.css，对话回顾定稿回流）──── */}
      <Section title="Native+ 列表与阅读">
        <div className="np-scope cp-native">
          <div className="np-filterbar">
            <div className="np-sf"><svg viewBox="0 0 12 12"><circle cx="5" cy="5" r="3.6" /><path d="m7.8 7.8 2.6 2.6" /></svg><input placeholder="搜索框 np-sf" readOnly /></div>
            <button type="button" className="np-popbtn">弹出按钮 np-popbtn<svg className="chev" viewBox="0 0 10 10"><path d="M2.5 4 5 6.5 7.5 4" /></svg></button>
          </div>
          <div className="np-glabel">两行记录行 np-row--rec<span className="cnt">2</span></div>
          <div className="np-card np-card--form">
            {[['blue', '网络诊断页重做：出口 IP 与通知', 'OK 启动新版本我看看', 'skills', '14:36'], ['purple', '修复用量监测切换月份后数据为空', '这个月的数据怎么没了', 'skill-manager', '22:41']].map(([c, t, d, p, time]) => (
              <div key={t} className="np-row np-row--rec">
                <span className="np-ic np-ic--s20" style={{ '--c': `var(--ic-${c})` }}><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" /></svg></span>
                <div className="lf"><div className="lb">{t}</div><div className="ds">{d.includes('数据') ? <>这个月的<mark className="np-hit">数据</mark>怎么没了</> : d}</div></div>
                <span className="np-rec-end"><span>{p}</span><span className="num">{time}</span><svg className="chev" viewBox="0 0 10 10"><path d="M4 2.5 6.5 5 4 7.5" /></svg></span>
              </div>
            ))}
          </div>
          <div className="cp-native__detail">
            <div className="np-detail-hd">
              <Button variant="ghost" className="np-btn-text">‹ 上一页</Button>
              <div className="ttl"><span className="np-ic np-ic--s20" style={{ '--c': 'var(--ic-blue)' }}><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" /></svg></span><span>钻入式详情 np-detail-hd</span></div>
              <div className="meta"><span>skills · master · 今天 14:36</span><span className="acts"><Button size="sm" variant="primary" className="np-btn">主动作</Button><Button size="sm" className="np-btn">次动作</Button></span></div>
            </div>
            <div className="np-detail-body">
              <div className="np-msg-when">今天 14:30</div>
              <div className="np-ask">提问气泡 np-ask</div>
              <div className="np-sender"><span className="np-ic np-ic--s16" style={{ '--c': 'var(--tool-claude)' }}><svg viewBox="0 0 16 16"><path d="M3 4.5 6.5 8 3 11.5M8 12h5" /></svg></span>Claude</div>
              <div className="np-read"><p>长文 np-read：正文 13 / 20，<code>行内代码</code>。</p><pre><code>代码块不做语法高亮</code></pre></div>
            </div>
          </div>
          <div className="np-menu cp-native__menu">
            <button type="button" className="np-mitem"><span className="tx"><b>下拉菜单 np-menu</b></span><span className="ck">✓</span></button>
            <div className="np-msep" />
            <button type="button" className="np-mitem"><span className="tx"><b>skills</b><span>~/Documents · 16 个对话</span></span><span className="ck" /></button>
          </div>
        </div>
      </Section>

      {/* ── Tokens ─────────────────────────────────────── */}
      <Section title="Design Tokens">
        <Row label="颜色">
          <div className="cp-token-grid">
            {COLOR_TOKEN_PREVIEW.map((color) => (
              <div className="cp-color-token" key={color.token}>
                <span className="cp-color-token__swatch" style={{ background: `var(${color.token})` }} />
                <span className="cp-color-token__name">{color.name}</span>
                <code>{color.token}</code>
                <span className="cp-color-token__value">{color.value}</span>
              </div>
            ))}
          </div>
        </Row>
        <Row label="字号">
          <div className="cp-token-inline">
            {TEXT_TOKEN_PREVIEW.map((token) => (
              <span className="cp-text-token" style={{ fontSize: `var(${token})` }} key={token}>
                {token}
              </span>
            ))}
          </div>
        </Row>
        <Row label="圆角">
          <div className="cp-token-inline">
            {RADIUS_TOKEN_PREVIEW.map((token) => (
              <span className="cp-radius-token" style={{ borderRadius: `var(${token})` }} key={token}>
                {token}
              </span>
            ))}
          </div>
        </Row>
      </Section>

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
          <Button variant="secondary" size="sm" onClick={() => toast.success('操作成功')}>success</Button>
          <Button variant="secondary" size="sm" onClick={() => toast.error('发生错误，请重试')}>error</Button>
          <Button variant="secondary" size="sm" onClick={() => toast.warning('注意：配置已变更')}>warning</Button>
          <Button variant="secondary" size="sm" onClick={() => toast.info('这是一条普通提示')}>info</Button>
        </Row>
        <p className="cp-desc">全局入口 toast.success / error / warning / info；同时只显示一条，新的顶掉旧的。</p>
      </Section>

      {/* ── SegmentedControl ───────────────────────────── */}
      <Section title="SegmentedControl">
        <Row label="默认">
          <SegmentedControl
            ariaLabel="工具"
            value={segment}
            onChange={setSegment}
            options={[{ value: 'all', label: '全部' }, { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]}
          />
        </Row>
      </Section>

      {/* ── confirmDialog ──────────────────────────────── */}
      <Section title="confirmDialog">
        <Row label="触发">
          <Button
            variant="danger"
            size="sm"
            onClick={async () => {
              const ok = await confirmDialog({ title: '只从 CodePal 中央仓库删除 code-review？', description: '工具侧副本会保留。', confirmText: '删除', danger: true })
              toast.info(ok ? '点了删除' : '点了取消')
            }}
          >
            删除确认
          </Button>
        </Row>
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
            onRetry={() => toast.info('已触发重试')}
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
            <Button variant="primary" onClick={() => { setModalSize(null); toast.success('点击了确认') }}>确认</Button>
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

      <Section title="用量月历（本页样式）">
        <div className="uc-page np-scope" style={{margin:0,width:'100%',minHeight:0,padding:16}}>
          <div className="uc-body">
            <Row label="目标三档"><DayRing total={150e6} target={300e6}/><DayRing total={300e6} target={300e6}/><DayRing total={600e6} target={300e6}/></Row>
            <UsageCalendar month="2026-09" today="2026-09-16" data={{earliestDate:'2026-09-01',total:150e6,days:{'2026-09-16':{status:'ready',total:150e6,models:{a:{total:150e6}}}}}} selected="2026-09-16" target={300e6} goal={{value:300,unit:'M'}} progress={{processedDays:1,totalDays:1}} onSelect={()=>{}} onMonthChange={()=>{}} onRetry={()=>{}} onSaveGoal={async()=>{}}/>
          </div>
        </div>
      </Section>

    </PageShell>
  )
}
