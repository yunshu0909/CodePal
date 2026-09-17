/* @vitest-environment node */
/** Closed-day token cache and fixed cutoff contracts. @module tests/planUsage */
import {it,expect,vi} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {createPlanDailySummaryService}=require('../../electron/services/plan/planDailySummaryService')
const {createSharedUsageStatistics,SCHEMA:PLAN_CACHE_SCHEMA,SEMANTICS:SCAN_SEMANTICS_VERSION}=require('../../electron/services/sharedUsageStatistics')
const memory=()=>{const data={};return{get:k=>data[k],set:vi.fn((k,v)=>{data[k]=structuredClone(v)})}}
const rec=(timestamp,input=1)=>({timestamp:new Date(timestamp),model:'gpt-6-astra',input,output:0,cacheRead:0,cacheCreate:0})
const cutoff=new Date('2026-09-17T04:00:00Z')
const fixture=(extra={})=>{const store=memory();const scanFn=vi.fn(async()=>[]);const storage={read:async key=>store.get(key)||null,write:async(key,value)=>store.set(key,value),list:async()=>[]};const d={store,storage,scanFn,sourceStatusFn:async id=>id==='codex'?'present':'missing',nowFn:()=>cutoff,legacyReadFn:async()=>null,earliestFn:async()=>null,...extra};d.statistics=createSharedUsageStatistics(d);return d}
const query=(service,start='2026-09-15',end='2026-09-20')=>service.query('codex',{id:start,start,end,price:20},cutoff)
it('TC-035 missing source is successful zero and distinct missing flag',async()=>{
 const d=fixture({sourceStatusFn:async()=> 'missing'});const r=await query(createPlanDailySummaryService(d));expect(r.missingSource).toBe(true);expect(r.records).toEqual([]);expect(d.scanFn).not.toHaveBeenCalled()
})
it('TC-037 first full period reuses closed dates and scans missing ones through cutoff',async()=>{
 const d=fixture({scanFn:vi.fn(async(id,start,end)=>[rec(start.toISOString(),1)])});const svc=createPlanDailySummaryService(d);const r=await query(svc,'2026-08-20','2026-09-20');expect(d.scanFn).toHaveBeenCalledTimes(29);expect(r.records).toHaveLength(29);expect(d.scanFn.mock.calls[0][1].toISOString()).toBe('2026-08-19T16:00:00.000Z');expect(d.scanFn.mock.calls.at(-1)[2].toISOString()).toBe(cutoff.toISOString());d.scanFn.mockClear();await query(svc,'2026-08-20','2026-09-20');expect(d.scanFn).toHaveBeenCalledTimes(0)
})
it('TC-046 midnight event belongs to exactly one cycle',async()=>{
 const events=[rec('2026-09-19T15:59:59Z',2),rec('2026-09-19T16:00:00Z',10)];const d=fixture({scanFn:async()=>events,nowFn:()=>new Date('2026-09-21T04:00Z')});const svc=createPlanDailySummaryService(d);const old=await svc.query('codex',{start:'2026-09-19',end:'2026-09-20'},new Date('2026-09-21T04:00Z'));const next=await svc.query('codex',{start:'2026-09-20',end:'2026-09-21'},new Date('2026-09-21T04:00Z'));expect(old.records.map(r=>r.input)).toEqual([2]);expect(next.records.map(r=>r.input)).toEqual([10])
})
it('TC-052 restart excludes all gap logs before today',async()=>{
 const d=fixture({scanFn:async()=>[rec('2026-09-01T04:00Z',100),rec('2026-09-17T03:00Z',2)]});const r=await query(createPlanDailySummaryService(d),'2026-09-17','2026-10-17');expect(r.records.map(r=>r.input)).toEqual([2])
})
it('TC-060 today uses shared snapshot until background tick and future events excluded',async()=>{
 const d=fixture({scanFn:vi.fn(async()=>[rec('2026-09-17T03:00Z',200),rec('2026-09-17T05:00Z',50)])});const svc=createPlanDailySummaryService(d);expect((await query(svc,'2026-09-17')).records.map(x=>x.input)).toEqual([200]);expect((await query(svc,'2026-09-17')).records.map(x=>x.input)).toEqual([200]);expect(d.scanFn).toHaveBeenCalledTimes(1);expect(d.store.get('2026-09-17').sources.codex.complete).toBe(false)
})
it('TC-061 invalid cache semantics forces affected source/day reconstruction',async()=>{
 const d=fixture();d.store.set('2026-09-15',{schemaVersion:PLAN_CACHE_SCHEMA,semantics:'obsolete',records:[rec('2026-09-15T04:00Z',100)]});const svc=createPlanDailySummaryService(d);const r=await query(svc);expect(r.records).toEqual([]);expect(d.scanFn).toHaveBeenCalledTimes(3);expect(SCAN_SEMANTICS_VERSION).toBeTruthy()
})
it('TC-062 scanner permission failure is not persisted as empty or treated as missing',async()=>{
 const d=fixture({scanFn:async()=>{throw Object.assign(Error('secret fixture value'),{code:'EACCES'})}});await expect(query(createPlanDailySummaryService(d))).rejects.toThrow();expect(d.store.get('2026-09-15').sources.codex.status).toBe('failed');expect(d.store.get('2026-09-15').sources.codex.records).toEqual([])
})
