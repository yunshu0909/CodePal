/* @vitest-environment node */
/** Dated prices, local overrides, missing prices and immediate refresh. @module tests/planPricingHistory */
import {it,expect,vi,afterEach} from 'vitest'
import {createRequire} from 'node:module'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
const require=createRequire(import.meta.url)
const {getEffectivePricing,aggregatePlanCosts,createPlanUsageQuery}=require('../../electron/services/plan/planUsageService')
const {createPlanPriceOverrideService}=require('../../electron/services/plan/planPriceOverrideService')
const {validatePricing}=require('../../electron/services/registries/pricingRegistry')
const loader=require('../../electron/services/remoteConfigLoader')
afterEach(()=>{vi.unstubAllGlobals();loader.__resetAllRegistriesForTesting()})
const price=(input,extra={})=>({input,output:0,cacheRead:0,cacheWrite:0,...extra})
const base=(models,extra={})=>({version:'2026-09-13',exchangeRate:7,models,aliases:{},...extra})
const rec=(timestamp,model,input=1e6)=>({timestamp,model,input,output:0,cacheRead:0,cacheCreate:0,source:'codex'})

it('TC-007 each record is priced by the segment effective on its Beijing date',async()=>{
 const pricing=base({'gpt-5-5':price(5,{displayName:'GPT-5.5',history:[{until:'2026-06-01',...price(10)}]})})
 const r=await aggregatePlanCosts('codex',[rec('2026-05-31T15:59:59Z','gpt-5.5'),rec('2026-05-31T16:00:00Z','gpt-5.5')],pricing)
 expect(r.total).toBe(15);expect(r.models).toEqual([{name:'GPT-5.5',key:'gpt-5-5',cost:15,own:false}]);expect(r.missingCount).toBe(0)
})
it('TC-008 local price beats cloud beats packaged, clearing falls back, local alone prices a new model',async()=>{
 const packaged=base({'gpt-5-5':price(1)}),remote=base({'gpt-5-5':price(2)})
 const data={};const store={get:k=>structuredClone(data[k]),set:vi.fn((k,v)=>{data[k]=structuredClone(v)})}
 const overrides=createPlanPriceOverrideService({store})
 overrides.set('gpt-5.5',price(3));overrides.set('gpt-7',price(4))
 let r=await aggregatePlanCosts('codex',[rec('2026-09-01T00:00:00Z','gpt-5.5'),rec('2026-09-01T00:00:00Z','gpt-7')],getEffectivePricing(packaged,remote,overrides.list()))
 expect(r.models.find(m=>m.key==='gpt-5-5')).toMatchObject({cost:3,own:true});expect(r.models.find(m=>m.key==='gpt-7')).toMatchObject({cost:4,own:true})
 overrides.clear('gpt-5.5')
 r=await aggregatePlanCosts('codex',[rec('2026-09-01T00:00:00Z','gpt-5.5')],getEffectivePricing(packaged,remote,overrides.list()))
 expect(r.models[0]).toMatchObject({cost:2,own:false})
 expect(()=>overrides.set('gpt-5.5',price(-1))).toThrow('INVALID_PRICE');expect(()=>overrides.set('',price(1))).toThrow('INVALID_PRICE')
})
it('TC-009 unpriced models are null, counted and excluded; non-vendor records are not missing',async()=>{
 const r=await aggregatePlanCosts('codex',[rec('2026-09-01T00:00:00Z','gpt-x'),rec('2026-09-01T00:00:00Z','gpt-5.5'),rec('2026-09-01T00:00:00Z','<synthetic>')],base({'gpt-5-5':price(5)}))
 expect(r.models.find(m=>m.name==='gpt-x')).toMatchObject({cost:null,own:false});expect(r.missingCount).toBe(1);expect(r.total).toBe(5);expect(r.excludedModels.map(m=>m.model)).toEqual(['<synthetic>'])
})
it('TC-010 recordsFrom marks only the cycle that the earliest usage date falls inside',async()=>{
 const cycles={a:{id:'a',start:'2026-03-13',end:'2026-04-13',price:100},b:{id:'b',start:'2026-04-13',end:'2026-05-13',price:100}}
 const ledger={getCycle:async(id,cycleId)=>({plan:{version:3},cycle:cycles[cycleId],cutoff:'2026-09-19T04:00:00Z'})}
 const daily={query:async()=>({records:[],revision:1})}
 const q=createPlanUsageQuery({ledger,daily,pricingFn:()=>base({'gpt-5-5':price(5)}),earliestFn:async()=> '2026-03-23'})
 expect((await q('codex','a')).recordsFrom).toBe('2026-03-23');expect((await q('codex','b')).recordsFrom).toBeNull()
})
it('TC-011 refresh now replaces the in-memory snapshot, reports stale and network failures',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pricing-'))
 const spec={name:'pricing',remotePath:'src/config/pricing.json',cacheFileName:'pricing.cache.json',packaged:base({'gpt-5-5':price(5)}),hardcoded:base({'gpt-5-5':price(5)}),validate:validatePricing}
 await loader.initRemoteConfig(spec,{getUserDataPath:()=>dir})
 const reply=body=>vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>body})))
 reply(base({'gpt-5-5':price(5),'gpt-7':price(9)},{version:'2026-09-20'}))
 expect(await loader.refreshRemoteConfigNow(spec,{getUserDataPath:()=>dir})).toMatchObject({success:true,replaced:true});expect(loader.getRemoteConfig('pricing').config.models['gpt-7'].input).toBe(9)
 reply(base({'gpt-5-5':price(1)},{version:'2026-01-01'}))
 expect(await loader.refreshRemoteConfigNow(spec,{getUserDataPath:()=>dir})).toMatchObject({success:true,replaced:false});expect(loader.getRemoteConfig('pricing').config.models['gpt-7'].input).toBe(9)
 vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('offline')}))
 expect((await loader.refreshRemoteConfigNow(spec,{getUserDataPath:()=>dir})).success).toBe(false)
})
it('TC-012 validatePricing accepts optional ordered history and rejects malformed segments',()=>{
 const withHistory=h=>base({'gpt-5-5':price(5,{history:h})})
 expect(validatePricing(base({'gpt-5-5':price(5)})).valid).toBe(true)
 expect(validatePricing(withHistory([{until:'2026-03-01',...price(9)},{until:'2026-06-01',...price(7)}])).valid).toBe(true)
 for(const bad of ['x',[{until:'2026-02-30',...price(1)}],[{until:'2026-06-01',...price(1)},{until:'2026-03-01',...price(1)}],[{until:'2026-06-01',...price(-1)}]])expect(validatePricing(withHistory(bad)).valid).toBe(false)
})
it('TC-010b per-source earliest usage date is the earlier of logs and cached days, memoized, and tolerant of log failures',async()=>{
 const {createSharedUsageStatistics,SCHEMA,SEMANTICS}=require('../../electron/services/sharedUsageStatistics')
 const cutoff='2026-02-10T16:00:00.000Z',empty={status:'missing',complete:true,records:[],cutoff}
 const day={schemaVersion:SCHEMA,semantics:SEMANTICS,date:'2026-02-10',sources:{claude:empty,dsh:empty,codex:{status:'ready',complete:true,cutoff,records:[{timestamp:'2026-02-10T02:00:00.000Z',model:'gpt-5.5',input:5,output:0,cacheRead:0,cacheCreate:0}]}}}
 const storage={read:async k=>k==='2026-02-10'?structuredClone(day):null,write:async()=>{},list:async()=>['2026-02-10']}
 const logs=vi.fn(async id=>id==='codex'?'2026-03-23':'2026-08-29')
 const s=createSharedUsageStatistics({storage,sourceEarliestFn:logs,nowFn:()=>new Date('2026-09-19T04:00:00Z')})
 expect(await s.getSourceEarliestDate('codex')).toBe('2026-02-10');expect(await s.getSourceEarliestDate('claude')).toBe('2026-08-29')
 await s.getSourceEarliestDate('codex');expect(logs.mock.calls.filter(c=>c[0]==='codex')).toHaveLength(1)
 const broken=createSharedUsageStatistics({storage,sourceEarliestFn:async()=>{throw Error('EACCES')}});expect(await broken.getSourceEarliestDate('codex')).toBe('2026-02-10');expect(await broken.getSourceEarliestDate('claude')).toBeNull()
})
it('TC-008b local-price keys use exactly the same normalization as model aggregation',async()=>{
 const {normalizeModelKey}=await import('../../electron/services/modelAlias.mjs')
 const data={};const store={get:k=>structuredClone(data[k]),set:(k,v)=>{data[k]=structuredClone(v)}}
 const o=createPlanPriceOverrideService({store})
 for(const name of ['GPT-5.5','gpt 5.6 Sol','Claude.Opus.5','gpt-6-astra','K3 256k'])o.set(name,price(1))
 expect(Object.keys(o.list()).sort()).toEqual(['GPT-5.5','gpt 5.6 Sol','Claude.Opus.5','gpt-6-astra','K3 256k'].map(normalizeModelKey).sort())
})
