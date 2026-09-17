/** Selected-day model shares, capped at six models plus a conserved remainder. @module pages/usage/components/DayDetail */
import DayRing from './DayRing'
import {formatToken,getGoalStatus,getModelRows} from '../calendarUtils'
/** @param {object} props @returns {JSX.Element|null} */
export default function DayDetail({date,day,today,target}) {
  if(!day||day.status!=='ready')return null
  const status=getGoalStatus(day.total,target),rows=getModelRows(day.models)
  return <section className="uc-card uc-detail" data-testid="day-detail" aria-label="选中日模型构成">
    {target>0&&day.total>0&&<DayRing total={day.total} target={target} size={64} showPercent/>}
    <div className="uc-detail-content">
      <div className="uc-detail-heading"><b>{date.slice(5)}{date===today?' · 今天':''}</b><strong>{formatToken(day.total)}</strong>{target>0&&day.total>0&&<><span>目标 {formatToken(target)}</span><span className={`uc-status uc-${status.tier}`}>{status.label}</span></>}</div>
      {rows.map((row,i)=><div className={`uc-model-row ${row.other?'uc-other':''}`} key={row.name}>
        <span className="uc-model-name" title={row.name}>{row.name}</span>
        <span className="uc-model-bar"><i style={{width:`${day.total?row.total/day.total*100:0}%`,opacity:[1,.72,.5,.34,.26,.2,.15][i]}}/></span>
        <b>{formatToken(row.total)}</b><span>{Math.round(row.total/day.total*100)}%</span>
      </div>)}
    </div>
  </section>
}
