/* @vitest-environment node */
/** Renderer cannot supply credentials, filesystem paths or ledger. @module tests/planHandlers */
import {it,expect,vi} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {registerPlanHandlers}=require('../../electron/ipc/registerPlanHandlers')
it('TC-072 IPC rejects arbitrary plan/action/path/ledger and safe error code',async()=>{
 const callbacks={};const service={read:vi.fn(),save:vi.fn(),act:vi.fn(),query:vi.fn()};registerPlanHandlers({ipcMain:{handle:(name,fn)=>callbacks[name]=fn},service});
 for(const [channel,payload] of [['plan-read',{planId:'dsh'}],['plan-save',{planId:'claude',price:20,billingDay:20,autoRenew:true,operationId:'op',path:'/fake/path'}],['plan-save',{planId:'claude',price:20,billingDay:20,autoRenew:true,operationId:'op',cycles:[]}],['plan-action',{planId:'claude',action:'delete',operationId:'op'}],['plan-query',{planId:'claude',cycleId:'fake',path:'/fake/path'}]])expect(await callbacks[channel]({},payload)).toMatchObject({success:false,error:'INVALID_INPUT'});
 expect(service.save).not.toHaveBeenCalled();service.read.mockRejectedValue(Error('token_redacted'));expect(await callbacks['plan-read']({},{planId:'claude'})).toEqual({success:false,error:'PLAN_READ_FAILED'});
})

it('checkbox-only IPC forwards only the flag and retains operation/version and input validation',async()=>{
 const handlers={},service={save:vi.fn(async()=>({plan:{autoRenew:true}}))};registerPlanHandlers({ipcMain:{handle:(n,f)=>handlers[n]=f},service});
 expect(await handlers['plan-save']({},{planId:'claude',autoRenew:true,operationId:'flag',expectedVersion:1})).toMatchObject({success:true});expect(service.save).toHaveBeenCalledWith('claude',{autoRenew:true},'flag',{expectedVersion:1});
 for(const settings of [{autoRenew:'true'},{autoRenew:true,price:20},{autoRenew:true,billingDay:6},{autoRenew:true,price:undefined}])expect(await handlers['plan-save']({},{planId:'claude',operationId:'bad',...settings})).toMatchObject({success:false,error:'INVALID_INPUT'})
})
