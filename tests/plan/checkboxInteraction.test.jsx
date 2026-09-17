/** Subscription checkbox drafts must survive shared refresh and only commit through existing save triggers. */
import React from 'react'
import {it,expect,vi,afterEach} from 'vitest'
import {render,screen,fireEvent,cleanup,waitFor,act} from '@testing-library/react'
import PlanManagementPage from '../../src/pages/PlanManagementPage'
afterEach(()=>{cleanup();delete window.electronAPI})
async function setup(){
 const cycle={id:'2026-09-06:2026-10-06:0',start:'2026-09-06',end:'2026-10-06',price:125}
 let plan={price:125,billingDay:6,autoRenew:false,version:1,stopped:false,cycles:[cycle]},sharedChanged
 const snapshot=()=>({plan:structuredClone(plan),metadata:{type:'Pro'},today:'2026-09-17'})
 window.electronAPI={onUsageStatisticsChanged:fn=>{sharedChanged=fn;return()=>{}},readPlan:vi.fn(async({planId})=>({success:true,data:planId==='claude'?snapshot():{plan:{version:0,cycles:[],stopped:false},metadata:{type:'未知'},today:'2026-09-17'}})),queryPlan:vi.fn(async({cycleId})=>({success:true,data:{version:plan.version,cycleId,total:776,models:[]}})),savePlan:vi.fn(async(payload)=>{const {planId,operationId,expectedVersion,...settings}=payload;plan={...plan,...settings,version:plan.version+1};return {success:true,data:snapshot()}})}
 render(<PlanManagementPage/>);await screen.findByText('6.2×');fireEvent.click(screen.getByRole('button',{name:'Claude Code 订阅设置'}));return {sharedChanged:()=>sharedChanged({revision:2}),saved:()=>plan}
}
it('checkbox stays checked while the open form receives a shared background refresh',async()=>{
 const f=await setup();const box=screen.getByRole('checkbox',{name:'到期自动进下一周期'});fireEvent.click(box);expect(box).toBeChecked();const calls=window.electronAPI.queryPlan.mock.calls.length
 act(()=>f.sharedChanged());await waitFor(()=>expect(window.electronAPI.queryPlan.mock.calls.length).toBeGreaterThan(calls));expect(screen.getByRole('checkbox')).toBeChecked();await waitFor(()=>expect(f.saved().autoRenew).toBe(true));expect(window.electronAPI.savePlan).toHaveBeenCalledTimes(1)
})
it('Enter saves a checked checkbox and reopening retains the saved choice',async()=>{
 const f=await setup();fireEvent.click(screen.getByRole('checkbox'));fireEvent.keyDown(screen.getByRole('checkbox'),{key:'Enter'});await waitFor(()=>expect(f.saved().autoRenew).toBe(true));expect(window.electronAPI.savePlan).toHaveBeenCalledTimes(1)
 fireEvent.pointerDown(document.body);fireEvent.click(screen.getByRole('button',{name:'Claude Code 订阅设置'}));expect(screen.getByRole('checkbox')).toBeChecked()
})
it('checkbox immediately submits and closing cannot discard its saved choice',async()=>{
 const f=await setup();fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByRole('checkbox')).toBeChecked();fireEvent.pointerDown(document.body);fireEvent.click(screen.getByRole('button',{name:'Claude Code 订阅设置'}));await waitFor(()=>expect(screen.getByRole('checkbox')).toBeChecked());expect(f.saved().autoRenew).toBe(true);expect(window.electronAPI.savePlan).toHaveBeenCalledTimes(1)
})

it('a failed checkbox save restores the saved check and uses the existing failure Toast',async()=>{
 await setup();window.electronAPI.savePlan.mockResolvedValue({success:false});fireEvent.click(screen.getByRole('checkbox'));
 await screen.findByText('Claude Code 订阅更新失败');await waitFor(()=>expect(screen.getByRole('checkbox')).not.toBeChecked());expect(screen.getByLabelText('订阅费')).toHaveValue('125')
})
it('checkbox-only save excludes numeric drafts and a pending request prevents duplicate toggles',async()=>{
 const f=await setup();let finish;window.electronAPI.savePlan.mockImplementation(()=>new Promise(r=>finish=r));fireEvent.change(screen.getByLabelText('订阅费'),{target:{value:''}});fireEvent.click(screen.getByRole('checkbox'));
 await waitFor(()=>expect(window.electronAPI.savePlan).toHaveBeenCalledTimes(1));expect(window.electronAPI.savePlan.mock.calls[0][0]).toMatchObject({autoRenew:true});expect(window.electronAPI.savePlan.mock.calls[0][0]).not.toHaveProperty('price');expect(screen.getByRole('checkbox')).toBeDisabled();fireEvent.click(screen.getByRole('checkbox'));expect(window.electronAPI.savePlan).toHaveBeenCalledTimes(1);
 await act(async()=>finish({success:false}));expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByLabelText('订阅费')).toHaveValue('');expect(f.saved().price).toBe(125)
})

it('a checkbox save that finishes after closing updates a newly reopened form',async()=>{
 const f=await setup(),save=window.electronAPI.savePlan.getMockImplementation();let finish;window.electronAPI.savePlan.mockImplementation(payload=>new Promise(r=>finish=()=>save(payload).then(r)));
 fireEvent.click(screen.getByRole('checkbox'));await waitFor(()=>expect(finish).toBeTypeOf('function'));fireEvent.pointerDown(document.body);fireEvent.click(screen.getByRole('button',{name:'Claude Code 订阅设置'}));expect(screen.getByRole('checkbox')).not.toBeChecked();await act(async()=>finish());await waitFor(()=>expect(screen.getByRole('checkbox')).toBeChecked());expect(f.saved().autoRenew).toBe(true)
})
