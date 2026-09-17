/** Exact-ratio daily achievement ring, with a second lap for excellence. @module pages/usage/components/DayRing */
import {getGoalStatus} from '../calendarUtils'
/** @param {object} props @returns {JSX.Element|null} */
export default function DayRing({total,target,size=36,showPercent=false}) {
  if(!target||!total)return null
  const {ratio,tier,percent}=getGoalStatus(total,target),radius=size===64?27:14,circumference=2*Math.PI*radius
  const color=tier==='over'?'var(--uc-purple)':tier==='done'?'var(--uc-green)':'var(--uc-blue)'
  return <span className="uc-ring" data-testid="day-ring" style={{width:size,height:size}}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} data-tier={tier} aria-label={`${percent}%`}>
      <circle cx={size/2} cy={size/2} r={radius} stroke="var(--uc-track)"/>
      <circle data-progress cx={size/2} cy={size/2} r={radius} stroke={color} strokeDasharray={circumference} strokeDashoffset={circumference*(1-Math.min(ratio,1))}/>
      {tier==='over'&&<circle data-second-circle cx={size/2} cy={size/2} r={radius} stroke="var(--uc-purple-deep)" strokeDasharray={circumference} strokeDashoffset={circumference*(1-Math.min(ratio-1,1))}/>}
    </svg>
    {showPercent&&<span className={`uc-ring-percent uc-${tier}`}>{percent}%</span>}
  </span>
}
