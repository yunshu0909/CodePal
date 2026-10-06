/**
 * 模型汇总 ·「审核规则」页签：dev 插件两端与默认值、派审核（自审）、两组关卡的个数与轮数、其他 · 高级
 *
 * 所有设置点了就保存（保存中禁用这个控件、失败退回并红色提示）；恢复默认先确认；
 * 审核配置写不进去时顶卡下红字可重试，按 dev 实际在用的写两种说法（没了或坏了 → 默认规则；还有上一份 → 上一次存下的规则）。数据来自 useReviewRules，能来审的模型数按模型页签的数据算。
 *
 * @module features/modelHub/RulesTab
 */
import { Fragment, useRef } from 'react'
import Button from '../../components/Button/Button'
import Toggle from '../../components/Toggle'
import StateView from '../../components/StateView/StateView'
import { toast } from '../../components/Toast'
import { confirmDialog } from '../../components/Modal/confirmDialog'
import usePopoverDismiss from '../../hooks/usePopoverDismiss'
import { capacityWarning } from './reviewCapacity'
import { failureText } from './ModelsTab'

const CHEVRON = (
  <svg className="chev" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M3 4 5 2 7 4M3 6 5 8 7 6" />
  </svg>
)
const GROUPS = [
  {
    label: '简单需求 · 快速开发',
    gates: [
      ['lite.G0', '开工前检查', '计划和测试清单'],
      ['lite.G1', '代码审核', '代码改动和测试结果'],
    ],
  },
  {
    label: '复杂需求 · 完整开发',
    gates: [
      ['formal.G1', '需求对齐', '计划有没有理解歪你的原话'],
      ['formal.G2b', '答后再对齐', '选择题的回答有没有写对'],
      ['formal.G3', '开工前检查', '文档、测试用例和漏问的选择'],
      ['formal.G4', '代码审核', '代码改动、测试结果和截图'],
    ],
  },
]
const ADVANCED = [
  ['timeoutMinutes', '一次审核最长', [5, 10, 15, 20, 30, 45, 60], (n) => `${n} 分钟`],
  ['failoverMax', '一个模型挂了最多换', [0, 1, 2, 3, 4, 5], (n) => `${n} 次`],
  ['autoExtendRounds', '轮次用完自动加', [0, 1, 2, 3], (n) => `${n} 轮`],
]
const DEV_TEXT = { ok: '已生效', none: '没装', old: '版本太旧', unknown: '版本未知' }
const reviewersLabel = (n) => `${n} 个模型`
const roundsLabel = (n) => `每个 ${n} 轮`

/**
 * 选项菜单：同 EffortMenu 的样式与键盘（Esc 收起、↑↓ 移动），菜单名按用途给
 * （EffortMenu 的无障碍名写死为「思考强度」，本任务不改共用组件，后续给它加 ariaLabel 后合并）
 */
function OptionMenu({ label, options, value, anchorRef, onPick, onClose }) {
  const root = useRef(null)
  usePopoverDismiss(root, onClose, anchorRef)
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      onClose()
      anchorRef.current?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    const items = [...root.current.querySelectorAll('[role="menuitemradio"]')]
    const current = items.indexOf(document.activeElement)
    items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
  return (
    <div ref={root} className="np-menu mh-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {options.map(({ value: optionValue, text }) => (
        <button
          key={String(optionValue)}
          type="button"
          role="menuitemradio"
          aria-label={text}
          aria-checked={optionValue === value}
          className="np-mitem"
          onClick={() => onPick(optionValue)}
        >
          <span className="tx">
            <b>{text}</b>
          </span>
          <span className="ck" aria-hidden="true">
            {optionValue === value ? '✓' : ''}
          </span>
        </button>
      ))}
    </div>
  )
}

/** 一个弹出按钮 + 它的选项菜单；选当前值不保存 */
function Choice({ ruleKey, label, value, values, format, className, rules, menu, setMenu }) {
  const anchor = useRef(null)
  const open = menu === ruleKey
  const pick = async (next) => {
    setMenu(null)
    if (next === value) return
    const result = await rules.set(ruleKey, next)
    if (!result) return
    if (result.success) toast.success('已保存')
    else toast.error(failureText(result))
  }
  return (
    <span className="mh-effort-anchor">
      <button
        ref={anchor}
        type="button"
        className={`np-popbtn mh-pick ${className}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={Boolean(rules.pending[ruleKey]) || Boolean(rules.pending.reset)}
        onClick={() => setMenu(open ? null : ruleKey)}
      >
        {format(value)}
        {CHEVRON}
      </button>
      {open && (
        <OptionMenu
          label={label}
          value={value}
          options={values.map((n) => ({ value: n, text: format(n) }))}
          anchorRef={anchor}
          onPick={pick}
          onClose={() => setMenu(null)}
        />
      )}
    </span>
  )
}

/** 首次加载（定稿 W6）：顶卡两行、派审核一行开关、两组关卡行；说明小字与「其他」等数据到了再出 */
function RulesSkeleton() {
  const bar = (width, height) => <span className="np-sk" style={height ? { width, height } : { width }} />
  const gateRows = (count) =>
    Array.from({ length: count }, (_, index) => (
      <div className="np-row mh-skeleton-row" key={index}>
        {bar(90)}
        <span className="np-card-acts mh-gate-acts">
          {bar(96, 24)}
          {bar(96, 24)}
        </span>
      </div>
    ))
  return (
    <>
      <div className="np-card np-card--form">
        <div className="np-row mh-skeleton-row">
          {bar(60)}
          {bar(180)}
        </div>
        <div className="np-row mh-skeleton-row">
          {bar(50)}
          {bar(64, 24)}
        </div>
      </div>
      <div className="np-glabel">派审核</div>
      <div className="np-card np-card--form">
        <div className="np-row mh-skeleton-row">
          {bar(160)}
          {bar(36, 20)}
        </div>
      </div>
      {GROUPS.map((group) => (
        <Fragment key={group.label}>
          <div className="np-glabel">{group.label}</div>
          <div className="np-card np-card--form">{gateRows(group.gates.length)}</div>
        </Fragment>
      ))}
    </>
  )
}

/**
 * @param {object} props
 * @param {object} props.rules useReviewRules 的返回
 * @param {object} props.hub useModelHub 的返回（算能来审的模型数）
 * @param {boolean} props.advancedOpen / props.setAdvancedOpen 高级展开（只在这次打开页面时记住）
 * @param {string|null} props.menu / props.setMenu 当前打开的菜单
 */
export default function RulesTab({ rules, hub, advancedOpen, setAdvancedOpen, menu, setMenu }) {
  const data = rules.data
  const effective = data?.effective
  const enabledModels = (hub.data?.vendors || [])
    .filter((vendor) => !vendor.blocked)
    .flatMap((vendor) =>
      vendor.models.filter((model) => model.enabled).map((model) => ({ id: model.id, vendor: vendor.id }))
    )
  const warning = effective && hub.data ? capacityWarning(enabledModels, effective.selfReview, effective.gates) : null
  const selfPending = Boolean(rules.pending.selfReview)

  const toggleSelf = async (on) => {
    const result = await rules.set('selfReview', on)
    if (!result) return
    if (result.success) toast.success('已保存')
    else toast.error(failureText(result))
  }
  const reset = () =>
    confirmDialog({
      title: '恢复默认的审核规则？',
      description: '每道关的个数和轮数、自审开关、高级三项都回到这个版本配好的建议值；模型的开关、顺序和思考等级不变。',
      confirmText: '恢复默认',
      busyText: '恢复中…',
      onConfirm: async () => {
        const result = await rules.reset()
        if (result?.success) {
          toast.success('已恢复默认')
          return true
        }
        if (result) toast.error(failureText(result))
        return false
      },
    })
  // 重试仍写不进去时红字留着、不另弹提示；另一个 CodePal 占着写入锁时红字不变，弹提示说明原因
  const retryExport = async () => {
    const result = await rules.republish()
    if (result && !result.success) toast.error(failureText(result))
  }
  const retryAll = () => {
    rules.reload({ reset: true })
    hub.reload({ reset: true })
  }

  if (rules.error) return <StateView error={rules.error} onRetry={retryAll} />
  if (!data) return <RulesSkeleton />

  return (
    <>
      <div className="np-card np-card--form" data-rules="top">
        <div className="np-row" data-rules="dev">
          <span className="lb">dev 插件</span>
          <span className="mh-dev">
            {[
              ['claude', 'Claude Code'],
              ['codex', 'Codex'],
            ].map(([end, name]) => (
              <span key={end} className={`np-st ${data.dev[end] === 'ok' ? 'ok' : 'warn'}`} data-dev-end={end}>
                <i />
                {`${name} 端${DEV_TEXT[data.dev[end]] || DEV_TEXT.unknown}`}
              </span>
            ))}
          </span>
        </div>
        <div className="np-row" data-rules="defaults">
          <span className="mh-lab">
            <span className="lb">默认值</span>
            <span className="ds">{data.changed ? '恢复成这个版本配好的建议值' : '现在用的就是这个版本的建议值'}</span>
          </span>
          {/* 恢复中由确认对话框显示「恢复中…」，背景按钮不跟着变灰（定稿 N8-3）；重复点击由 store 挡住 */}
          <Button disabled={!data.changed} onClick={reset}>
            恢复默认
          </Button>
        </div>
      </div>
      {data.exportOk === false && (
        <div className="mh-foot bad" data-rules="export-error">
          {data.exportUsing === 'previous'
            ? '审核配置写不进去，dev 还在用上一次存下的规则；检查配置目录的权限后重试'
            : '审核配置写不进去，dev 暂时用默认规则；检查配置目录的权限后重试'}
          <Button variant="ghost" className="np-btn-text" onClick={retryExport}>
            重试
          </Button>
        </div>
      )}

      <div className="np-glabel">派审核</div>
      <div className="np-card np-card--form">
        <div className="np-row">
          <span className="mh-lab">
            <span className="lb">写代码的那家也参与审核</span>
            <span className="ds">关着时只找别家的模型</span>
          </span>
          <Toggle
            checked={effective.selfReview}
            disabled={selfPending || Boolean(rules.pending.reset)}
            aria-label="写代码的那家也参与审核"
            onChange={toggleSelf}
          />
        </div>
      </div>
      <div className="mh-foot">按「模型」里的顺序从上往下找，每道关派下面设的个数</div>
      {warning && (
        <div className="mh-foot warn" data-rules="capacity">
          {warning}
        </div>
      )}

      {GROUPS.map((group) => (
        <Fragment key={group.label}>
          <div className="np-glabel">{group.label}</div>
          <div className="np-card np-card--form">
            {group.gates.map(([id, name, sub]) => (
              <div className="np-row mh-gate" key={id} data-gate={id}>
                <span className="mh-lab">
                  <span className="lb">{name}</span>
                  <span className="ds mh-gsub">{sub}</span>
                </span>
                <span className="np-card-acts mh-gate-acts">
                  <Choice
                    ruleKey={`gates.${id}.reviewers`}
                    label="派几个模型"
                    value={effective.gates[id].reviewers}
                    values={[1, 2, 3]}
                    format={reviewersLabel}
                    className="mh-gate-n"
                    {...{ rules, menu, setMenu }}
                  />
                  <Choice
                    ruleKey={`gates.${id}.rounds`}
                    label="每个审几轮"
                    value={effective.gates[id].rounds}
                    values={[1, 2, 3, 4, 5]}
                    format={roundsLabel}
                    className="mh-gate-r"
                    {...{ rules, menu, setMenu }}
                  />
                </span>
              </div>
            ))}
          </div>
        </Fragment>
      ))}

      <div className="np-glabel">其他</div>
      <div className="np-card np-card--form">
        <div
          className="np-row mh-fold"
          role="button"
          tabIndex={0}
          aria-expanded={advancedOpen}
          aria-label={advancedOpen ? '收起高级' : '展开高级'}
          onClick={() => setAdvancedOpen(!advancedOpen)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setAdvancedOpen(!advancedOpen)
            }
          }}
        >
          <span className="mh-lf">
            <svg className="np-disc" viewBox="0 0 10 10" aria-hidden="true">
              <path d={advancedOpen ? 'M2.5 4 5 6.5 7.5 4' : 'M4 2.5 6.5 5 4 7.5'} />
            </svg>
            <span className="lb">高级</span>
          </span>
          {!advancedOpen && <span className="mh-cnt">最长时间、换模型次数、自动加轮</span>}
        </div>
        {advancedOpen &&
          ADVANCED.map(([key, label, values, format]) => (
            <div className="np-row mh-sub" key={key} data-adv={key}>
              <span className="lb">{label}</span>
              <Choice
                ruleKey={`advanced.${key}`}
                label={label}
                value={effective.advanced[key]}
                values={values}
                format={format}
                className="mh-adv"
                {...{ rules, menu, setMenu }}
              />
            </div>
          ))}
      </div>
    </>
  )
}
