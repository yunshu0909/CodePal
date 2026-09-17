/* @vitest-environment node */
/** Beijing cycle and immutable history contracts. @module tests/planCycles */
import { it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
const {beijingDate,containingCycle,nextBillingDate,reconcilePlan,savePlan,performPlanAction}=require('../../electron/services/plan/planCycleService')
const period=(start='2026-08-20',end='2026-09-20',price=20)=>({id:start,end,start,price})
const plan=(over={})=>({price:20,billingDay:20,autoRenew:false,stopped:false,version:1,cycles:[period()],...over})
it('TC-011 Beijing dates and exact progress fixture',()=>{
 expect(beijingDate(new Date('2026-09-19T16:00:00Z'))).toBe('2026-09-20')
 expect(containingCycle(20,'2026-09-16')).toMatchObject({start:'2026-08-20',end:'2026-09-20'})
})
it('TC-018 change anchor with history preserves current start',()=>{
 const p=plan({cycles:[period('2026-07-20','2026-08-20'),period()]});const r=savePlan(p,{price:20,billingDay:25,autoRenew:false},'2026-09-17')
 expect(r.cycles[0]).toEqual(p.cycles[0]);expect(r.cycles[1]).toMatchObject({start:'2026-08-20',end:'2026-09-25'})
})
it('TC-019 auto renewal enters next cycle on end date',()=>{
 const r=reconcilePlan(plan({autoRenew:true}),'2026-09-20');expect(r.cycles).toHaveLength(2);expect(r.cycles[1]).toMatchObject({start:'2026-09-20',end:'2026-10-20',price:20})
})
it('TC-044 short month retains original billing anchor',()=>{
 expect(nextBillingDate('2026-01-31',31)).toBe('2026-02-28');expect(nextBillingDate('2026-02-28',31)).toBe('2026-03-31');expect(nextBillingDate('2028-01-31',31)).toBe('2028-02-29');expect(nextBillingDate('2028-02-29',31)).toBe('2028-03-31')
})
it('TC-045 year transition',()=>expect(nextBillingDate('2026-12-30',30)).toBe('2027-01-30'))
it('TC-047 offline backfill records saved price without rewriting history',()=>{
 const p=plan({autoRenew:true,cycles:[period('2026-05-20','2026-06-20')]});const r=reconcilePlan(p,'2026-09-17')
 expect(r.cycles.map(x=>[x.start,x.end,x.price])).toEqual([['2026-05-20','2026-06-20',20],['2026-06-20','2026-07-20',20],['2026-07-20','2026-08-20',20],['2026-08-20','2026-09-20',20]])
 const changed=savePlan(r,{price:100,billingDay:20,autoRenew:true},'2026-09-17');expect(changed.cycles.map(x=>x.price)).toEqual([20,20,20,100]);expect(p.cycles).toHaveLength(1)
})
it('TC-048 manual renewal adds exactly one overdue cycle',()=>{
 const r=performPlanAction(plan({cycles:[period('2026-05-20','2026-06-20')]}),'renew','2026-09-17');expect(r.cycles).toHaveLength(2);expect(r.cycles[1]).toMatchObject({start:'2026-06-20',end:'2026-07-20'})
})
it('TC-049 restart uses today for a full calendar month',()=>{
 const p=plan({price:100,stopped:true,cycles:[period('2026-07-20','2026-08-20')]});const r=performPlanAction(p,'restart','2026-09-17');expect(r).toMatchObject({price:100,billingDay:17,stopped:false,autoRenew:false});expect(r.cycles.at(-1)).toMatchObject({start:'2026-09-17',end:'2026-10-17',price:100});expect(r.cycles[0]).toEqual(p.cycles[0])
})
it('TC-050 restart pure transformation never mutates saved ledger',()=>{
 const p=plan({stopped:true});const before=structuredClone(p);performPlanAction(p,'restart','2026-09-17');expect(p).toEqual(before)
})
it('TC-051 repeated restart only acts while stopped',()=>{
 const p=performPlanAction(plan({stopped:true}),'restart','2026-09-17');expect(performPlanAction(p,'restart','2026-09-17').cycles).toEqual(p.cycles)
})
it('TC-054 first cycle anchor change does not fabricate past history',()=>{
 const r=savePlan(plan(),{price:20,billingDay:25,autoRenew:false},'2026-09-17');expect(r.cycles).toHaveLength(1);expect(r.cycles[0]).toMatchObject({start:'2026-08-25',end:'2026-09-25'})
})
it('TC-055 changed day strictly after today never cuts off current period',()=>{
 const r=savePlan(plan({cycles:[period('2026-07-20','2026-08-20'),period()]}),{price:20,billingDay:10,autoRenew:false},'2026-09-17');expect(r.cycles[1]).toMatchObject({start:'2026-08-20',end:'2026-10-10'})
})
it('TC-069 first successful setup creates only containing cycle',()=>{
 const r=savePlan({cycles:[],stopped:false,version:0},{price:20,billingDay:20,autoRenew:false},'2026-09-17');expect(r.cycles).toHaveLength(1);expect(r.cycles[0]).toMatchObject({start:'2026-08-20',end:'2026-09-20'})
})
it('TC-073 lifecycle is rechecked on next read crossing Beijing midnight',()=>{
 expect(reconcilePlan(plan(),'2026-09-19').cycles).toHaveLength(1);expect(reconcilePlan(plan(),'2026-09-20').cycles).toHaveLength(1);expect(reconcilePlan(plan({autoRenew:true}),'2026-09-20').cycles).toHaveLength(2)
})
it('TC-077 renewal uses new config price and anchor, preserves ended cycle',()=>{
 const p=plan({price:100,billingDay:25});const r=performPlanAction(p,'renew','2026-09-21');expect(r.cycles[0]).toEqual(p.cycles[0]);expect(r.cycles[1]).toMatchObject({start:'2026-09-20',end:'2026-09-25',price:100})
})
it('TC-078 changing stopped autoRenew never restarts automatically',()=>{
 const p=plan({stopped:true});const r=savePlan(p,{price:100,billingDay:25,autoRenew:true},'2026-10-01');expect(r.stopped).toBe(true);expect(reconcilePlan(r,'2026-11-01').cycles).toEqual(p.cycles)
})
it('TC-080 Jan31 restart and subsequent auto renewal retain day31',()=>{
 const r=performPlanAction(plan({stopped:true,autoRenew:true,cycles:[period('2025-12-20','2026-01-20')]}),'restart','2026-01-31');expect(r.billingDay).toBe(31);expect(r.cycles.at(-1)).toMatchObject({start:'2026-01-31',end:'2026-02-28'});expect(reconcilePlan(r,'2026-02-28').cycles.at(-1)).toMatchObject({start:'2026-02-28',end:'2026-03-31'})
})
it('TC-050 writer failure keeps saved restart anchor and entire ledger unchanged',async()=>{
 const {createPlanStoreService}=require('../../electron/services/plan/planStoreService');const p=plan({stopped:true,cycles:[period('2026-07-20','2026-08-20')]});const data={schemaVersion:1,plans:{claude:p,codex:{cycles:[],version:0,stopped:false}}};const svc=createPlanStoreService({store:{get:()=>structuredClone(data),set:async()=>{throw Error('EIO')}},nowFn:()=>new Date('2026-09-17T04:00Z')});await expect(svc.act('claude','restart','restart-failure')).rejects.toThrow();expect((await svc.read('claude')).plan).toEqual(p)
})
it('TC-051 main queue deduplicates restart operation IDs',async()=>{
 const {createPlanStoreService}=require('../../electron/services/plan/planStoreService');let saved={schemaVersion:1,plans:{claude:plan({stopped:true,cycles:[period('2026-07-20','2026-08-20')]}),codex:{cycles:[],version:0,stopped:false}}};let writes=0;const svc=createPlanStoreService({store:{get:()=>structuredClone(saved),set:async(k,v)=>{writes++;saved=structuredClone(v)}},nowFn:()=>new Date('2026-09-17T04:00Z')});await Promise.all([svc.act('claude','restart','restart-dup'),svc.act('claude','restart','restart-dup')]);expect(saved.plans.claude.cycles).toHaveLength(2);expect(writes).toBe(1)
})
