/* @vitest-environment node */
/** Backfilled estimated cycles and single-cycle price edits. @module tests/planHistoryBackfill */
import {it,expect,vi} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {backfillPlan,setCyclePrice}=require('../../electron/services/plan/planCycleService')
const {createPlanStoreService}=require('../../electron/services/plan/planStoreService')
const first=(start='2026-09-13',end='2026-10-13')=>({id:`${start}:${end}:0`,start,end,price:100})
const plan=(extra={})=>({price:100,billingDay:13,autoRenew:true,stopped:false,version:1,cycles:[first()],...extra})
const ranges=p=>p.cycles.map(c=>`${c.start}~${c.end}`)
const fixture=(p=plan(),{earliestFn=async()=> '2026-03-23',now='2026-09-19T04:00:00Z'}={})=>{const data={planLedgerV1:{schemaVersion:1,plans:{claude:{cycles:[],version:0,stopped:false},codex:p}}};const store={get:k=>structuredClone(data[k]),set:vi.fn(async(k,v)=>{data[k]=structuredClone(v)})};return{svc:createPlanStoreService({store,nowFn:()=>new Date(now),earliestFn}),store,data}}

it('TC-001 backfills estimated cycles from the earliest log period up to the first recorded cycle',()=>{
 const r=backfillPlan(plan(),'2026-03-23')
 expect(ranges(r)).toEqual(['2026-03-13~2026-04-13','2026-04-13~2026-05-13','2026-05-13~2026-06-13','2026-06-13~2026-07-13','2026-07-13~2026-08-13','2026-08-13~2026-09-13','2026-09-13~2026-10-13'])
 for(const c of r.cycles.slice(0,-1)){expect(c.estimated).toBe(true);expect(c.price).toBe(100);expect(c.id.endsWith(':e')).toBe(true)}
 expect(r.cycles.at(-1)).toEqual(first())
})
it('TC-001b clamps the last estimated cycle to a first cycle that is off the billing boundary',()=>{
 const r=backfillPlan(plan({cycles:[first('2026-09-06','2026-10-06')]}),'2026-08-20')
 expect(ranges(r)).toEqual(['2026-08-13~2026-09-06','2026-09-06~2026-10-06'])
})
it('TC-002 is idempotent, never shrinks and never goes before 2026-01',()=>{
 const once=backfillPlan(plan(),'2026-03-23')
 expect(backfillPlan(once,'2026-03-23')).toEqual(once)
 expect(backfillPlan(once,'2026-06-01')).toEqual(once)
 expect(backfillPlan(plan(),'2025-10-02').cycles[0].start).toBe('2026-01-13')
})
it('TC-003 no earliest date, a failing earliest lookup or an unset plan write nothing',async()=>{
 expect(backfillPlan(plan(),null)).toEqual(plan())
 const empty={cycles:[],version:0,stopped:false};expect(backfillPlan(empty,'2026-03-23')).toEqual(empty)
 const f=fixture(plan(),{earliestFn:async()=>{throw Error('scan')}});const r=await f.svc.read('codex');expect(r.plan.cycles).toHaveLength(1);expect(f.store.set).not.toHaveBeenCalled()
 const g=fixture(plan(),{earliestFn:async()=>null});await g.svc.read('codex');expect(g.store.set).not.toHaveBeenCalled()
})
it('TC-004 read persists the backfill once and keeps the last cycle for lifecycle and scheduling',async()=>{
 const f=fixture();const a=await f.svc.read('codex');expect(a.plan.cycles).toHaveLength(7);expect(a.plan.cycles.at(-1).id).toBe(first().id);expect(a.plan.version).toBe(2)
 const b=await f.svc.read('codex');expect(b.changed).toBe(false);expect(f.store.set).toHaveBeenCalledTimes(1)
 const done=fixture(plan({autoRenew:false}),{now:'2026-10-14T04:00:00Z'});await done.svc.read('codex');const renewed=await done.svc.act('codex','renew','renew-1');expect(renewed.plan.cycles.at(-2).id).toBe(first().id);expect(renewed.plan.cycles.at(-1).start).toBe('2026-10-13')
})
it('TC-005 single ended cycle price edit only touches that cycle',async()=>{
 const f=fixture();const read=await f.svc.read('codex');const target=read.plan.cycles[5]
 const r=await f.svc.setCyclePrice('codex',target.id,200,'cp-1',{expectedVersion:read.plan.version})
 expect(r.plan.cycles[5]).toMatchObject({price:200,estimated:false});expect(r.plan.cycles.filter(c=>c.price===200)).toHaveLength(1);expect(r.plan.price).toBe(100);expect(r.plan.version).toBe(read.plan.version+1)
 await expect(f.svc.setCyclePrice('codex',first().id,50,'cp-2')).rejects.toThrow('INVALID_CYCLE')
 for(const bad of [0,-1,NaN,Infinity])await expect(f.svc.setCyclePrice('codex',target.id,bad,'cp-bad-'+bad)).rejects.toThrow('INVALID_SETTINGS')
 await expect(f.svc.setCyclePrice('codex',target.id,300,'cp-3',{expectedVersion:1})).rejects.toThrow('PLAN_CONFLICT')
 const dup=await f.svc.setCyclePrice('codex',target.id,200,'cp-1');expect(dup.duplicate).toBe(true)
 expect(()=>setCyclePrice(plan(),'missing',10)).toThrow('INVALID_CYCLE')
})
it('TC-006 old ledgers without estimated stay readable and non-boolean estimated is rejected',async()=>{
 const ok=fixture(plan(),{earliestFn:async()=>null});expect((await ok.svc.read('codex')).plan.cycles[0].estimated).toBeUndefined()
 const bad=fixture(plan({cycles:[{...first(),estimated:'yes'}]}),{earliestFn:async()=>null});await expect(bad.svc.read('codex')).rejects.toThrow('INVALID_LEDGER')
})
