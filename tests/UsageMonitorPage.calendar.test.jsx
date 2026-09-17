/** Usage page interactions with deterministic daily IPC. @module tests/UsageMonitorPageCalendar */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import UsageMonitorPage from '../src/pages/UsageMonitorPage'
const fixture=()=>({month:'2026-09',today:'2026-09-16',earliestDate:'2026-08-16',days:{'2026-09-15':{status:'ready',total:150e6,models:{a:{total:100e6},b:{total:50e6}}},'2026-09-16':{status:'ready',total:120e6,models:{a:{total:120e6}}}},total:270e6,complete:true,failedDays:0})
beforeEach(()=>{window.electronAPI={getStore:vi.fn(async key=>key==='usageGoal'?{value:300,unit:'M'}:false),setStore:vi.fn(async()=>({success:true})),deleteStore:vi.fn(async()=>({success:true})),aggregateUsageCalendar:vi.fn(async()=>({success:true,data:fixture()})),onUsageCalendarProgress:vi.fn(()=>()=>{})}})
afterEach(cleanup)
describe('usage calendar page',()=>{
 it('TC001/006/023: shows calendar/detail and selects a day without fetching again',async()=>{
  render(<UsageMonitorPage isActive />)
  await screen.findByRole('button',{name:'2026-09-15'})
  fireEvent.click(screen.getByRole('button',{name:'2026-09-15'}))
  expect(screen.getByTestId('day-detail')).toHaveTextContent('150M')
  expect(screen.getByTestId('day-detail')).toHaveTextContent('还差 150M')
  expect(window.electronAPI.aggregateUsageCalendar).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button',{name:'2026-09-17'})).toBeDisabled()
  for(const label of ['预估费用','近30天','分布分析','设定目标'])expect(screen.queryByText(label)).not.toBeInTheDocument()
 })
 it('TC016/017/018: daily goal saves once on Enter+blur and invalid input does not persist',async()=>{
  render(<UsageMonitorPage isActive />)
  fireEvent.click(await screen.findByRole('button',{name:'编辑日目标'}))
  const input=screen.getByRole('textbox',{name:'每日目标'})
  fireEvent.change(input,{target:{value:'abc'}});fireEvent.keyDown(input,{key:'Enter'})
  expect(input).toHaveAttribute('aria-invalid','true');expect(window.electronAPI.setStore).not.toHaveBeenCalled()
  fireEvent.change(input,{target:{value:'0.4B'}});fireEvent.keyDown(input,{key:'Enter'});fireEvent.blur(input)
  await waitFor(()=>expect(window.electronAPI.setStore).toHaveBeenCalledTimes(1))
  expect(window.electronAPI.setStore).toHaveBeenCalledWith('usageGoal',{value:.4,unit:'B'})
  await screen.findByText('目标已更新为 400M / 天')
 })
 it('TC002/027: returning to the keep-alive page reads existing data without scanning',async()=>{
  const {rerender}=render(<UsageMonitorPage isActive />)
  await screen.findByRole('button',{name:'2026-09-15'})
  rerender(<UsageMonitorPage isActive={false}/>);rerender(<UsageMonitorPage isActive />)
  await waitFor(()=>expect(window.electronAPI.aggregateUsageCalendar).toHaveBeenCalledTimes(1))
 })
 it('TC007/014: empty month hides detail/legend; no goal hides rings',async()=>{
  window.electronAPI.getStore=async()=>null
  window.electronAPI.aggregateUsageCalendar=async()=>({success:true,data:{...fixture(),days:{},total:0}})
  render(<UsageMonitorPage isActive />)
  await screen.findByText('本月没有记录')
  expect(screen.queryByTestId('day-detail')).not.toBeInTheDocument()
  expect(screen.queryByTestId('calendar-legend')).not.toBeInTheDocument()
  expect(screen.queryByTestId('day-ring')).not.toBeInTheDocument()
 })
})
