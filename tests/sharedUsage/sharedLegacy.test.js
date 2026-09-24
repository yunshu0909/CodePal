/** Legacy consumers must read the common snapshot even when caller deps are supplied. */
import {it,expect,vi} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {createSharedUsageStatistics}=require('../../electron/services/sharedUsageStatistics')
const daily=require('../../electron/services/dailySummaryService')
it('S10 old daily read/recompute/write use the shared authority with legacy deps and never write a second live cache',async()=>{
 const value={version:6,date:'2026-09-16',models:{},projects:{},summary:{total:0}}
 const statistics={readLegacyDay:vi.fn(async()=>value),earliestLedgerDay:vi.fn(async()=> '2026-03-24')};daily.configureSharedStatistics(statistics)
 try{
  const deps={homeDir:'/must-not-open',pathExistsFn:vi.fn(),writeFileFn:vi.fn()}
  expect(await daily.readDailySummary('2026-09-16',deps)).toEqual(value)
  expect(await daily.recomputeDailySummary('2026-09-16',deps)).toEqual(value)
  await daily.writeDailySummary('2026-09-16',value,deps)
  expect(await daily.findEarliestDailySummaryDate(deps)).toBe('2026-03-24');expect(deps.pathExistsFn).not.toHaveBeenCalled();expect(deps.writeFileFn).not.toHaveBeenCalled()
 }finally{daily.configureSharedStatistics(null)}
})

it('S10 preserved legacy totals never gain a source-verified marker',async()=>{
 const entries=new Map(),legacy={version:6,date:'2026-09-17',models:{'gpt-6-astra':{input:100,output:0,cacheRead:0,cacheCreate:0,total:100}},projects:{legacy:{value:100}},summary:{total:100},generatedAt:'2026-09-17T01:00:00.000Z',calendarSourceChecked:true}
 const statistics=createSharedUsageStatistics({storage:{read:async k=>entries.get(k),write:async(k,v)=>entries.set(k,v),list:async()=>[]},sourceStatusFn:async()=> 'missing',earliestFn:async()=> '2026-09-17',legacyReadFn:async()=>legacy,nowFn:()=>new Date('2026-09-17T04:00Z')})
 await statistics.tick();expect((await statistics.readLegacyDay('2026-09-17')).calendarSourceChecked).toBe(false)
})
