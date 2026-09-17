/** Navigation is cached; shared revisions drive both consumers. @module tests/sharedUsage/sharedHooks */
import React from 'react'
import {it,expect,vi,beforeEach,afterEach} from 'vitest'
import {renderHook,act,waitFor,cleanup} from '@testing-library/react'
import useCalendar from '../../src/pages/usage/useUsageCalendarData'
import usePlan from '../../src/pages/plan/usePlanData'
let changed
const calendarData=(month='2026-09',total=10)=>({month,today:'2026-09-17',earliestDate:'2026-08-01',days:{[month+'-16']:{status:'ready',total,models:{}}},total,complete:true,failedDays:0})
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-17T04:00Z'));changed=null;window.electronAPI={aggregateUsageCalendar:vi.fn(async p=>({success:true,data:calendarData(p.month)})),onUsageCalendarProgress:()=>()=>{},onUsageStatisticsChanged:fn=>{changed=fn;return()=>{}},readPlan:vi.fn(async({planId})=>({success:true,data:{plan:{version:1,cycles:planId==='claude'?[{id:'current',start:'2026-09-06',end:'2026-10-06',price:20}]:[],stopped:false},metadata:{type:'Pro'},today:'2026-09-17'}})),queryPlan:vi.fn(async({cycleId})=>({success:true,data:{version:1,cycleId,total:40,models:[]}}))}})
afterEach(()=>{cleanup();vi.useRealTimers()})
it('S10 calendar return preserves historical month/date and does not query again without a new batch',async()=>{
  const {result,rerender}=renderHook(({active})=>useCalendar(active),{initialProps:{active:true}})
  await waitFor(()=>expect(result.current.loading).toBe(false))
  act(()=>result.current.setMonth('2026-08'));await waitFor(()=>expect(result.current.data?.month).toBe('2026-08'));act(()=>result.current.setSelected('2026-08-16'))
  const count=window.electronAPI.aggregateUsageCalendar.mock.calls.length
  rerender({active:false});rerender({active:true});await act(async()=>{})
  expect(result.current.month).toBe('2026-08');expect(result.current.selected).toBe('2026-08-16');expect(window.electronAPI.aggregateUsageCalendar).toHaveBeenCalledTimes(count)
})
it('S10 calendar focus has no effect; a shared batch replaces data without blanking old values',async()=>{
  const {result}=renderHook(()=>useCalendar(true));await waitFor(()=>expect(result.current.data?.total).toBe(10))
  act(()=>window.dispatchEvent(new Event('focus')));expect(window.electronAPI.aggregateUsageCalendar).toHaveBeenCalledTimes(1)
  let finish;window.electronAPI.aggregateUsageCalendar=vi.fn(()=>new Promise(resolve=>{finish=resolve}))
  act(()=>changed({revision:2}));expect(result.current.loading).toBe(false);expect(result.current.data.total).toBe(10)
  await act(async()=>finish({success:true,data:calendarData('2026-09',20)}));expect(result.current.data.total).toBe(20)
})
it('S10 Plan removes focus scans and refreshes only from shared revisions, preserving old result',async()=>{
  const {result}=renderHook(()=>usePlan(()=>{}));await waitFor(()=>expect(result.current.cards[0].usage?.total).toBe(40))
  act(()=>window.dispatchEvent(new Event('focus')));await act(async()=>{});expect(window.electronAPI.readPlan).toHaveBeenCalledTimes(2)
  let finish;window.electronAPI.queryPlan=vi.fn(()=>new Promise(resolve=>{finish=resolve}))
  await act(async()=>{changed({revision:2});await Promise.resolve();await Promise.resolve()})
  expect(result.current.cards[0].loading).toBe(false);expect(result.current.cards[0].usage.total).toBe(40)
  await act(async()=>finish({success:true,data:{version:1,cycleId:'current',total:50,models:[]}}));expect(result.current.cards[0].usage.total).toBe(50)
})
it('S08 unobserved new cycle stays loading instead of pretending it has zero usage',async()=>{
  window.electronAPI.queryPlan=vi.fn(async({cycleId})=>({success:true,data:{version:1,cycleId,pending:true,total:null,models:[]}}))
  const {result}=renderHook(()=>usePlan(()=>{}));await waitFor(()=>expect(window.electronAPI.queryPlan).toHaveBeenCalledTimes(1));await act(async()=>{})
  expect(result.current.cards[0].loading).toBe(true);expect(result.current.cards[0].usage).toBeNull()
})
