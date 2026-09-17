/** Month cache and request-isolated daily progress for the keep-alive page. @module pages/usage/useUsageCalendarData */
import {useCallback,useEffect,useRef,useState} from 'react'
import {getBeijingDayKey} from './calendarUtils'

/** @param {boolean} isActive @returns {object} */
export default function useUsageCalendarData(isActive=true) {
  const [today,setToday]=useState(()=>getBeijingDayKey()),[month,setMonth]=useState(()=>getBeijingDayKey().slice(0,7))
  const [selected,setSelected]=useState(()=>getBeijingDayKey()),[data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[progress,setProgress]=useState({processedDays:0,totalDays:0})
  const requestId=useRef(null),cache=useRef({}),lastScan=useRef(0),pending=useRef(false),mounted=useRef(true)
  // A resumed timer may deliver several ticks before React renders; consume the day transition once.
  const observedDay=useRef(today)
  const selectDefault=useCallback(result=>{
    setSelected(prev=>{
      if(prev?.slice(0,7)===result.month&&result.days[prev]?.status==='ready')return prev
      if(result.month===result.today.slice(0,7))return result.today
      return Object.keys(result.days).filter(k=>result.days[k].status==='ready'&&result.days[k].total>0).sort().at(-1)||null
    })
  },[])
  const load=useCallback(async(requestMonth,options={})=>{
    const taskId=crypto.randomUUID(),retryDate=options.retryDate
    requestId.current=taskId;pending.current=true;setLoading(true);setError('');setProgress({processedDays:0,totalDays:0})
    const apply=result=>{
      if(!mounted.current||requestId.current!==taskId)return
      const merged=retryDate?{...cache.current[requestMonth],...result,days:{...cache.current[requestMonth]?.days,...result.days}}:result
      merged.total=Object.values(merged.days).reduce((sum,d)=>sum+(d.status==='ready'?d.total:0),0)
      merged.failedDays=Object.values(merged.days).filter(d=>d.status==='failed').length
      merged.complete=merged.failedDays===0
      cache.current[requestMonth]=merged;setData(merged);setToday(merged.today);selectDefault(merged)
    }
    try {
      const response=await window.electronAPI.aggregateUsageCalendar({month:requestMonth,taskId,...(retryDate?{retryDate}:{})})
      if(requestId.current!==taskId||!mounted.current)return
      if(!response.success)throw Error(response.error||'统计失败，请重试')
      apply(response.data);lastScan.current=Date.now()
    }catch(e){if(mounted.current&&requestId.current===taskId)setError(e.message||'统计失败，请重试')}
    finally{if(mounted.current&&requestId.current===taskId){pending.current=false;setLoading(false)}}
  },[selectDefault])
  useEffect(()=>{
    if(isActive){const day=getBeijingDayKey();setMonth(day.slice(0,7));setSelected(day)}
  },[isActive])
  useEffect(()=>{
    mounted.current=true
    const unsubscribe=window.electronAPI.onUsageCalendarProgress?.(event=>{
      if(!mounted.current||event.taskId!==requestId.current)return
      setProgress({processedDays:event.processedDays,totalDays:event.totalDays})
      if(event.data){
        const merged={...event.data,days:{...cache.current[event.data.month]?.days,...event.data.days}}
        setData(merged);setToday(merged.today)
      }
    })
    return()=>{mounted.current=false;requestId.current=null;unsubscribe?.()}
  },[])
  useEffect(()=>{
    if(!isActive)return
    const cached=cache.current[month]
    if(cached&&month!==getBeijingDayKey().slice(0,7)){setData(cached);setLoading(false);selectDefault(cached)}
    else {setData(cache.current[month]||null);load(month)}
    return()=>{requestId.current=null;pending.current=false}
  },[isActive,month,load,selectDefault])
  useEffect(()=>{
    if(!isActive)return
    const timer=setInterval(()=>{
      const day=getBeijingDayKey(),previousDay=observedDay.current;observedDay.current=day;setToday(day)
      const closePreviousMonth=day!==previousDay&&month===previousDay.slice(0,7)
      if(!pending.current&&(closePreviousMonth||(month===day.slice(0,7)&&(day!==previousDay||Date.now()-lastScan.current>=5*60*1000))))load(month)
    },60000)
    return()=>clearInterval(timer)
  },[isActive,month,today,load])
  return {today,month,setMonth,selected,setSelected,data:data?.month===month?data:null,loading,error,progress,retry:date=>{if(date)setSelected(date);return load(month,{retryDate:date})},refresh:()=>load(month)}
}
