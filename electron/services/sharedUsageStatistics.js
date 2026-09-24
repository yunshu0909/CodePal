/**
 * Shared source/day Token statistics for calendars, ranges and subscription costs.
 * - One queue, atomic source-aware snapshots and one published sampling clock.
 * - Reuse the existing scanners and aggregators; queries never refresh cached days.
 * @module services/sharedUsageStatistics
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const {randomUUID} = require('node:crypto')
const {scanClaudeLogs,scanCodexLogs,scanDshLogs,aggregateByModel,aggregateByProject,findEarliestLogDate,findEarliestClaudeDate,findEarliestCodexDate} = require('./usageLogScanService')
const {DAILY_SUMMARY_SCHEMA_VERSION,buildDailySummary,normalizeDailySummary,mergeDailySummaries} = require('./dailySummaryService')
const {createLogScanWindowContext} = require('../logScanner')
const SOURCES = ['claude','codex','dsh'], FIELDS = ['input','output','cacheRead','cacheCreate']
const SCHEMA = 1, SEMANTICS = `source-day-v1:daily-${DAILY_SUMMARY_SCHEMA_VERSION}`, DAY = 86400000, EARLIEST_TTL = 3600000
const dayKey = date => new Date(new Date(date).getTime()+8*3600000).toISOString().slice(0,10)
const midnight = key => new Date(key+'T00:00:00+08:00')
const validDay = key => typeof key==='string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(midnight(key).getTime()) && dayKey(midnight(key))===key
const nextDay = key => dayKey(new Date(midnight(key).getTime()+DAY))
const sourcePath = (home,id) => path.join(home,'.'+(id==='claude'?'claude':id==='codex'?'codex':'dsh'),id==='claude'?'projects':'sessions')

/** @param {string} home Tool home root. @returns {object} Atomic versioned disk storage. */
function createStatisticsStorage(home=os.homedir()) {
  const directory=path.join(home,'.ai-workbench','source-daily-stats')
  const filename=key=>{if(key!=='metadata'&&!validDay(key))throw Error('INVALID_DAY');return path.join(directory,key+'.json')}
  return {
    async read(key){try{return JSON.parse(await fs.readFile(filename(key),'utf8'))}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e}},
    async write(key,value){await fs.mkdir(directory,{recursive:true});const destination=filename(key),temp=destination+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600});await fs.rename(temp,destination)}finally{await fs.unlink(temp).catch(()=>{})}},
    async list(){try{return(await fs.readdir(directory)).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(n=>n.slice(0,10))}catch(e){if(e.code==='ENOENT')return [];throw e}}
  }
}

/** @param {object} deps Optional isolated storage/scanners/clock. @returns {object} Shared statistics authority. */
function createSharedUsageStatistics({homeDir=os.homedir(),storage=createStatisticsStorage(homeDir),scanFn,sourceStatusFn,earliestFn,sourceEarliestFn,legacyReadFn,nowFn=()=>new Date()}={}) {
  const days=new Map(),listeners=new Set(),progressListeners=new Set()
  const openDays=new Set(),demand=new Map()
  let tail=Promise.resolve(),initialized=null,discoveryPromise=null,discovered=false,earliestDate=null,dataCutoff=null,revision=0,ticking=null,lastRunAt=null,scans=0
  const scan = scanFn || ((id,start,end,options)=>({claude:scanClaudeLogs,codex:scanCodexLogs,dsh:scanDshLogs}[id])(start,end,{...options,homeDir,strictScan:true,pathExistsFn:async()=>true}))
  const status = sourceStatusFn || (async id=>{try{const s=await fs.stat(sourcePath(homeDir,id));if(!s.isDirectory())throw Error('SOURCE_NOT_DIRECTORY');return 'present'}catch(e){if(e.code==='ENOENT')return 'missing';throw e}})
  const legacyRead = legacyReadFn || (async key=>{try{return normalizeDailySummary(JSON.parse(await fs.readFile(path.join(homeDir,'.ai-workbench','daily-stats',key+'.json'),'utf8')),key)}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e}})
  const logEarliest = sourceEarliestFn || (id=>id==='claude'?findEarliestClaudeDate(sourcePath(homeDir,'claude')):findEarliestCodexDate(sourcePath(homeDir,'codex')))
  const earliestMemo=new Map()
  // 单来源最早有用量的日期 = min(日志目录最早日, 逐日缓存里该来源最早有 token 的日)；日志被清理后缓存仍能保住历史
  // Claude 的日志探测要逐文件读首行，按小时缓存
  async function getSourceEarliestDate(id){
    if(!['claude','codex'].includes(id))throw Error('INVALID_PLAN')
    const hit=earliestMemo.get(id)
    if(hit&&nowFn().getTime()-hit.at<EARLIEST_TTL)return hit.value
    await initialize()
    let fromLogs=null
    try{const value=await logEarliest(id);fromLogs=validDay(value)?value:null}catch{/* Unreadable logs only lose the log-side hint. */}
    let fromCache=null
    for(const key of (await storage.list()).sort()){const e=await loadDay(key);if(e?.sources?.[id]?.records?.some(r=>FIELDS.some(f=>r[f]>0))){fromCache=key;break}}
    const value=[fromLogs,fromCache].filter(Boolean).sort()[0]||null
    earliestMemo.set(id,{value,at:nowFn().getTime()})
    return value
  }
  const emit=(set,event)=>{for(const listener of set){try{listener(event)}catch{/* A closed consumer cannot fail a background batch. */}}}
  const enqueue=fn=>{const result=tail.then(fn);tail=result.catch(()=>{});return result}
  function initialize(){
    if(!initialized)initialized=(async()=>{const m=await storage.read('metadata');if(m?.schemaVersion===SCHEMA&&m.semantics===SEMANTICS){revision=m.revision||0;dataCutoff=m.dataCutoff||null;lastRunAt=m.lastRunAt||null;earliestDate=m.earliestDate||null;discovered=m.discovered===true;for(const key of m.openDays||[])if(validDay(key))openDays.add(key)}})()
    return initialized
  }
  const metadata=()=>({schemaVersion:SCHEMA,semantics:SEMANTICS,revision,dataCutoff,lastRunAt,earliestDate,discovered,openDays:[...openDays]})
  function good(entry,key){
    return entry?.schemaVersion===SCHEMA&&entry.semantics===SEMANTICS&&entry.date===key&&SOURCES.every(id=>{
      const s=entry.sources?.[id]
      return s&&['ready','missing','failed'].includes(s.status)&&typeof s.complete==='boolean'&&Array.isArray(s.records)&&Number.isFinite(Date.parse(s.cutoff))&&Date.parse(s.cutoff)>midnight(key).getTime()&&Date.parse(s.cutoff)<=midnight(nextDay(key)).getTime()&&s.records.every(r=>typeof r.model==='string'&&Number.isFinite(Date.parse(r.timestamp))&&Date.parse(r.timestamp)>=midnight(key).getTime()&&Date.parse(r.timestamp)<Math.min(midnight(nextDay(key)).getTime(),Date.parse(s.cutoff))&&FIELDS.every(f=>Number.isInteger(r[f])&&r[f]>=0))
    })
  }
  async function loadDay(key){if(days.has(key))return days.get(key);const entry=await storage.read(key);if(good(entry,key)){days.set(key,entry);return entry}return null}
  async function discover(){
    await initialize()
    if(discovered)return earliestDate
    if(discoveryPromise)return discoveryPromise
    discoveryPromise=(async()=>{
      if(!earliestDate){earliestDate=await(earliestFn||(()=>findEarliestLogDate({homeDir})))();const stored=await storage.list();const legacyDir=path.join(homeDir,'.ai-workbench','daily-stats');let archived=[]
      if(!legacyReadFn){try{archived=(await fs.readdir(legacyDir)).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(n=>n.slice(0,10)).sort();for(const key of archived){const old=await legacyRead(key);if(old?.summary?.total>0){stored.push(key);break}}}catch(e){if(e.code!=='ENOENT')throw e}}
      for(const key of stored.sort()){const e=await loadDay(key);if(e&&SOURCES.some(id=>e.sources[id].records.some(r=>FIELDS.some(f=>r[f]>0)))){earliestDate=!earliestDate||key<earliestDate?key:earliestDate;break}}
      // Old aggregate-only dates remain navigable even if the original sessions were removed.
      if(archived.length){const key=stored.find(k=>archived.includes(k));if(key)earliestDate=!earliestDate||key<earliestDate?key:earliestDate}
      }
      discovered=true;return earliestDate
    })().catch(error=>{discoveryPromise=null;throw error})
    return discoveryPromise
  }
  const recordsOf=entry=>SOURCES.flatMap(id=>entry.sources[id].status==='ready'?entry.sources[id].records:[])
  function projectDay(entry){
    const failed=SOURCES.some(id=>entry.sources[id].status==='failed')
    if(failed)return {status:'failed',error:'统计失败'}
    if(entry.legacy)return {status:'ready',total:entry.legacy.summary.total,models:entry.legacy.models,cached:true,generatedAt:entry.legacy.generatedAt,legacy:true}
    const summary=buildDailySummary(entry.date,aggregateByModel(recordsOf(entry)),aggregateByProject(recordsOf(entry)),new Date(entry.cutoff))
    return {status:'ready',total:summary.summary.total,models:summary.models,cached:entry.date<dayKey(nowFn()),generatedAt:summary.generatedAt}
  }
  async function fillDay(key,cutoff,context,{force=false,retry=false}={}) {
    const old=await loadDay(key)
    if(old&&!force&&!retry)return false
    const end=new Date(Math.min(midnight(nextDay(key)).getTime(),cutoff.getTime()))
    if(end<=midnight(key))return false
    const sources={...(old?.sources||{})}
    for(const id of SOURCES){
      if(retry&&old&&old.sources[id].status!=='failed')continue
      try{
        const exists=await status(id)
        if(exists!=='missing')scans++
        const raw=exists==='missing'?[]:await scan(id,midnight(key),end,{windowContext:context,strictScan:true})
        if(!Array.isArray(raw))throw Error('INVALID_SCAN_RESULT')
        const records=raw.filter(r=>new Date(r.timestamp).getTime()>=midnight(key).getTime()&&new Date(r.timestamp).getTime()<end.getTime()).map(r=>({timestamp:new Date(r.timestamp).toISOString(),model:typeof r.model==='string'?r.model:'unknown',project:typeof r.project==='string'?r.project:'未知项目',...Object.fromEntries(FIELDS.map(f=>[f,typeof r[f]==='number'&&Number.isFinite(r[f])?Math.max(0,Math.floor(r[f])):0]))}))
        sources[id]={status:exists==='missing'?'missing':'ready',records,cutoff:end.toISOString(),complete:end.getTime()===midnight(nextDay(key)).getTime()}
      }catch(error){
        // 记下失败原因（错误码优先），排查时能区分权限、格式、超时等
        const reason=String(error?.code||error?.message||'UNKNOWN').slice(0,80)
        const previous=old?.sources[id]?.status==='ready'?old.sources[id]:old?.sources[id]?.lastSuccess
        sources[id]={status:'failed',reason,records:[],cutoff:end.toISOString(),complete:false,...(previous?{lastSuccess:previous}:{})}
      }
    }
    const entry={schemaVersion:SCHEMA,semantics:SEMANTICS,date:key,cutoff:end.toISOString(),revision:revision+1,sources}
    const legacy=old?.legacy||await legacyRead(key)
    const total=recordsOf(entry).reduce((sum,r)=>sum+FIELDS.reduce((s,f)=>s+r[f],0),0)
    if(total>0&&(!earliestDate||key<earliestDate))earliestDate=key
    // A positive old ledger cannot be reconstructed as zero or guessed into CLI buckets.
    if(legacy?.summary?.total>0&&total<legacy.summary.total&&(total===0||SOURCES.some(id=>sources[id].status==='missing')))entry.legacy=legacy
    await storage.write(key,entry);days.set(key,entry)
    if(end.getTime()<midnight(nextDay(key)).getTime())openDays.add(key);else openDays.delete(key)
    emit(progressListeners,{date:key,revision:revision+1,cutoff:end.toISOString()})
    return true
  }
  function dates(start,end,cutoff){
    if(!validDay(start)||!validDay(end)||end<=start||!Number.isFinite(cutoff.getTime()))throw Error('INVALID_RANGE')
    const keys=[],upper=Math.min(midnight(end).getTime(),cutoff.getTime())
    for(let time=midnight(start).getTime();time<upper;time+=DAY)keys.push(dayKey(new Date(time)))
    return keys
  }
  async function fillRange(start,end,options={}){
    await initialize()
    const cutoff=new Date(options.cutoff||dataCutoff||nowFn()),keys=dates(start,end,cutoff),context=createLogScanWindowContext(midnight(start))
    let changed=false
    for(const key of keys)changed=await fillDay(key,cutoff,context,{force:options.force===true,retry:options.retry===true})||changed
    if(changed){revision++;if(!dataCutoff)dataCutoff=cutoff.toISOString();await storage.write('metadata',metadata());if(options.publish!==false)emit(listeners,{revision,cutoff:dataCutoff,today:dayKey(nowFn())})}
    return keys
  }
  function ensureRange(start,end,options){return enqueue(()=>fillRange(start,end,options))}
  function calendarSnapshot(month,taskId){
    const today=dayKey(nowFn()),end=nextDay(today),monthEnd=dayKey(new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),1)-8*3600000))
    const keys=earliestDate?dates(month+'-01',monthEnd,new Date(Math.min(midnight(end).getTime(),nowFn().getTime()))).filter(k=>k>=earliestDate):[]
    const result={month,today,earliestDate,days:{},total:0,complete:true,failedDays:0,legacyCacheDays:0,generatedAt:dataCutoff,revision,loading:false}
    let processedDays=0
    for(const key of keys){const e=days.get(key);if(!e){result.loading=true;continue}const day=projectDay(e);result.days[key]=day;processedDays++
      if(day.status==='failed'){result.failedDays++;result.complete=false}else{result.total+=day.total;if(day.legacy)result.legacyCacheDays++}
      if(key<today&&SOURCES.some(id=>!e.sources[id].complete&&e.sources[id].status!=='failed'))result.loading=true
    }
    return {taskId,processedDays,totalDays:keys.length,data:result}
  }
  /** @param {object} params Original month/taskId/retryDate fields. @param {Function} onProgress Original progress projection. @returns {Promise<object>} Month snapshot. */
  async function getCalendar({month,taskId,retryDate},onProgress){
    if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>dayKey(nowFn()).slice(0,7))throw Error('INVALID_MONTH')
    if(retryDate&&(!validDay(retryDate)||retryDate.slice(0,7)!==month||retryDate>dayKey(nowFn())))throw Error('INVALID_DAY')
    await discover()
    const progress=()=>onProgress?.(calendarSnapshot(month,taskId))
    progressListeners.add(progress)
    try{
      progress()
      if(retryDate)await ensureRange(retryDate,nextDay(retryDate),{cutoff:new Date(dataCutoff||nowFn()),retry:true})
      else if(earliestDate){const start=month+'-01'>earliestDate?month+'-01':earliestDate;const end=dayKey(new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),1)-8*3600000));if(start<end)await ensureRange(start,end)}
      for(const key of Object.keys(calendarSnapshot(month,taskId).data.days))demand.set(key,nowFn().getTime())
      progress();return calendarSnapshot(month,taskId).data
    }finally{progressListeners.delete(progress)}
  }
  /** @param {string} id CLI source. @param {object} cycle Trusted ledger range. @returns {Promise<object>} Safe records with shared cutoff. */
  async function getPlanTokens(id,cycle){
    if(!['claude','codex'].includes(id))throw Error('INVALID_PLAN')
    await initialize()
    const cutoff=new Date(dataCutoff||nowFn())
    if(!validDay(cycle.start)||!validDay(cycle.end)||cycle.end<=cycle.start)throw Error('INVALID_RANGE')
    if(midnight(cycle.start)>=cutoff)return {records:[],pending:true,cutoff:cutoff.toISOString(),revision,metrics:{scans:0,cacheHits:0,records:0,elapsedMs:0}}
    const before=scans,started=performance.now(),keys=await ensureRange(cycle.start,cycle.end,{cutoff}),records=[]
    const publishedCutoff=new Date(dataCutoff||cutoff)
    for(const key of keys)demand.set(key,nowFn().getTime())
    let missingSource=true,pending=false
    for(const key of keys){const e=days.get(key),s=e.sources[id]
      if(e.legacy)throw Error('SOURCE_UNVERIFIABLE')
      if(s.status==='failed')throw Error('SOURCE_FAILED')
      if(s.status!=='missing')missingSource=false
      if(key<dayKey(nowFn())&&!s.complete)pending=true
      records.push(...s.records.filter(r=>Date.parse(r.timestamp)<Math.min(publishedCutoff.getTime(),midnight(cycle.end).getTime())).map(r=>({...r,source:id})))
    }
    return {records,missingSource,pending,cutoff:publishedCutoff.toISOString(),revision,metrics:{scans:scans-before,cacheHits:scans===before?keys.length:0,records:records.length,elapsedMs:performance.now()-started}}
  }
  async function readLegacyDay(key,{ensure=false}={}){
    if(!validDay(key))throw Error('INVALID_DAY')
    if(ensure)await ensureRange(key,nextDay(key))
    const entry=await loadDay(key)
    if(!entry){const legacy=await legacyRead(key);return legacy?{...legacy,calendarSourceChecked:false}:null}
    if(entry.legacy)return {...entry.legacy,calendarSourceChecked:false}
    if(SOURCES.some(id=>entry.sources[id].status==='failed')){if(ensure)throw Error('SOURCE_FAILED');return null}
    return {...buildDailySummary(key,aggregateByModel(recordsOf(entry)),aggregateByProject(recordsOf(entry)),new Date(entry.cutoff)),calendarSourceChecked:true}
  }
  /** @returns {Promise<object>} Legacy today's view inputs from the same published source snapshot. */
  async function getTodayAggregates(){
    await initialize()
    const today=dayKey(nowFn()),cutoff=new Date(dataCutoff||nowFn())
    if(cutoff<=midnight(today))throw Error('STATISTICS_PENDING')
    await ensureRange(today,nextDay(today),{cutoff})
    const entry=days.get(today)
    if(SOURCES.some(id=>entry.sources[id].status==='failed'))throw Error('SOURCE_FAILED')
    if(entry.legacy)return {...mergeDailySummaries([entry.legacy]),recordCount:null,cutoff:entry.legacy.generatedAt,revision,legacy:true}
    const records=recordsOf(entry)
    return {models:aggregateByModel(records),projects:aggregateByProject(records),recordCount:records.length,cutoff:dataCutoff,revision}
  }
  async function tick(){
    if(ticking)return ticking
    ticking=enqueue(async()=>{
      await initialize();const cutoff=nowFn(),today=dayKey(cutoff),open=[...openDays].filter(key=>key<today)
      for(const [key,touched] of demand){if(cutoff.getTime()-touched>600000){demand.delete(key);continue}const e=await loadDay(key);if(key<today&&e&&SOURCES.some(id=>e.sources[id].status==='failed')&&!open.includes(key))open.push(key)}
      for(const key of open.sort())await fillRange(key,nextDay(key),{cutoff,force:true,publish:false})
      await fillRange(today,nextDay(today),{cutoff,force:true,publish:false})
      dataCutoff=cutoff.toISOString();lastRunAt=dataCutoff;await storage.write('metadata',metadata());emit(listeners,{revision,cutoff:dataCutoff,today})
    }).finally(()=>{ticking=null})
    return ticking
  }
  async function bootstrap(cycles=[]){
    await discover()
    if(!lastRunAt||nowFn().getTime()-Date.parse(lastRunAt)>=300000)await tick()
    const today=dayKey(nowFn())
    if(earliestDate){const start=today.slice(0,7)+'-01'>earliestDate?today.slice(0,7)+'-01':earliestDate;await ensureRange(start,nextDay(today))}
    for(const c of cycles)if(c?.start&&c?.end)await ensureRange(c.start,c.end)
    return {lastRunAt,dataCutoff,revision}
  }
  return {ensureRange,getCalendar,getPlanTokens,getTodayAggregates,getEarliestDate:discover,getSourceEarliestDate,readLegacyDay,tick,bootstrap,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},snapshot:()=>({revision,dataCutoff,lastRunAt,earliestDate,scans,queuedOpenDays:openDays.size}),async earliestLedgerDay(){await initialize();for(const key of (await storage.list()).sort()){const e=await loadDay(key);if(e&&(e.legacy?.summary?.total>0||recordsOf(e).some(r=>FIELDS.some(f=>r[f]>0))))return key}if(!legacyReadFn){try{for(const name of (await fs.readdir(path.join(homeDir,'.ai-workbench','daily-stats'))).sort()){const key=name.slice(0,10);if(validDay(key)&&(await legacyRead(key))?.summary?.total>0)return key}}catch(e){if(e.code!=='ENOENT')throw e}}return null}}
}
module.exports={createSharedUsageStatistics,createStatisticsStorage,SCHEMA,SEMANTICS,dayKey,nextDay}
