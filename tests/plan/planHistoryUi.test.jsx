/** History cycle card states, single-cycle price and model price popovers. @module tests/planHistoryUi */
import React from 'react'
import {it,expect,vi,afterEach} from 'vitest'
import {render,screen,fireEvent,cleanup,waitFor,within} from '@testing-library/react'
import PlanCard from '../../src/pages/plan/components/PlanCard'
import {describePlan} from '../../src/pages/plan/planPresentation'
afterEach(cleanup)
const est=(start,end,extra={})=>({id:`${start}:${end}:e`,start,end,price:100,estimated:true,...extra})
const now={id:'2026-09-13:2026-10-13:0',start:'2026-09-13',end:'2026-10-13',price:100}
const cycles=[est('2026-03-13','2026-04-13'),est('2026-08-13','2026-09-13'),now]
const base=(extra={})=>({planId:'codex',name:'Codex',plan:{price:100,billingDay:13,autoRenew:true,version:3,stopped:false,cycles},cycle:cycles[1],metadata:{type:'pro'},today:'2026-09-19',
 usage:{total:1120,missingCount:0,recordsFrom:null,models:[{name:'GPT-5.6 Sol',key:'gpt-5-6-sol',cost:764,own:false},{name:'GPT-6 Astra',key:'gpt-6-astra',cost:356,own:false}]},
 onSave:vi.fn(async()=>({success:true})),onNavigate:vi.fn(),onAction:vi.fn(),onSaveCyclePrice:vi.fn(async()=>({success:true})),onRefreshPrice:vi.fn(async()=>({success:true,found:true})),onSaveLocalPrice:vi.fn(async()=>({success:true})),onClearLocalPrice:vi.fn(async()=>({success:true})),...extra})
const card=extra=>{const p=base(extra);render(<div className="plan-page"><PlanCard {...p}/></div>);return p}
const missing=(extra={})=>({usage:{total:38,missingCount:1,recordsFrom:null,models:[{name:'GPT-5.6 Sol',key:'gpt-5-6-sol',cost:38,own:false},{name:'gpt-5.6-nova',key:'gpt-5-6-nova',cost:null,own:false}]},...extra})

it('TC-013 ended estimated cycle shows 已结束, 推算 and end-of-range hints',()=>{
 const p=card();const h=screen.getByTestId('plan-card-header');expect(within(h).getByText('已结束')).toBeVisible();expect(screen.getByText('推算')).toBeVisible()
 cleanup();const q=card({cycle:cycles[0]});expect(screen.getByTitle('已是最早一期')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'上一周期'}));expect(q.onNavigate).not.toHaveBeenCalled()
 cleanup();card({cycle:now,usage:{...base().usage}});expect(screen.getByTitle('已是本期')).toBeInTheDocument();expect(screen.queryByText('推算')).toBeNull();expect(screen.queryByText('已结束')).toBeNull()
 expect(p.onNavigate).not.toHaveBeenCalled()
})
it('TC-014 subtitle priority and incomplete numbers are never red',()=>{
 const d=(usage,extra={})=>describePlan({plan:base().plan,cycle:cycles[0],usage,today:'2026-09-19',...extra})
 expect(d({total:40,models:[],recordsFrom:'2026-03-23',missingCount:0})).toMatchObject({subtitle:'记录从 03.23 起',bad:false})
 expect(d({total:40,models:[],recordsFrom:null,missingCount:1})).toMatchObject({subtitle:'1 个模型缺价格，未计入',bad:false})
 expect(d({total:40,models:[],recordsFrom:'2026-03-23',missingCount:2})).toMatchObject({subtitle:'记录从 03.23 起',bad:false})
 expect(d({total:40,models:[],recordsFrom:null,missingCount:0})).toMatchObject({subtitle:'还差 $60 回本',bad:true})
 expect(describePlan({plan:{...base().plan,stopped:true},cycle:now,usage:{total:40,models:[],recordsFrom:'2026-09-15',missingCount:0},today:'2026-10-20'}).subtitle).toBe('已停 · 最后一期结果')
})
it('TC-015 history price opens the single-cycle popover; current price keeps full settings',async()=>{
 const p=card();fireEvent.click(screen.getByRole('button',{name:'Codex 订阅设置'}))
 expect(screen.getByText('08.13 – 09.13 这一期')).toBeVisible();expect(screen.getAllByRole('textbox')).toHaveLength(1);expect(screen.queryByLabelText('账单日')).toBeNull()
 const input=screen.getByLabelText('订阅费');fireEvent.change(input,{target:{value:'0'}});fireEvent.keyDown(input,{key:'Enter'});expect(screen.getByText('订阅费要大于 0。')).toBeVisible();expect(input).toHaveAttribute('aria-invalid','true');expect(p.onSaveCyclePrice).not.toHaveBeenCalled()
 fireEvent.change(input,{target:{value:'200'}});fireEvent.keyDown(input,{key:'Enter'});await waitFor(()=>expect(p.onSaveCyclePrice).toHaveBeenCalledWith(cycles[1].id,200));await waitFor(()=>expect(screen.queryByText('08.13 – 09.13 这一期')).toBeNull())
 cleanup();const fail=card({onSaveCyclePrice:vi.fn(async()=>({success:false}))});fireEvent.click(screen.getByRole('button',{name:'Codex 订阅设置'}));fireEvent.change(screen.getByLabelText('订阅费'),{target:{value:'150'}});fireEvent.keyDown(screen.getByLabelText('订阅费'),{key:'Enter'});await waitFor(()=>expect(fail.onSaveCyclePrice).toHaveBeenCalled());expect(screen.getByLabelText('订阅费')).toHaveValue('150')
 fireEvent.keyDown(screen.getByLabelText('订阅费'),{key:'Escape'});expect(screen.queryByText('08.13 – 09.13 这一期')).toBeNull()
 cleanup();card({cycle:now});fireEvent.click(screen.getByRole('button',{name:'Codex 订阅设置'}));expect(screen.getByText('Codex 订阅')).toBeVisible();expect(screen.getByLabelText('账单日')).toBeVisible()
})
it('TC-016 missing price row: refresh outcomes, local fill, validation and own-price clear',async()=>{
 const p=card(missing());expect(screen.getByText('1 个模型缺价格，未计入')).toBeVisible()
 fireEvent.click(screen.getByRole('button',{name:'gpt-5.6-nova 价格'}));expect(screen.getByText('gpt-5.6-nova 还没有价格')).toBeVisible()
 fireEvent.click(screen.getByRole('button',{name:'从云端刷新'}));await waitFor(()=>expect(p.onRefreshPrice).toHaveBeenCalledWith('gpt-5-6-nova'));await waitFor(()=>expect(screen.queryByText('gpt-5.6-nova 还没有价格')).toBeNull())
 cleanup();const none=card(missing({onRefreshPrice:vi.fn(async()=>({success:true,found:false}))}));fireEvent.click(screen.getByRole('button',{name:'gpt-5.6-nova 价格'}));fireEvent.click(screen.getByRole('button',{name:'从云端刷新'}));expect(await screen.findByText('云端也还没有这个模型的价格，可以先自己填。')).toBeVisible()
 const fill=(v={输入:'1.25',输出:'10',缓存读:'0.125',缓存写:'1.5'})=>{for(const [k,val] of Object.entries(v))fireEvent.change(screen.getByLabelText(k),{target:{value:val}})}
 fill({输入:'1.25',输出:'',缓存读:'0.125',缓存写:'1.5'});fireEvent.keyDown(screen.getByLabelText('缓存写'),{key:'Enter'});expect(screen.getByText('四个价都要填，不能是负数。')).toBeVisible();expect(none.onSaveLocalPrice).not.toHaveBeenCalled()
 fill();fireEvent.keyDown(screen.getByLabelText('缓存写'),{key:'Enter'});await waitFor(()=>expect(none.onSaveLocalPrice).toHaveBeenCalledWith('gpt-5-6-nova',{input:1.25,output:10,cacheRead:0.125,cacheWrite:1.5}))
 cleanup();card(missing({onRefreshPrice:vi.fn(async()=>({success:false}))}));fireEvent.click(screen.getByRole('button',{name:'gpt-5.6-nova 价格'}));fireEvent.click(screen.getByRole('button',{name:'从云端刷新'}));expect(await screen.findByText('刷新失败，检查网络后再试。')).toBeVisible()
 cleanup();const own=card({usage:{total:60,missingCount:0,recordsFrom:null,models:[{name:'gpt-5.6-nova',key:'gpt-5-6-nova',cost:22,own:true,prices:{input:1.25,output:10,cacheRead:0.125,cacheWrite:1.5}}]}})
 expect(screen.getByText('自填')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'gpt-5.6-nova 价格'}));expect(screen.getByText('gpt-5.6-nova 的价格')).toBeVisible();expect(screen.getByLabelText('输入')).toHaveValue('1.25');expect(screen.queryByRole('button',{name:'从云端刷新'})).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'清除自填，改用云端价格'}));await waitFor(()=>expect(own.onClearLocalPrice).toHaveBeenCalledWith('gpt-5-6-nova'))
})
it('TC-016b missing-price models stay visible instead of folding into 其他 N 个',async()=>{
 const {visibleModels}=await import('../../src/pages/plan/planPresentation')
 const models=[...Array.from({length:7},(_,i)=>({name:'m'+i,key:'m'+i,cost:70-i*10,own:false})),{name:'gpt-x',key:'gpt-x',cost:null,own:false}]
 const rows=visibleModels(models,280);expect(rows.map(r=>r.name)).toEqual(['m0','m1','m2','m3','m4','gpt-x','其他 2 个']);expect(rows.at(-1).cost).toBe(30)
})
it('TC-016c many missing prices still keep the top priced model visible',async()=>{
 const {visibleModels}=await import('../../src/pages/plan/planPresentation')
 const models=[{name:'top',key:'top',cost:90,own:false},{name:'second',key:'second',cost:10,own:false},...Array.from({length:7},(_,i)=>({name:'x'+i,key:'x'+i,cost:null,own:false}))]
 const rows=visibleModels(models,100);expect(rows[0].name).toBe('top');expect(rows).toHaveLength(7);expect(rows.filter(r=>r.cost===null&&!r.other)).toHaveLength(5);expect(rows.at(-1)).toMatchObject({name:'其他 3 个',cost:10,other:true})
})
it('TC-014b ended cycle shortfall subtitle is red like the multiplier; lifecycle phrases never are',()=>{
 card({usage:{total:38,missingCount:0,recordsFrom:null,models:[]}});expect(screen.getByText('还差 $62 回本')).toHaveClass('plan-bad');expect(screen.getByText('0.4×')).toHaveClass('plan-bad')
 cleanup();card({plan:{...base().plan,stopped:true},cycle:now,today:'2026-10-20',usage:{total:38,missingCount:0,recordsFrom:null,models:[]}});expect(screen.getByText('已停 · 最后一期结果')).not.toHaveClass('plan-bad')
})
