/** Natural-month daily results; legacy range APIs stay independent. @module electron/services/usageCalendarService */
const fs = require('fs/promises')
const {createLogScanWindowContext}=require('../logScanner')
const {readDailySummary,writeDailySummary,recomputeDailySummary}=require('./dailySummaryService')
const {findEarliestLogDate}=require('./usageLogScanService')

/** Strict access distinguishes missing tools from unreadable logs. @param {string} path @returns {Promise<boolean>} */
async function strictPathExists(path) {try{await fs.access(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
/** @param {{month:string,taskId?:string,retryDate?:string}} params @param {object} deps @returns {Promise<object>} */
async function aggregateUsageCalendar(params={},deps={}) {
  if(deps.statistics){try{return {success:true,data:await deps.statistics.getCalendar(params,deps.onProgress)}}catch(error){return {success:false,error:['INVALID_MONTH','INVALID_DAY'].includes(error.message)?error.message:'读取日志失败，请重试'}}}
  if (!params || typeof params !== 'object') return {success:false,error:'INVALID_MONTH'}
  const now=deps.nowFn?deps.nowFn():new Date(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
  const month=params.month,taskId=params.taskId
  if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>today.slice(0,7))return {success:false,error:'INVALID_MONTH'}
  const [year,m]=month.split('-').map(Number),count=new Date(Date.UTC(year,m,0)).getUTCDate(),last=`${month}-${String(count).padStart(2,'0')}`
  if(params.retryDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(params.retryDate)||params.retryDate.slice(0,7)!==month||params.retryDate>last||params.retryDate>today||Number(params.retryDate.slice(8))<1))return {success:false,error:'INVALID_DAY'}
  try {
    const scanDeps={...deps,pathExistsFn:deps.pathExistsFn||strictPathExists,strictScan:true,nowFn:()=>now}
    const earliestDate=await (deps.findEarliestLogDateFn||findEarliestLogDate)(scanDeps)
    const data={month,today,earliestDate,days:{},total:0,complete:true,failedDays:0,legacyCacheDays:0,generatedAt:now.toISOString()}
    const keys=Array.from({length:count},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`).filter(k=>earliestDate&&k>=earliestDate&&k<=today&&(!params.retryDate||k===params.retryDate))
    if(params.retryDate&&keys.length===0)return {success:false,error:'INVALID_DAY'}
    const context=keys.length?createLogScanWindowContext(new Date(`${keys[0]}T00:00:00+08:00`)):null
    const dailyDeps={...scanDeps,windowContext:context}
    const read=deps.readDailySummaryFn||readDailySummary,write=deps.writeDailySummaryFn||writeDailySummary,recompute=deps.recomputeDailySummaryFn||recomputeDailySummary
    const emit=processedDays=>deps.onProgress?.({taskId,processedDays,totalDays:keys.length,data:structuredClone(data)})
    await emit(0)
    for(const [index,key] of keys.entries()){
      try {
        // Today and explicit retry bypass both snapshot layers. Today is never persisted as a closed day.
        let summary=key===today||params.retryDate?null:await read(key,dailyDeps)
        const cached=Boolean(summary)
        if(!summary){summary=await recompute(key,dailyDeps);if(key!==today)await write(key,{...summary,calendarSourceChecked:true},dailyDeps)}
        if(!summary||!summary.models||!Number.isFinite(summary.summary?.total))throw Error('INVALID_SUMMARY')
        const total=Object.values(summary.models).reduce((s,v)=>s+(Number(v.total)||0),0)
        data.days[key]={status:'ready',total,models:summary.models,cached,generatedAt:summary.generatedAt}
        data.total+=total
        if(cached&&!summary.calendarSourceChecked)data.legacyCacheDays++
      }catch{
        data.days[key]={status:'failed',error:'统计失败'};data.failedDays++;data.complete=false
      }
      await emit(index+1)
      await new Promise(resolve=>setImmediate(resolve))
    }
    return {success:true,data}
  }catch{return {success:false,error:'读取日志失败，请重试'}}
}
module.exports={aggregateUsageCalendar}
