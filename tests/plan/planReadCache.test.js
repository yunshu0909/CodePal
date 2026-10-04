// @vitest-environment node
/** Authoritative ledger queries: no credentials, one queue and explicit write barrier. */
import {it,expect,vi} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {createPlanStoreService}=require('../../electron/services/plan/planStoreService')
function fixture(extra={}) {
 const data=new Map();const metadataFn=vi.fn(async()=>({type:'Pro',suggestedPrice:20,suggestedBillingDay:null}))
 const store={get:vi.fn(k=>data.get(k)),set:vi.fn(async(k,v)=>data.set(k,structuredClone(v)))}
 return {store,metadataFn,data,svc:createPlanStoreService({store,metadataFn,nowFn:()=>new Date('2026-10-04T04:00Z'),...extra})}
}
it('TC-005 ledger-only repeated callers share earliest and authoritative reads, full callers share safe metadata',async()=>{
 const earliestFn=vi.fn(async()=>null);const f=fixture({earliestFn})
 expect(typeof f.svc.readLedger).toBe('function')
 const result=await Promise.all(Array.from({length:8},()=>f.svc.readLedger('claude')))
 expect(earliestFn).toHaveBeenCalledTimes(1);expect(f.store.get).toHaveBeenCalledTimes(1);expect(f.metadataFn).not.toHaveBeenCalled()
 expect(result[0]).not.toHaveProperty('metadata')
 result[0].plan.version=99;expect(result[1].plan.version).toBe(0)
 await Promise.all([f.svc.read('claude'),f.svc.read('claude')])
 expect(f.metadataFn).toHaveBeenCalledTimes(1)
 await f.svc.readLedger('claude');expect(earliestFn.mock.calls.length).toBeGreaterThan(1)
})
it('TC-006 read-save-read never joins a prewrite read and failed writes release the authority queue',async()=>{
 let release;const gate=new Promise(r=>release=r);const f=fixture({earliestFn:()=>gate})
 expect(typeof f.svc.readLedger).toBe('function')
 const a=f.svc.readLedger('claude')
 const save=f.svc.save('claude',{price:20,billingDay:4,autoRenew:false},'save-fixture',{expectedVersion:0})
 const b=f.svc.readLedger('claude')
 release(null)
 expect((await a).plan.version).toBe(0)
 expect((await save).plan.version).toBe(1)
 expect((await b).plan.version).toBe(1)
 f.store.set.mockRejectedValueOnce(Error('EIO'))
 await expect(f.svc.save('claude',{price:100,billingDay:4,autoRenew:false},'failed',{expectedVersion:1})).rejects.toThrow('EIO')
 expect((await f.svc.readLedger('claude')).plan.price).toBe(20)
 expect((await f.svc.save('claude',{price:100,billingDay:4,autoRenew:false},'retry',{expectedVersion:1})).plan.price).toBe(100)
})
