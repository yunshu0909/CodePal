/** Atomic ledger writes and draft cancellation order. @module tests/planStore */
import React from 'react'
import {it,expect,vi,afterEach} from 'vitest'
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react'
import {createRequire} from 'node:module'
import PlanSettingsPopover from '../../src/pages/plan/components/PlanSettingsPopover'
const require=createRequire(import.meta.url)
const {createPlanStoreService}=require('../../electron/services/plan/planStoreService')
afterEach(cleanup)
const cycle=(start='2026-08-20',end='2026-09-20',price=20)=>({id:start,start,end,price})
const existing=(extra={})=>({price:20,billingDay:20,autoRenew:false,stopped:false,version:1,cycles:[cycle()],...extra})
const draft={price:20,billingDay:20,autoRenew:false}
const fixture=(p=null,writer=null)=>{const data={planLedgerV1:{schemaVersion:1,plans:{claude:p||{cycles:[],version:0,stopped:false},codex:{cycles:[],version:0,stopped:false}}}};const store={get:k=>structuredClone(data[k]),set:vi.fn(async(k,v)=>{if(writer)await writer();data[k]=structuredClone(v)})};const svc=createPlanStoreService({store,nowFn:()=>new Date('2026-09-17T04:00:00Z')});return{svc,store,data}}
const pop=(extra={})=>{const onSave=vi.fn(async()=>({success:true}));const onClose=vi.fn();render(React.createElement(PlanSettingsPopover,{planId:'claude',name:'Claude Code',plan:{cycles:[],version:0},metadata:{type:'未知',suggestedPrice:null,suggestedBillingDay:null},today:'2026-09-17',onSave,onClose,...extra}));return{onSave:extra.onSave||onSave,onClose:extra.onClose||onClose}}
const fill=()=>{fireEvent.change(screen.getByLabelText('订阅费'),{target:{value:'20'}});fireEvent.change(screen.getByLabelText('账单日'),{target:{value:'20'}})}
it('TC-015 Enter submits one complete legal draft',async()=>{const p=pop();fill();fireEvent.keyDown(screen.getByLabelText('账单日'),{key:'Enter'});await waitFor(()=>expect(p.onSave).toHaveBeenCalledTimes(1));expect(p.onSave.mock.calls[0][0]).toMatchObject(draft)})
it('TC-016 no saved cycle does not create ledger on read or scan',async()=>{const f=fixture();expect((await f.svc.read('claude')).plan.cycles).toEqual([]);expect(f.store.set).not.toHaveBeenCalled()})
it('TC-017 current price change leaves ended snapshots intact',async()=>{const p=existing({cycles:[cycle('2026-07-20','2026-08-20'),cycle()]});const f=fixture(p);const r=await f.svc.save('claude',{...draft,price:100},'price-op');expect(r.plan.cycles.map(x=>x.price)).toEqual([20,100]);expect(p.cycles.map(x=>x.price)).toEqual([20,20])})
it('TC-022 illegal drafts do not write or toast, Enter marks all invalid fields',async()=>{
 const f=fixture();for(const bad of [{...draft,price:0},{...draft,price:NaN},{...draft,billingDay:32},{...draft,billingDay:1.5}])await expect(f.svc.save('claude',bad,'invalid-'+String(bad.price)+'-'+String(bad.billingDay))).rejects.toThrow();expect(f.store.set).not.toHaveBeenCalled();const p=pop();fireEvent.keyDown(screen.getByLabelText('订阅费'),{key:'Enter'});expect(screen.getByLabelText('订阅费')).toHaveAttribute('aria-invalid','true');expect(screen.getByLabelText('账单日')).toHaveAttribute('aria-invalid','true');expect(p.onSave).not.toHaveBeenCalled()
})
it('TC-038 first failed atomic write publishes no cycle',async()=>{const f=fixture(null,async()=>{throw Error('EIO')});await expect(f.svc.save('claude',draft,'fail-first')).rejects.toThrow();expect((await f.svc.read('claude')).plan.cycles).toEqual([])})
it('TC-039 outside pointerdown cancels before following blur',()=>{const p=pop();fill();fireEvent.pointerDown(document.body);fireEvent.blur(screen.getByLabelText('账单日'));expect(p.onSave).not.toHaveBeenCalled();expect(p.onClose).toHaveBeenCalledTimes(1)})
it('TC-040 Esc after blur cannot revoke already submitted save',async()=>{let finish;const onSave=vi.fn(()=>new Promise(r=>finish=r));const p=pop({onSave});fill();fireEvent.blur(screen.getByLabelText('订阅费'),{relatedTarget:screen.getByLabelText('账单日')});fireEvent.change(screen.getByLabelText('订阅费'),{target:{value:'100'}});fireEvent.keyDown(screen.getByLabelText('订阅费'),{key:'Escape'});expect(onSave).toHaveBeenCalledTimes(1);expect(onSave.mock.calls[0][0].price).toBe(20);finish({success:true});await waitFor(()=>expect(p.onClose).toHaveBeenCalledTimes(1))})
it('TC-041 repeated Enter then blur is idempotent in UI and main queue',async()=>{
 const p=pop();fill();const day=screen.getByLabelText('账单日');fireEvent.keyDown(day,{key:'Enter'});fireEvent.keyDown(day,{key:'Enter'});fireEvent.blur(day,{relatedTarget:screen.getByLabelText('订阅费')});await waitFor(()=>expect(p.onSave).toHaveBeenCalledTimes(1));const f=fixture();const [a,b]=await Promise.all([f.svc.save('claude',draft,'same'),f.svc.save('claude',draft,'same')]);expect(a.plan.cycles).toEqual(b.plan.cycles);expect(f.store.set).toHaveBeenCalledTimes(1)
})
it('TC-042 revised: checkbox submits immediately and outside close does not revoke it',async()=>{const p=pop({plan:existing({autoRenew:true})});fireEvent.click(screen.getByLabelText('到期自动进下一周期'));fireEvent.pointerDown(document.body);expect(p.onSave).toHaveBeenCalledTimes(1);expect(p.onSave.mock.calls[0][0]).toEqual({autoRenew:false});await waitFor(()=>expect(screen.getByRole('checkbox')).not.toBeDisabled());expect(p.onClose).toHaveBeenCalledTimes(1)})
it('TC-053 ended settings preserve snapshots and new backfill uses new saved config',async()=>{
 const old=existing({cycles:[cycle('2026-05-20','2026-06-20')]});const f=fixture(old);const r=await f.svc.save('claude',{price:100,billingDay:20,autoRenew:true},'backfill-price');expect(r.plan.cycles.map(x=>x.price)).toEqual([20,100,100,100]);expect(r.plan.cycles[0]).toEqual(old.cycles[0]);
 const stopped=fixture(existing({stopped:true,cycles:[cycle('2026-07-20','2026-08-20')]}));const s=await stopped.svc.save('claude',{price:100,billingDay:25,autoRenew:true},'stopped-save');expect(s.plan.cycles).toHaveLength(1);expect(s.plan.cycles[0].price).toBe(20)
})
it('TC-065 internal blur marks touched price only and Enter validates full form',()=>{const p=pop();fireEvent.change(screen.getByLabelText('订阅费'),{target:{value:'20'}});fireEvent.blur(screen.getByLabelText('订阅费'),{relatedTarget:screen.getByLabelText('账单日')});expect(screen.getByLabelText('账单日')).not.toHaveAttribute('aria-invalid','true');expect(p.onSave).not.toHaveBeenCalled();fireEvent.keyDown(screen.getByLabelText('账单日'),{key:'Enter'});expect(screen.getByLabelText('账单日')).toHaveAttribute('aria-invalid','true')})
it('TC-076 failed write retains editable draft and main queue recovers',async()=>{const p=pop({plan:existing(),onSave:vi.fn(async()=>({success:false}))});fireEvent.change(screen.getByLabelText('订阅费'),{target:{value:'100'}});fireEvent.keyDown(screen.getByLabelText('订阅费'),{key:'Enter'});await waitFor(()=>expect(p.onSave).toHaveBeenCalledTimes(1));expect(screen.getByLabelText('订阅费')).toHaveValue('100');let first=true;const f=fixture(existing(),async()=>{if(first){first=false;throw Error('EIO')}});await expect(f.svc.save('claude',{...draft,price:100},'failure')).rejects.toThrow();expect((await f.svc.read('claude')).plan.price).toBe(20);expect((await f.svc.save('claude',{...draft,price:100},'retry')).plan.price).toBe(100)})
it('TC-050 atomic restart failure keeps billing anchor, stopped and ledger unchanged',async()=>{const p=existing({stopped:true,cycles:[cycle('2026-07-20','2026-08-20')]});const f=fixture(p,async()=>{throw Error('EIO')});await expect(f.svc.act('claude','restart','fail-restart')).rejects.toThrow();expect((await f.svc.read('claude')).plan).toEqual(p)})
it('TC-051 two restart operationIds cannot append two periods while concurrently queued',async()=>{const f=fixture(existing({stopped:true,cycles:[cycle('2026-07-20','2026-08-20')]}));await Promise.all([f.svc.act('claude','restart','same-restart'),f.svc.act('claude','restart','same-restart')]);expect((await f.svc.read('claude')).plan.cycles).toHaveLength(2);expect(f.store.set).toHaveBeenCalledTimes(1)})
it('global main commit queue preserves concurrent writes to both cards',async()=>{const f=fixture();await Promise.all([f.svc.save('claude',draft,'cl'),f.svc.save('codex',{price:100,billingDay:29,autoRenew:true},'cx')]);expect((await f.svc.read('claude')).plan.price).toBe(20);expect((await f.svc.read('codex')).plan.price).toBe(100)})

it('checkbox-only atomic save before setup persists preference without price, billing date or cycle',async()=>{
 const f=fixture();const r=await f.svc.save('claude',{autoRenew:true},'flag-only',{expectedVersion:0});expect(r.plan.autoRenew).toBe(true);expect(r.plan.cycles).toEqual([]);expect(r.plan).not.toHaveProperty('price');expect(r.plan).not.toHaveProperty('billingDay');expect(r.plan.version).toBe(1);
 expect((await f.svc.read('claude')).plan.cycles).toEqual([]);await f.svc.save('claude',draft,'first-period',{expectedVersion:1});expect((await f.svc.read('claude')).plan.cycles).toHaveLength(1)
})
it('checkbox-only save preserves saved amounts and history, and a failure is atomic',async()=>{
 const p=existing({stopped:true});const f=fixture(p);const saved=await f.svc.save('claude',{autoRenew:true},'only-flag',{expectedVersion:1});expect(saved.plan).toEqual({...p,autoRenew:true,version:2});
 const broken=fixture(p,async()=>{throw Error('EIO')});await expect(broken.svc.save('claude',{autoRenew:true},'fail-flag')).rejects.toThrow();expect((await broken.svc.read('claude')).plan).toEqual(p)
})

it('synchronous checkbox save failure restores the flag and allows a subsequent retry',async()=>{
 const onSave=vi.fn(()=>{throw Error('save')});pop({plan:existing(),onSave});fireEvent.click(screen.getByRole('checkbox'));await waitFor(()=>expect(screen.getByRole('checkbox')).not.toBeDisabled());expect(screen.getByRole('checkbox')).not.toBeChecked();onSave.mockResolvedValue({success:true});fireEvent.click(screen.getByRole('checkbox'));await waitFor(()=>expect(screen.getByRole('checkbox')).not.toBeDisabled());expect(screen.getByRole('checkbox')).toBeChecked();expect(onSave).toHaveBeenCalledTimes(2)
})
