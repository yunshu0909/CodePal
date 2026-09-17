/* @vitest-environment node */
/** Strict calendar scans fail explicitly while legacy callers keep fail-soft behavior. @module tests/usageCalendarStrict */
import {describe,it,expect} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {createDshWorkerRunner}=require('../electron/services/dshUsageWorkerClient')
const {scanDshLogsInProcess}=require('../electron/services/usageLogScanService')
const {createLogScanWindowContext}=require('../electron/logScanner')
const {normalizeDailySummary}=require('../electron/services/dailySummaryService')
const {aggregateUsageCalendar}=require('../electron/services/usageCalendarService')
describe('calendar strict failure propagation',()=>{
 it('rejects unavailable worker for calendar only',async()=>{
  const run=createDshWorkerRunner({forkFn:()=>{throw Error('unavailable')},logger:{warn:()=>{}}})
  const start=new Date('2026-09-16T00:00:00+08:00'),end=new Date('2026-09-16T12:00:00+08:00')
  expect(await run(start,end)).toEqual([])
  await expect(run(start,end,{strictScan:true})).rejects.toThrow('DSH_WORKER_UNAVAILABLE')
 })
 it('rejects unreadable DSH logs, retaining legacy empty fallback',async()=>{
  const deps={homeDir:'/test',pathExistsFn:async()=>true,listDshSessionLogsFn:async()=>{throw Error('read error')}}
  const start=new Date('2026-09-16T00:00:00+08:00'),end=new Date('2026-09-16T12:00:00+08:00')
  expect(await scanDshLogsInProcess(start,end,deps)).toEqual([])
  await expect(scanDshLogsInProcess(start,end,{...deps,strictScan:true})).rejects.toThrow('read error')
 })
 it('incomplete directory enumeration cannot be persisted as a complete calendar day',async()=>{
  const start=new Date('2026-09-16T00:00:00+08:00')
  const context=createLogScanWindowContext(start,{enumerateFn:async()=>({candidates:[],failed:1})})
  await expect(context.scanForDay('/test',start,{strictScan:true})).rejects.toThrow('LOG_ENUMERATION_FAILED')
  expect((await context.scanForDay('/test',start)).files).toEqual([])
 })
 it('optional quality marker survives normalization without changing schema6 or legacy defaults',()=>{
  const raw={version:6,date:'2026-09-15',models:{a:{total:10}},projects:{},summary:{total:10}}
  expect(normalizeDailySummary(raw,'2026-09-15').calendarSourceChecked).toBeUndefined()
  expect(normalizeDailySummary({...raw,calendarSourceChecked:true},'2026-09-15')).toMatchObject({version:6,calendarSourceChecked:true})
 })
 it('malformed IPC input returns an error without rejecting invoke',async()=>{
  for(const params of [null,{}, {month:202609},{month:'2026-02',retryDate:'2026-02-30'}])expect((await aggregateUsageCalendar(params,{nowFn:()=>new Date('2026-09-16T04:00Z')})).success).toBe(false)
 })
})
