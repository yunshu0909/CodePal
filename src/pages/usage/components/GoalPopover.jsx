/** Anchored daily-goal editor with single-submit persistence. @module pages/usage/components/GoalPopover */
import {useEffect,useRef,useState} from 'react'
import {getMonthDays,parseGoalInput,formatToken} from '../calendarUtils'
/** @param {object} props @returns {JSX.Element} */
export default function GoalPopover({goal,month,onSave,onClose}) {
  const [text,setText]=useState(()=>goal?`${goal.unit==='K'?goal.value/1000:goal.value}${goal.unit==='K'?'M':goal.unit}`:''),[error,setError]=useState(''),[saving,setSaving]=useState(false)
  const busy=useRef(false),closed=useRef(false),element=useRef(null)
  const commit=async()=>{
    if(busy.current||closed.current)return
    const next=parseGoalInput(text)
    if(!next){setError('请输入大于0的M或B数值');return}
    if(goal?.value===next.value&&goal?.unit===next.unit){closed.current=true;onClose();return}
    busy.current=true;setSaving(true)
    try{await onSave(next.value,next.unit);closed.current=true;onClose()}
    catch{setError('保存失败，请重试')}
    finally{busy.current=false;setSaving(false)}
  }
  useEffect(()=>{
    const escape=event=>{if(event.key==='Escape'&&!busy.current){closed.current=true;onClose()}}
    document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape)
  },[onClose])
  const parsed=parseGoalInput(text),tokens=parsed?parsed.value*(parsed.unit==='B'?1e9:1e6):0
  return <div className="uc-popover" ref={element} role="dialog" aria-label="用量目标">
    <b>用量目标</b><label>每天<input autoFocus aria-label="每日目标" aria-invalid={Boolean(error)} disabled={saving} value={text} placeholder="300M" onChange={e=>{setText(e.target.value);setError('')}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commit()}}} onBlur={commit}/></label>
    {error&&<span role="alert">{error}</span>}
    <small>每月目标 = 每天 × 当月天数（{getMonthDays(month)}天{tokens?` = ${formatToken(tokens*getMonthDays(month))}`:''}）· 回车保存</small>
  </div>
}
