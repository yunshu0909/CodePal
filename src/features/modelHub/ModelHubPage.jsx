/** The signed model hub: current review models, remaining sources, and per-model controls. */
import { Fragment, useRef, useState } from 'react'
import PageShell from '../../components/PageShell'
import Button from '../../components/Button/Button'
import Toggle from '../../components/Toggle'
import StateView from '../../components/StateView/StateView'
import EffortMenu from '../../components/EffortMenu'
import { toast } from '../../components/Toast'
import useModelHub from './useModelHub'
import './modelHub.css'

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

function VendorIcon({ color }) {
  return (
    <span className="np-ic np-ic--s16" style={{ '--c': color }} aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <path d="M8 2 13.5 5v6L8 14 2.5 11V5zM2.5 5 8 8l5.5-3M8 8v6" />
      </svg>
    </span>
  )
}

function ModelRow({ vendor, model, nested = false, hub, menu, setMenu }) {
  const anchor = useRef(null)
  const togglePending = hub.pending[`enabled:${model.id}`]
  const effortPending = hub.pending[`effort:${model.id}`]
  const toggle = async (enabled) => {
    const result = await hub.setEnabled({ id: model.id, enabled })
    if (!result) return
    if (result.success) toast.success(`${model.displayName} ${enabled ? '已用于审核' : '不再用于审核'}`)
    else toast.error(`保存失败：${result.error?.message || '出错了'}`)
  }
  const pick = async (effort) => {
    setMenu(null)
    if (effort === model.effort) return
    const result = await hub.setEffort({ id: model.id, effort })
    if (!result) return
    if (result.success) toast.success('已保存')
    else toast.error(`保存失败：${result.error?.message || '出错了'}`)
  }
  return (
    <div className={`np-row${nested ? ' mh-sub' : ''}`} data-hub-model={model.id}>
      <span className="mh-lf">
        {!nested && <VendorIcon color={vendor.color} />}
        <span className="lb mh-name" title={model.displayName}>
          {model.displayName}
        </span>
        {!nested && <span className="mh-vd">{vendor.name}</span>}
      </span>
      <span className="np-card-acts mh-acts">
        <span className="mh-effort-anchor">
          <button
            ref={anchor}
            type="button"
            className="np-popbtn mh-eff"
            aria-label={`${model.displayName} 思考强度`}
            aria-haspopup="menu"
            aria-expanded={menu === model.id}
            disabled={Boolean(effortPending)}
            onClick={() => setMenu(menu === model.id ? null : model.id)}
          >
            {model.effort}
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
        <Toggle
          checked={togglePending ? togglePending.enabled : model.enabled}
          disabled={Boolean(togglePending)}
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

export default function ModelHubPage({ onNavigate }) {
  const hub = useModelHub()
  const [open, setOpen] = useState(null)
  const [menu, setMenu] = useState(null)
  const vendors = hub.data?.vendors || []
  const enabled = vendors
    .filter((vendor) => !vendor.blocked)
    .flatMap((vendor) => vendor.models.filter((model) => model.enabled).map((model) => ({ vendor, model })))
  const remaining = vendors
    .map((vendor) => ({ vendor, models: vendor.blocked ? [] : vendor.models.filter((model) => !model.enabled) }))
    .filter(({ vendor, models }) => vendor.blocked || models.length)
  const families = [...new Set(enabled.map(({ vendor }) => vendor.id))]
  const singleSubscription = families.length === 1 && ['claude', 'codex'].includes(families[0]) ? families[0] : null
  const error = hub.error
  return (
    <PageShell native title="模型汇总" className="mh-page">
      <div className="np-scroll">
        <StateView error={error} onRetry={() => hub.reload({ reset: true })}>
          <div className="np-glabel">
            审核在用{!hub.loading && enabled.length > 0 && <span className="cnt">{enabled.length} 个</span>}
          </div>
          {hub.loading || enabled.length ? (
            <div className="np-card np-card--form" data-hub-section="enabled">
              {hub.loading
                ? [140, 110, 120].map((width) => <SkeletonRow key={width} width={width} controls />)
                : enabled.map(({ vendor, model }) => (
                    <ModelRow key={model.id} {...{ vendor, model, hub, menu, setMenu }} />
                  ))}
            </div>
          ) : (
            <div className="np-card" data-hub-section="enabled">
              <div className="np-empty">还没有打开的模型，审核会因为没有模型可用而停下</div>
            </div>
          )}
          {!hub.loading && singleSubscription && (
            <div className="mh-foot warn">
              {singleSubscription === 'claude'
                ? '只开了 Claude：用 Claude Code 写代码时，没有别家模型来审'
                : '只开了 Codex：用 Codex 写代码时，没有别家模型来审'}
            </div>
          )}
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
          <div className={`mh-foot${hub.data?.providerConfigError ? ' bad' : ''}`}>
            {hub.data?.providerConfigError
              ? '模型接入的配置读不出，去模型接入处理'
              : '「模型接入」里的模型要先测通，才会出现在这里'}
            <Button variant="ghost" className="np-btn-text" onClick={() => onNavigate?.('models')}>
              去模型接入
            </Button>
          </div>
        </StateView>
      </div>
    </PageShell>
  )
}
