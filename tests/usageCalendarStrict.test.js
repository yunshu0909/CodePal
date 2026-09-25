/* @vitest-environment node */
/** Strict calendar scans fail explicitly while legacy callers keep fail-soft behavior. @module tests/usageCalendarStrict */
import {describe,it,expect} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {createDshWorkerRunner}=require('../electron/services/dshUsageWorkerClient')
const {scanDshLogsInProcess,listDshSessionLogs}=require('../electron/services/usageLogScanService')
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
 it('DSH directory enumeration errors fail strict scans; vanished entries and legacy callers stay soft',async()=>{
  // 假文件系统：根目录下一个子目录 + 一份日志；按场景让子目录 readdir 或日志 stat 出错
  const err=code=>Object.assign(Error(code),{code})
  const dirent=(name,dir)=>({name,isDirectory:()=>dir,isFile:()=>!dir})
  const fsWith=({readdirErr,statErr})=>({
   readdir:async p=>{if(p==='/d')return[dirent('sub',true),dirent('session.v3.jsonl.zstd',false)];if(readdirErr)throw err(readdirErr);return[]},
   stat:async()=>{if(statErr)throw err(statErr);return{mtime:new Date('2026-09-16T01:00:00Z'),size:10}}
  })
  const opts=extra=>({readFileFn:()=>{throw err('EIO')},...extra})
  for(const bad of [{readdirErr:'EACCES'},{statErr:'EPERM'}]){
   await expect(listDshSessionLogs('/d',new Date(0),undefined,opts({fsPromises:fsWith(bad),strictScan:true}))).rejects.toThrow('DSH_LOG_ENUMERATION_FAILED')
   await expect(listDshSessionLogs('/d',new Date(0),undefined,opts({fsPromises:fsWith(bad)}))).resolves.toBeInstanceOf(Array)
  }
  // 扫描途中被删掉的子目录 / 文件（ENOENT）不算枚举失败
  await expect(listDshSessionLogs('/d',new Date(0),undefined,opts({fsPromises:fsWith({readdirErr:'ENOENT',statErr:'ENOENT'}),strictScan:true}))).resolves.toEqual([])
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
