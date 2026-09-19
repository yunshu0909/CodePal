/* @vitest-environment node */
/** New Plan history / price IPC boundaries. @module tests/planHistoryIpc */
import {it,expect,vi} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {registerPlanHandlers,isReservedPlanKey}=require('../../electron/ipc/registerPlanHandlers')
const setup=()=>{const handlers={};const service={read:vi.fn(),save:vi.fn(),act:vi.fn(),query:vi.fn(),setCyclePrice:vi.fn(async()=>({plan:{version:4}})),refreshPrice:vi.fn(async()=>({found:true})),setLocalPrice:vi.fn(async()=>({})),clearLocalPrice:vi.fn(async()=>({}))};registerPlanHandlers({ipcMain:{handle:(name,fn)=>{handlers[name]=fn}},service});return{call:(name,p)=>handlers[name](null,p),service}}
const prices={input:1,output:2,cacheRead:0,cacheWrite:0.5}

it('TC-017 new channels validate input strictly and map failures to stable codes',async()=>{
 const {call,service}=setup()
 expect(await call('plan-cycle-price',{planId:'codex',cycleId:'2026-08-13:2026-09-13:e',price:200,operationId:'op',expectedVersion:3})).toEqual({success:true,data:{plan:{version:4}}})
 expect(service.setCyclePrice).toHaveBeenCalledWith('codex','2026-08-13:2026-09-13:e',200,'op',{expectedVersion:3})
 for(const bad of [{planId:'codex',cycleId:'x',price:0,operationId:'op'},{planId:'dsh',cycleId:'x',price:1,operationId:'op'},{planId:'codex',cycleId:'',price:1,operationId:'op'},{planId:'codex',cycleId:'x',price:1,operationId:'op',extra:1}])expect(await call('plan-cycle-price',bad)).toEqual({success:false,error:'INVALID_INPUT'})
 service.setCyclePrice.mockRejectedValueOnce(Error('PLAN_CONFLICT'));expect((await call('plan-cycle-price',{planId:'codex',cycleId:'x',price:1,operationId:'op2'})).error).toBe('PLAN_CONFLICT')
 service.setCyclePrice.mockRejectedValueOnce(Error('EIO'));expect((await call('plan-cycle-price',{planId:'codex',cycleId:'x',price:1,operationId:'op3'})).error).toBe('PLAN_CYCLE_PRICE_FAILED')
 expect(await call('plan-price-refresh',{model:'gpt-5-6-nova'})).toEqual({success:true,data:{found:true}})
 service.refreshPrice.mockRejectedValueOnce(Error('offline'));expect(await call('plan-price-refresh',{model:'gpt-5-6-nova'})).toEqual({success:false,error:'PLAN_PRICE_REFRESH_FAILED'})
 expect((await call('plan-price-set-local',{model:'gpt-5-6-nova',...prices})).success).toBe(true);expect(service.setLocalPrice).toHaveBeenCalledWith('gpt-5-6-nova',prices)
 for(const bad of [{model:'',...prices},{model:'m',...prices,input:-1},{model:'m',...prices,output:NaN},{model:'m',input:1,output:1,cacheRead:1},{model:'x'.repeat(201),...prices}])expect(await call('plan-price-set-local',bad)).toEqual({success:false,error:'INVALID_INPUT'})
 service.setLocalPrice.mockRejectedValueOnce(Error('EIO'));expect((await call('plan-price-set-local',{model:'m',...prices})).error).toBe('PLAN_PRICE_SAVE_FAILED')
 expect((await call('plan-price-clear-local',{model:'gpt-5-6-nova'})).success).toBe(true);expect(await call('plan-price-clear-local',{model:''})).toEqual({success:false,error:'INVALID_INPUT'})
 expect(isReservedPlanKey('planPriceOverridesV1')).toBe(true);expect(isReservedPlanKey('planPriceOverridesV1.gpt-7')).toBe(true)
})
