/** Usage calendar and selected-day composition, scoped to this page. @module pages/UsageMonitorPage */
import PageShell from '../components/PageShell'
import { toast } from '../components/Toast'
import useUsageCalendarData from './usage/useUsageCalendarData'
import useUsageGoal from './usage/useUsageGoal'
import UsageCalendar from './usage/components/UsageCalendar'
import DayDetail from './usage/components/DayDetail'
import {formatToken,getMonthDays,getMonthCells} from './usage/calendarUtils'
import './usage/calendar.css'
/** @param {{isActive?:boolean}} props @returns {JSX.Element} */
export default function UsageMonitorPage({isActive=true}) {
  const calendar=useUsageCalendarData(isActive),goal=useUsageGoal(getMonthDays(calendar.month))
  const saveGoal=async(value,unit)=>{await goal.saveGoal(value,unit);toast.success(`目标已更新为 ${formatToken(value*(unit==='B'?1e9:1e6))} / 天`)}
  const hasRecords=Object.values(calendar.data?.days||{}).some(d=>d.status==='ready'&&d.total>0)
  return <PageShell title="用量监测" native className="uc-page">
    <div className={`uc-body np-scroll ${getMonthCells(calendar.month).length===42?'uc-six-detail':''}`}>
      <UsageCalendar {...calendar} target={goal.dailyTarget} goal={goal.goal} onSaveGoal={saveGoal} onSelect={calendar.setSelected} onMonthChange={calendar.setMonth} onRetry={calendar.retry}/>
      {hasRecords&&calendar.selected&&<DayDetail date={calendar.selected} day={calendar.data?.days[calendar.selected]} today={calendar.today} target={goal.dailyTarget}/>}
    </div>
  </PageShell>
}
