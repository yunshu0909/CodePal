/* @vitest-environment node */
/** Shared source/day cache and consumer equivalence. @module tests/sharedUsage/sharedStatistics */
import {it, expect, vi} from 'vitest'
import {createRequire} from 'node:module'
const require = createRequire(import.meta.url)
const {createSharedUsageStatistics} = require('../../electron/services/sharedUsageStatistics')
const {aggregatePlanCosts} = require('../../electron/services/plan/planUsageService')
const record = (model, input, timestamp='2026-09-17T03:00:00Z') => ({model,input,output:2,cacheRead:3,cacheCreate:4,timestamp:new Date(timestamp),project:'one'})
export function fixture(extra={}) {
  const entries = new Map()
  const storage = {read:vi.fn(async key=>structuredClone(entries.get(key)||null)),write:vi.fn(async(key,value)=>entries.set(key,structuredClone(value))),list:vi.fn(async()=>[...entries.keys()].filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)))}
  let instant = new Date('2026-09-17T04:00:00Z')
  const scanFn=vi.fn(async(id)=>[record(id==='claude'?'claude-opus-5':id==='codex'?'gpt-6-astra':'gpt-6-astra',id==='claude'?10:id==='codex'?20:100)])
  const deps={storage,scanFn,sourceStatusFn:async()=> 'present',earliestFn:async()=> '2026-09-17',legacyReadFn:async()=>null,nowFn:()=>instant,...extra}
  const service=createSharedUsageStatistics(deps)
  return {...deps,service,entries,setNow:value=>{instant=new Date(value)}}
}
it('S01/S02 shared concurrent consumers scan each source once, keeping DSH separate',async()=>{
  const d=fixture()
  const [calendar,plan]=await Promise.all([d.service.getCalendar({month:'2026-09'}),d.service.getPlanTokens('codex',{start:'2026-09-17',end:'2026-10-17'})])
  expect(d.scanFn).toHaveBeenCalledTimes(3)
  expect(calendar.days['2026-09-17'].total).toBe(157)
  expect(plan.records.map(r=>r.input)).toEqual([20])
  expect(plan.records.every(r=>r.source==='codex')).toBe(true)
  await d.service.getCalendar({month:'2026-09'});await d.service.getPlanTokens('claude',{start:'2026-09-17',end:'2026-10-17'})
  expect(d.scanFn).toHaveBeenCalledTimes(3)
})
it('S02 only background tick updates today; navigation never scans existing data',async()=>{
  const d=fixture();await d.service.getCalendar({month:'2026-09'});d.scanFn.mockClear()
  d.setNow('2026-09-17T04:10:00Z')
  await d.service.getCalendar({month:'2026-09'});expect(d.scanFn).not.toHaveBeenCalled()
  await d.service.tick();expect(d.scanFn).toHaveBeenCalledTimes(3)
})
it('S03 closed days persist across instances and only missing dates are reconstructed',async()=>{
  const d=fixture({earliestFn:async()=> '2026-09-15',scanFn:vi.fn(async(id,start)=>[record(id==='claude'?'claude-opus-5':'gpt-6-astra',1,start.toISOString())])})
  await d.service.getCalendar({month:'2026-09'});expect(d.scanFn).toHaveBeenCalledTimes(9);d.scanFn.mockClear()
  const again=createSharedUsageStatistics(d)
  await again.getCalendar({month:'2026-09'});expect(d.scanFn).not.toHaveBeenCalled()
  await again.ensureRange('2026-09-14','2026-09-17');expect(d.scanFn).toHaveBeenCalledTimes(3)
})
it('S05 midnight closes yesterday through 24:00 before starting the live day',async()=>{
  const d=fixture({scanFn:vi.fn(async(id,start,end)=>[record('gpt-6-astra',end.getTime()>=Date.parse('2026-09-17T16:00Z')?99:1,new Date(end.getTime()-1).toISOString())])})
  d.setNow('2026-09-17T15:55Z');await d.service.tick();d.scanFn.mockClear()
  d.setNow('2026-09-17T16:05Z');await d.service.tick()
  expect(d.scanFn).toHaveBeenCalledTimes(6)
  const yesterday=d.entries.get('2026-09-17')
  expect(yesterday.sources.codex.complete).toBe(true)
  expect(yesterday.sources.codex.cutoff).toBe('2026-09-17T16:00:00.000Z')
  expect(yesterday.sources.codex.records[0].input).toBe(99)
  d.scanFn.mockClear();await d.service.getPlanTokens('codex',{start:'2026-09-17',end:'2026-09-18'});expect(d.scanFn).not.toHaveBeenCalled()
})
it('S05 pending live dates survive restart after sleep across several days',async()=>{
  const d=fixture();await d.service.tick();d.setNow('2026-09-20T04:00Z');d.scanFn.mockClear()
  const again=createSharedUsageStatistics(d);await again.tick()
  expect(d.entries.get('2026-09-17').sources.codex.complete).toBe(true)
  expect(d.entries.get('2026-09-20').sources.codex.complete).toBe(false)
  expect(d.entries.has('2026-09-18')).toBe(false)
})
it('S06 DSH failure makes calendar day failed but leaves Claude/Codex query valid',async()=>{
  const d=fixture({scanFn:vi.fn(async id=>{if(id==='dsh')throw Error('unreadable');return [record(id==='claude'?'claude-opus-5':'gpt-6-astra',10)]})})
  const c=await d.service.getCalendar({month:'2026-09'});expect(c.days['2026-09-17'].status).toBe('failed');expect(c.complete).toBe(false)
  expect((await d.service.getPlanTokens('codex',{start:'2026-09-17',end:'2026-10-17'})).records).toHaveLength(1)
  expect(d.entries.get('2026-09-17').sources.dsh.status).toBe('failed')
})
it('S06 missing source and successful zero are distinguished without scanner calls for missing',async()=>{
  const d=fixture({sourceStatusFn:async id=>id==='codex'?'missing':'present',scanFn:vi.fn(async()=>[])})
  const r=await d.service.getPlanTokens('codex',{start:'2026-09-17',end:'2026-10-17'})
  expect(r.missingSource).toBe(true);expect(r.records).toEqual([]);expect(d.scanFn.mock.calls.map(c=>c[0])).toEqual(['claude','dsh'])
  expect((await d.service.getCalendar({month:'2026-09'})).days['2026-09-17'].status).toBe('ready')
})
it('S06 explicit retry reconstructs only failed source/date and emits shared change',async()=>{
  let failed=true
  const d=fixture({scanFn:vi.fn(async id=>{if(id==='dsh'&&failed)throw Error('no');return [record('gpt-6-astra',1)]})})
  const changed=vi.fn();d.service.subscribe(changed)
  await d.service.getCalendar({month:'2026-09'});d.scanFn.mockClear();changed.mockClear();failed=false
  const c=await d.service.getCalendar({month:'2026-09',retryDate:'2026-09-17'})
  expect(d.scanFn.mock.calls.map(c=>c[0])).toEqual(['dsh']);expect(c.complete).toBe(true);expect(changed).toHaveBeenCalled()
})
it('S07 mixed legacy total is preserved when logs are gone, never guessed as Plan source',async()=>{
  const old={version:6,date:'2026-09-16',models:{'gpt-6-astra':{input:100,total:100}},projects:{},summary:{total:100},generatedAt:'2026-09-16T16:00Z'}
  const d=fixture({earliestFn:async()=> '2026-09-16',sourceStatusFn:async()=> 'missing',legacyReadFn:async key=>key==='2026-09-16'?old:null})
  const c=await d.service.getCalendar({month:'2026-09'});expect(c.days['2026-09-16'].total).toBe(100);expect(c.legacyCacheDays).toBe(1)
  await expect(d.service.getPlanTokens('codex',{start:'2026-09-16',end:'2026-09-17'})).rejects.toThrow('SOURCE_UNVERIFIABLE')
  expect(d.scanFn).not.toHaveBeenCalled()
})
it('S08 new cycle waits when published cutoff is from yesterday, without a page scan or fake zero',async()=>{
  const d=fixture();d.setNow('2026-09-17T15:58Z');await d.service.tick();d.scanFn.mockClear();d.setNow('2026-09-17T16:02Z')
  const r=await d.service.getPlanTokens('codex',{start:'2026-09-18',end:'2026-10-18'})
  expect(r.pending).toBe(true);expect(d.scanFn).not.toHaveBeenCalled()
  await d.service.tick();expect((await d.service.getPlanTokens('codex',{start:'2026-09-18',end:'2026-10-18'})).pending).not.toBe(true)
})
it('S08 fixed cutoff excludes future records and freezes all sources to the same instant',async()=>{
  const d=fixture({scanFn:vi.fn(async()=>[record('gpt-6-astra',1),record('gpt-6-astra',999,'2026-09-17T05:00Z')])})
  const r=await d.service.getPlanTokens('codex',{start:'2026-09-17',end:'2026-10-17'})
  expect(r.records.map(r=>r.input)).toEqual([1]);expect(new Set(d.scanFn.mock.calls.map(c=>c[2].toISOString())).size).toBe(1)
})
it('S09 price changes recompute from the identical token snapshot, never rescan logs',async()=>{
  const d=fixture();const p=await d.service.getPlanTokens('codex',{start:'2026-09-17',end:'2026-10-17'})
  const prices={aliases:{},models:{'gpt-6-astra':{input:2,output:4,cacheRead:1,cacheWrite:3}}}
  const before=await aggregatePlanCosts('codex',p.records,prices)
  const after=await aggregatePlanCosts('codex',p.records,{...prices,models:{'gpt-6-astra':{input:4,output:4,cacheRead:1,cacheWrite:3}}})
  expect(before.total).toBe((20*2+2*4+3+4*3)/1e6);expect(after.total-before.total).toBeCloseTo(40/1e6,12)
  expect(d.scanFn).toHaveBeenCalledTimes(3)
})
it('S11 first-time consumer sees per-range progress while a shared job is already running',async()=>{
  const d=fixture({earliestFn:async()=> '2026-09-16',scanFn:vi.fn(async(id,start)=>[record('gpt-6-astra',1,start.toISOString())])})
  const progress=vi.fn()
  await Promise.all([d.service.ensureRange('2026-09-16','2026-09-18'),d.service.getCalendar({month:'2026-09',taskId:'calendar'},progress)])
  expect(progress.mock.calls.some(([event])=>event.taskId==='calendar'&&event.processedDays===1&&event.totalDays===2)).toBe(true)
  expect(d.scanFn).toHaveBeenCalledTimes(6)
})
it('S08 query queued during a tick reports the cutoff of the records it actually returns',async()=>{
  const d=fixture();await d.service.tick();d.setNow('2026-09-17T04:10Z')
  let release,entered
  const started=new Promise(r=>{entered=r}),gate=new Promise(r=>{release=r})
  d.scanFn.mockImplementation(async id=>{entered();await gate;return [record('gpt-6-astra',1),record('gpt-6-astra',2,'2026-09-17T04:04Z')]})
  const tick=d.service.tick();await started
  const query=d.service.getPlanTokens('codex',{start:'2026-09-17',end:'2026-10-17'});await Promise.resolve();await Promise.resolve();release();await tick
  const result=await query
  expect(result.records.map(r=>r.input)).toEqual([1,2]);expect(result.cutoff).toBe('2026-09-17T04:10:00.000Z')
})
it('S06 retry today uses the published cutoff instead of mixing later DSH data into old CLI snapshots',async()=>{
  let failure=true
  const d=fixture({scanFn:vi.fn(async(id,start,end)=>{if(id==='dsh'&&failure)throw Error('no');return [record('gpt-6-astra',1,new Date(end.getTime()-1).toISOString())]})})
  await d.service.getCalendar({month:'2026-09'});failure=false;d.setNow('2026-09-17T04:02Z')
  await d.service.getCalendar({month:'2026-09',retryDate:'2026-09-17'})
  expect(new Set(Object.values(d.entries.get('2026-09-17').sources).map(s=>s.cutoff)).size).toBe(1)
})
it('S03 empty installation discovers logs once and a later background tick publishes its first records',async()=>{
  let present=false
  const d=fixture({sourceStatusFn:async()=>present?'present':'missing',earliestFn:vi.fn(async()=>null)})
  await d.service.bootstrap();await d.service.getCalendar({month:'2026-09'});await d.service.getCalendar({month:'2026-09'})
  expect(d.earliestFn).toHaveBeenCalledTimes(1)
  present=true;await d.service.tick()
  expect((await d.service.getCalendar({month:'2026-09'})).days['2026-09-17'].total).toBe(157)
})
it('S03 a fresh persisted today snapshot is reused at startup, while an expired one updates only today',async()=>{
  const d=fixture();await d.service.bootstrap();d.scanFn.mockClear();d.setNow('2026-09-17T04:02Z')
  const fresh=createSharedUsageStatistics(d);const state=await fresh.bootstrap();expect(d.scanFn).not.toHaveBeenCalled();expect(state.lastRunAt).toBe('2026-09-17T04:00:00.000Z')
  d.setNow('2026-09-17T04:06Z');const old=createSharedUsageStatistics(d);await old.bootstrap();expect(d.scanFn).toHaveBeenCalledTimes(3)
})
