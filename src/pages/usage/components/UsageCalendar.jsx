/** Natural-month calendar with daily progress and errors. @module pages/usage/components/UsageCalendar */
import {useState} from 'react'
import Button from '../../../components/Button/Button'
import DayRing from './DayRing'
import GoalPopover from './GoalPopover'
import {formatToken,getGoalStatus,getMonthCells,getMonthDays,shiftMonth} from '../calendarUtils'
/** @param {object} props @returns {JSX.Element} */
export default function UsageCalendar({month,today,data,selected,onSelect,onMonthChange,target,goal,onSaveGoal,loading,error,progress,onRetry}) {
  const [showGoal,setShowGoal]=useState(false),cells=getMonthCells(month),earliest=data?.earliestDate,days=data?.days||{}
  const empty=!loading&&!error&&!Object.values(days).some(d=>d.status==='ready'&&d.total>0)&&!data?.failedDays
  const monthTarget=target*getMonthDays(month),failed=data?.failedDays||0
  return <>
    <div className="uc-month-heading">
      <div className="uc-month-nav">
      <Button variant="ghost" size="sm" className="uc-nav" aria-label="上个月" disabled={!earliest||month<=earliest.slice(0,7)} onClick={()=>onMonthChange(shiftMonth(month,-1))}>‹</Button>
      <h2>{Number(month.slice(0,4))} 年 {Number(month.slice(5))} 月</h2>
      <Button variant="ghost" size="sm" className="uc-nav" aria-label="下个月" disabled={month>=today.slice(0,7)} onClick={()=>onMonthChange(shiftMonth(month,1))}>›</Button>
      </div>
      <div className="uc-month-summary">
        {loading?<span className="uc-busy">正在统计 · {progress.processedDays} / {progress.totalDays} 天</span>:empty?<span>本月没有记录</span>:<>
          {failed||data?.legacyCacheDays?'已统计':'已用'} <b>{formatToken(data?.total||0)}</b>，目标{' '}
          <span className="uc-goal-anchor"><Button variant="ghost" size="sm" className="uc-goal-button" aria-label="编辑日目标" aria-expanded={showGoal} onClick={()=>setShowGoal(v=>!v)}>{target?formatToken(monthTarget):'未设置 · 设置'}</Button>
          {showGoal&&<GoalPopover goal={goal} month={month} onClose={()=>setShowGoal(false)} onSave={onSaveGoal}/>}</span>
          {target>0&&<>，完成 <b>{Math.round((data?.total||0)/monthTarget*100)}%</b></>}
        </>}
        {!loading&&earliest?.slice(0,7)===month&&earliest.slice(8)!=='01'&&<small> · 仅统计 {Number(earliest.slice(5,7))} 月 {Number(earliest.slice(8))} 日起</small>}
        {!loading&&failed>0&&<small className="uc-failure-note"> · {failed} 天统计失败，合计缺数</small>}
        {!loading&&data?.legacyCacheDays>0&&<small> · 含历史缓存，来源完整性未验证</small>}
      </div>
    </div>
    {error&&<div className="uc-error" role="alert">{error}<Button size="sm" onClick={()=>onRetry()}>重试</Button></div>}
    <section className={`uc-card np-card uc-calendar ${cells.length===42?'uc-six':''}`} aria-label="用量月历">
      <div className="uc-weekdays">{['一','二','三','四','五','六','日'].map(d=><span key={d}>{d}</span>)}</div>
      <div className="uc-days">{cells.map((key,i)=>{
        if(!key)return <span className="uc-day uc-day-spacer" key={`blank-${i}`}/>
        const day=days[key],disabled=key>today||(earliest&&key<earliest)||empty,zero=day?.status==='ready'&&day.total===0,failedDay=day?.status==='failed',skeleton=!disabled&&(!day||day.status==='loading')&&(loading||Boolean(error)),status=getGoalStatus(day?.total||0,target)
        return <button key={key} type="button" aria-label={key} aria-pressed={selected===key} title={failedDay?'统计失败，点击重试':undefined} disabled={Boolean(disabled)} className={`uc-day ${disabled?'uc-day-disabled':''} ${key===today?'uc-today':''} ${selected===key?'uc-selected':''} ${skeleton?'uc-skeleton':''} ${zero?'uc-zero':''}`} onClick={()=>failedDay?onRetry(key):onSelect(key)}>
          <span className="uc-day-number">{key===today?'今天':key.slice(8)}</span>
          {!disabled&&failedDay?<><span className="uc-day-ring-placeholder">—</span><span className="uc-day-value">统计失败</span></>:!disabled&&skeleton?<><span className="uc-day-ring-placeholder"/><span className="uc-day-value">&nbsp;</span></>:!disabled&&day?.status==='ready'?<>
            {target>0&&!zero&&<DayRing total={day.total} target={target}/>}
            <span className="uc-day-value">{formatToken(day.total)}</span>
            {target>0&&!zero&&<span className={`uc-day-percent uc-${status.tier}`}>{status.percent}%</span>}
          </>:null}
        </button>
      })}</div>
      {!empty&&target>0&&<div className="uc-legend" data-testid="calendar-legend"><span><i className="uc-under"/>未达成</span><span><i className="uc-done"/>达成</span><span><i className="uc-over"/>优秀</span></div>}
    </section>
  </>
}
