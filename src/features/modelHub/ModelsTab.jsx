/**
 * 模型汇总 ·「模型」页签：审核在用（按你排的顺序，可拖动 / 键盘排序）+ 其余模型（按来源折叠）
 *
 * 数据与保存来自 useModelHub；折叠哪一家由页面传入（只在这次打开页面时记住）。
 *
 * @module features/modelHub/ModelsTab
 */
import { Fragment, useRef } from 'react'
import Button from '../../components/Button/Button'
import Toggle from '../../components/Toggle'
import StateView from '../../components/StateView/StateView'
import EffortMenu from '../../components/EffortMenu'
import { toast } from '../../components/Toast'
import useRowDrag from './useRowDrag'
import { singleFamilyWarning } from './reviewCapacity'

const CHEVRON = (
  <svg className="chev" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M3 4 5 2 7 4M3 6 5 8 7 6" />
  </svg>
)
const BLOCKED = {
  claude: { notInstalled: '没装 Claude Code', notLoggedIn: 'Claude Code 没登录' },
  codex: {
    notInstalled: '没装 Codex',
    notLoggedIn: 'Codex 没登录',
    noModelList: '读不到 Codex 的模型清单，打开一次 Codex 后再来',
  },
}
const GRIP = (
  <svg viewBox="0 0 10 14" aria-hidden="true">
    {[2, 7, 12].flatMap((y) => [3, 7].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" />))}
  </svg>
)

/** 保存失败的提示：回滚也失败时原因本身就是一整句 */
export function failureText(result) {
  if (result.error?.code === 'ROLLBACK_FAILED') return result.error.message
  return `保存失败：${result.error?.message || '出错了'}`
}

function VendorIcon({ color }) {
  return (
    <span className="np-ic np-ic--s16" style={{ '--c': color }} aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <path d="M8 2 13.5 5v6L8 14 2.5 11V5zM2.5 5 8 8l5.5-3M8 8v6" />
      </svg>
    </span>
  )
}

function ModelRow({ vendor, model, nested = false, hub, menu, setMenu, locked = false, index, grip, rowRef, lifted }) {
  const anchor = useRef(null)
  const togglePending = hub.pending[`enabled:${model.id}`]
  const effortPending = hub.pending[`effort:${model.id}`]
  const toggle = async (enabled) => {
    const result = await hub.setEnabled({ id: model.id, enabled })
    if (!result) return
    if (result.success) toast.success(`${model.displayName} ${enabled ? '已用于审核' : '不再用于审核'}`)
    else toast.error(failureText(result))
  }
  const pick = async (effort) => {
    setMenu(null)
    if (effort === model.effort) return
    const result = await hub.setEffort({ id: model.id, effort })
    if (!result) return
    if (result.success) toast.success('已保存')
    else toast.error(failureText(result))
  }
  const effort = effortPending ? effortPending.effort : model.effort
  return (
    <div
      ref={rowRef}
      className={`np-row${nested ? ' mh-sub' : ''}${lifted ? ' is-lifted' : ''}`}
      data-hub-model={model.id}
    >
      <span className="mh-lf">
        {index !== undefined && (grip || <span className="mh-grip-space" aria-hidden="true" />)}
        {index !== undefined && <span className="mh-idx">{index + 1}</span>}
        {!nested && <VendorIcon color={vendor.color} />}
        <span className="mh-nm">
          <span className="lb mh-name" title={model.displayName}>
            {model.displayName}
          </span>
          {model.effortUnsupported && <span className="mh-note">原来的 {model.effortUnsupported} 不再支持</span>}
        </span>
        {!nested && <span className="mh-vd">{vendor.name}</span>}
      </span>
      <span className="np-card-acts mh-acts">
        {model.efforts?.length > 0 && (
          <span className="mh-effort-anchor">
            <button
              ref={anchor}
              type="button"
              className="np-popbtn mh-eff"
              aria-label={`${model.displayName} 思考强度`}
              aria-haspopup="menu"
              aria-expanded={menu === model.id}
              disabled={Boolean(effortPending) || locked}
              onClick={() => setMenu(menu === model.id ? null : model.id)}
            >
              {effort}
              {CHEVRON}
            </button>
            {menu === model.id && (
              <EffortMenu
                value={model.effort}
                efforts={model.efforts}
                anchorRef={anchor}
                onPick={pick}
                onClose={() => setMenu(null)}
                className="mh-menu"
              />
            )}
          </span>
        )}
        <Toggle
          checked={togglePending ? togglePending.enabled : model.enabled}
          disabled={Boolean(togglePending) || locked}
          aria-label={`${model.displayName} 用于审核`}
          onChange={toggle}
        />
      </span>
    </div>
  )
}

function SkeletonRow({ width, controls = false }) {
  return (
    <div className="np-row mh-skeleton-row">
      <span className="mh-lf">
        <span className="np-sk" style={{ width: 16, height: 16 }} />
        <span className="np-sk" style={{ width }} />
      </span>
      {controls ? (
        <span className="np-card-acts mh-acts">
          <span className="np-sk" style={{ width: 88, height: 24 }} />
          <span className="np-sk" style={{ width: 36, height: 20 }} />
        </span>
      ) : (
        <span className="np-sk" style={{ width: 28 }} />
      )}
    </div>
  )
}

/**
 * @param {object} props
 * @param {object} props.hub useModelHub 的返回
 * @param {boolean} props.selfReview 自审开着时不提示「只开了一家」
 * @param {string|null} props.open 展开的那一家 / props.setOpen
 * @param {string|null} props.menu 打开等级菜单的模型 / props.setMenu
 * @param {(page: string) => void} [props.onNavigate]
 */
export default function ModelsTab({ hub, selfReview, open, setOpen, menu, setMenu, onNavigate }) {
  const vendors = hub.data?.vendors || []
  const byId = new Map()
  for (const vendor of vendors) {
    if (vendor.blocked) continue
    for (const model of vendor.models) if (model.enabled) byId.set(model.id, { vendor, model })
  }
  const order = (hub.data?.order || []).filter((id) => byId.has(id))
  for (const id of byId.keys()) if (!order.includes(id)) order.push(id)
  const enabled = order.map((id) => byId.get(id))
  const remaining = vendors
    .map((vendor) => ({ vendor, models: vendor.blocked ? [] : vendor.models.filter((model) => !model.enabled) }))
    .filter(({ vendor, models }) => vendor.blocked || models.length)
  const savingOrder = Boolean(hub.pending.order)
  const commitOrder = async (next) => {
    const result = await hub.setOrder(next)
    if (!result) return
    if (result.success) toast.success('已保存')
    else toast.error(failureText(result))
  }
  const drag = useRowDrag(order, { onCommit: commitOrder, disabled: savingOrder })
  const warning = hub.loading
    ? null
    : singleFamilyWarning(
        enabled.map(({ vendor }) => ({ vendor: vendor.id })),
        selfReview
      )

  // 放下位置是「除被拖的那行以外」的第几个空隙：蓝线画在那一行之前，超过最后一行就画在卡片末尾
  const others = drag.dragging ? enabled.map(({ model }) => model.id).filter((id) => id !== drag.dragging) : []
  const dropBefore = drag.dragging ? others[drag.dropIndex] : null
  const dropAtEnd = Boolean(drag.dragging) && drag.dropIndex >= others.length

  return (
    <StateView error={hub.error} onRetry={() => hub.reload({ reset: true })}>
      <div className="np-glabel">
        审核在用{!hub.loading && enabled.length > 0 && <span className="cnt">{enabled.length} 个</span>}
      </div>
      {hub.loading || enabled.length ? (
        <div
          className={`np-card np-card--form${savingOrder ? ' is-saving' : ''}`}
          data-hub-section="enabled"
          aria-busy={savingOrder || undefined}
        >
          {hub.loading
            ? [140, 110, 120].map((width) => <SkeletonRow key={width} width={width} controls />)
            : enabled.map(({ vendor, model }, index) => (
                <Fragment key={model.id}>
                  {dropBefore === model.id && <div className="mh-drop" aria-hidden="true" />}
                  <ModelRow
                    {...{ vendor, model, hub, menu, setMenu, index }}
                    locked={savingOrder}
                    lifted={drag.dragging === model.id}
                    rowRef={drag.rowRef(model.id)}
                    grip={
                      enabled.length > 1 ? (
                        <button
                          type="button"
                          className="mh-grip"
                          aria-label={`调整 ${model.displayName} 的顺序`}
                          {...drag.gripProps(model.id)}
                        >
                          {GRIP}
                        </button>
                      ) : null
                    }
                  />
                </Fragment>
              ))}
          {dropAtEnd && <div className="mh-drop" aria-hidden="true" />}
        </div>
      ) : (
        <div className="np-card" data-hub-section="enabled">
          <div className="np-empty">还没有打开的模型，审核会因为没有模型可用而停下</div>
        </div>
      )}
      {warning && <div className="mh-foot warn">{warning}</div>}
      <div className="np-glabel">其余模型</div>
      {(hub.loading || remaining.length > 0) && (
        <div className="np-card np-card--form" data-hub-section="remaining">
          {hub.loading
            ? [90, 70, 80, 90, 70].map((width, index) => <SkeletonRow key={index} width={width} />)
            : remaining.map(({ vendor, models }) => {
                if (vendor.blocked)
                  return (
                    <div className="np-row" key={vendor.id}>
                      <span className="mh-lf">
                        <span className="mh-disc-space" />
                        <VendorIcon color={vendor.color} />
                        <span className="lb">{vendor.name}</span>
                      </span>
                      <span className="np-st warn">
                        <i />
                        {BLOCKED[vendor.id]?.[vendor.blocked]}
                      </span>
                    </div>
                  )
                const expanded = open === vendor.id
                const toggleFold = () => setOpen(expanded ? null : vendor.id)
                return (
                  <Fragment key={vendor.id}>
                    <div
                      className="np-row mh-fold"
                      role="button"
                      tabIndex={0}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? '收起' : '展开'} ${vendor.name}`}
                      onClick={toggleFold}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          toggleFold()
                        }
                      }}
                    >
                      <span className="mh-lf">
                        <svg className="np-disc" viewBox="0 0 10 10" aria-hidden="true">
                          <path d={expanded ? 'M2.5 4 5 6.5 7.5 4' : 'M4 2.5 6.5 5 4 7.5'} />
                        </svg>
                        <VendorIcon color={vendor.color} />
                        <span className="lb">{vendor.name}</span>
                      </span>
                      <span className="mh-cnt">{models.length} 个</span>
                    </div>
                    {expanded &&
                      models.map((model) => (
                        <ModelRow key={model.id} nested {...{ vendor, model, hub, menu, setMenu }} />
                      ))}
                  </Fragment>
                )
              })}
        </div>
      )}
      {/* 首次加载只画骨架（定稿 W5），说明行等数据到了再出 */}
      {!hub.loading && (
        <div className={`mh-foot${hub.data?.providerConfigError ? ' bad' : ''}`}>
          {hub.data?.providerConfigError
            ? '模型接入的配置读不出，去模型接入处理'
            : '「模型接入」里的模型要先测通，才会出现在这里'}
          <Button variant="ghost" className="np-btn-text" onClick={() => onNavigate?.('models')}>
            去模型接入
          </Button>
        </div>
      )}
    </StateView>
  )
}
