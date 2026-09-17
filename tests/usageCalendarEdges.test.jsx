/** Keep-alive, midnight and persistence failures under deterministic IPC. @module tests/usageCalendarEdges */
import React from 'react'
import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest'
import {render,screen,fireEvent,waitFor,cleanup,renderHook,act} from '@testing-library/react'
import UsageMonitorPage from '../src/pages/UsageMonitorPage'
import useUsageCalendarData from '../src/pages/usage/useUsageCalendarData'
import {getBeijingDayKey} from '../src/pages/usage/calendarUtils'
const result=month=>({success:true,data:{month,today:getBeijingDayKey(),earliestDate:'2026-08-16',days:{[`${month}-16`]:{status:'ready',total:120e6,models:{a:{total:120e6}}}},total:120e6,complete:true,failedDays:0}})
// Pin only Date so real async timers still run and the day-16 fixture stays internally consistent.
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-16T04:00:00Z'));window.electronAPI={getStore:async key=>key==='usageGoal'?{value:300,unit:'M'}:false,setStore:vi.fn(async()=>true),deleteStore:async()=>true,aggregateUsageCalendar:vi.fn(async p=>result(p.month)),onUsageCalendarProgress:()=>()=>{}}})
afterEach(()=>{cleanup();vi.useRealTimers()})
describe('calendar edge interactions',()=>{
 it('returning from historical month keeps the selected month and cached query',async()=>{
  const {rerender}=render(<UsageMonitorPage isActive />)
  fireEvent.click(await screen.findByRole('button',{name:'上个月'}))
  await screen.findByRole('button',{name:'2026-08-16'})
  rerender(<UsageMonitorPage isActive={false}/>);rerender(<UsageMonitorPage isActive />)
  await screen.findByRole('button',{name:'2026-08-16'})
  expect(window.electronAPI.aggregateUsageCalendar.mock.calls.at(-1)[0].month).toBe('2026-08')
 })
 it('late month response and progress cannot overwrite the new month',async()=>{
  let finishAugust,sendProgress
  window.electronAPI.onUsageCalendarProgress=cb=>{sendProgress=cb;return()=>{}}
  window.electronAPI.aggregateUsageCalendar=vi.fn(p=>p.month==='2026-08'?new Promise(resolve=>{finishAugust=()=>resolve(result('2026-08'))}):Promise.resolve(result(p.month)))
  render(<UsageMonitorPage isActive />)
  fireEvent.click(await screen.findByRole('button',{name:'上个月'}))
  await waitFor(()=>expect(finishAugust).toBeTypeOf('function'))
  const oldTask=window.electronAPI.aggregateUsageCalendar.mock.calls.at(-1)[0].taskId
  fireEvent.click(screen.getByRole('button',{name:'下个月'}))
  await screen.findByRole('button',{name:'2026-09-16'})
  await act(async()=>{sendProgress({taskId:oldTask,processedDays:1,totalDays:1,data:result('2026-08').data});finishAugust()})
  expect(screen.queryByRole('button',{name:'2026-08-16'})).not.toBeInTheDocument()
  expect(screen.getByTestId('day-detail')).toHaveTextContent('09-16')
 })
 it('failed persistence keeps the old target and never reports success',async()=>{
  window.electronAPI.setStore=vi.fn(async()=>false)
  render(<UsageMonitorPage isActive />)
  fireEvent.click(await screen.findByRole('button',{name:'编辑日目标'}))
  const input=screen.getByRole('textbox',{name:'每日目标'})
  fireEvent.change(input,{target:{value:'400M'}});fireEvent.keyDown(input,{key:'Enter'})
  await screen.findByText('保存失败，请重试')
  expect(screen.queryByText('目标已更新为 400M / 天')).not.toBeInTheDocument()
  expect(screen.getByRole('button',{name:'编辑日目标'})).toHaveTextContent('9.0B')
 })
 it('shared Beijing month-boundary event updates today without changing viewed month',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-30T15:59:00Z'))
  let changed;window.electronAPI.onUsageStatisticsChanged=fn=>{changed=fn;return()=>{}}
  const {result:hook}=renderHook(()=>useUsageCalendarData(true))
  await act(async()=>{await Promise.resolve();await Promise.resolve()})
  expect(hook.current.month).toBe('2026-09')
  await act(async()=>{vi.setSystemTime(new Date('2026-09-30T16:01:00Z'));changed({revision:2,today:'2026-10-01'});await Promise.resolve();await Promise.resolve()})
  expect(hook.current.today).toBe('2026-10-01')
  expect(hook.current.month).toBe('2026-09')
  expect(window.electronAPI.aggregateUsageCalendar.mock.calls.at(-1)[0].month).toBe('2026-09')
  expect(window.electronAPI.aggregateUsageCalendar).toHaveBeenCalledTimes(2)
 })
})
