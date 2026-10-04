/** Only shared-statistics refreshes omit membership; first and mutation reads stay complete. */
import {it,expect,vi,afterEach} from 'vitest'
import {renderHook,act,waitFor,cleanup} from '@testing-library/react'
import usePlan from '../../src/pages/plan/usePlanData'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {registerPlanHandlers}=require('../../electron/ipc/registerPlanHandlers')
afterEach(cleanup)
const snapshot={plan:{version:1,stopped:false,cycles:[{id:'fixture-cycle',start:'2026-10-04',end:'2026-11-04',price:20}]},today:'2026-10-04'}
it('TC-007 statistics use ledger-only reads but keep metadata and version-cycle guards',async()=>{
 let changed
 window.electronAPI={readPlan:vi.fn(async p=>({success:true,data:{...snapshot,...(p.includeMetadata===false?{}:{metadata:{type:'Pro',suggestedPrice:20}})}})),queryPlan:vi.fn(async p=>({success:true,data:{version:1,cycleId:p.cycleId,total:40,models:[]}})),onUsageStatisticsChanged:fn=>{changed=fn;return()=>{}}}
 const {result}=renderHook(()=>usePlan(()=>{}))
 await waitFor(()=>expect(result.current.cards[0].usage?.total).toBe(40))
 expect(result.current.cards[0].metadata.type).toBe('Pro')
 window.electronAPI.readPlan.mockClear()
 await act(async()=>{changed({revision:2})})
 await waitFor(()=>expect(window.electronAPI.readPlan).toHaveBeenCalledTimes(2))
 expect(window.electronAPI.readPlan.mock.calls.map(([p])=>p.includeMetadata)).toEqual([false,false])
 expect(result.current.cards[0].metadata.type).toBe('Pro')
})
it('TC-007 IPC accepts only boolean metadata flag and selects the authoritative read',async()=>{
 const handlers=new Map();const service={read:vi.fn(async()=>({metadata:{type:'Pro'}})),readLedger:vi.fn(async()=>snapshot)}
 registerPlanHandlers({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},service})
 const read=handlers.get('plan-read')
 const light=await read(null,{planId:'claude',includeMetadata:false})
 expect(light.success).toBe(true);expect(service.readLedger).toHaveBeenCalledWith('claude');expect(service.read).not.toHaveBeenCalled()
 expect((await read(null,{planId:'claude',includeMetadata:'false'})).success).toBe(false)
 expect((await read(null,{planId:'claude'})).success).toBe(true)
 expect(service.read).toHaveBeenCalledWith('claude')
})
it('TC-007 a statistics event before first read completes must still retrieve metadata',async()=>{
 let changed,firstResolve;let calls=0
 window.electronAPI={readPlan:vi.fn(p=>{calls++;if(calls===1)return new Promise(r=>firstResolve=r);return Promise.resolve({success:true,data:{...snapshot,...(p.includeMetadata===false?{}:{metadata:{type:'Pro'}})}})}),queryPlan:vi.fn(async p=>({success:true,data:{version:1,cycleId:p.cycleId,total:40,models:[]}})),onUsageStatisticsChanged:fn=>{changed=fn;return()=>{}}}
 const {result}=renderHook(()=>usePlan(()=>{}))
 await act(async()=>{changed({revision:2})})
 await waitFor(()=>expect(result.current.cards[0].metadata.type).toBe('Pro'))
 const cl=window.electronAPI.readPlan.mock.calls.filter(([p])=>p.planId==='claude')
 expect(cl.every(([p])=>p.includeMetadata!==false)).toBe(true)
 await act(async()=>firstResolve({success:true,data:{...snapshot,metadata:{type:'obsolete'}}}))
 expect(result.current.cards[0].metadata.type).toBe('Pro')
})
