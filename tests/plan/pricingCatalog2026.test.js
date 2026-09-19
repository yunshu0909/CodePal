/* @vitest-environment node */
/** 2026-09 price catalog: official current prices, dated price cuts and recent Claude/GPT models. @module tests/pricingCatalog2026 */
import {it,expect} from 'vitest'
import {createRequire} from 'node:module'
import pricing from '../../src/config/pricing.json'
const require=createRequire(import.meta.url)
const {validatePricing}=require('../../electron/services/registries/pricingRegistry')
const {aggregatePlanCosts}=require('../../electron/services/plan/planUsageService')
const rates=m=>({input:m.input,output:m.output,cacheRead:m.cacheRead,cacheWrite:m.cacheWrite})
const rec=(timestamp,model)=>({timestamp,model,input:1e6,output:1e6,cacheRead:0,cacheCreate:0,source:'codex'})

it('catalog is valid, dated 2026-09-19 or later, and lists recent Claude models at official prices',()=>{
 expect(validatePricing(pricing).valid).toBe(true);expect(pricing.version>='2026-09-19').toBe(true)
 const want={'claude-fable-5-1':[10,50,0.25,12.5],'claude-fable-5':[10,50,1,12.5],'claude-mythos-5-1':[10,50,0.25,12.5],'claude-mythos-5':[10,50,1,12.5],'claude-opus-5':[5,25,0.5,6.25],'claude-opus-4-8':[5,25,0.5,6.25],'claude-opus-4-7':[5,25,0.5,6.25],'claude-opus-4-6':[5,25,0.5,6.25],'claude-opus-4-5':[5,25,0.5,6.25],'claude-sonnet-5':[2,10,0.2,2.5],'claude-sonnet-4-6':[3,15,0.3,3.75],'claude-sonnet-4-5':[3,15,0.3,3.75],'claude-haiku-4-5':[1,5,0.1,1.25]}
 for(const [k,[i,o,r,w]] of Object.entries(want))expect(rates(pricing.models[k]),k).toEqual({input:i,output:o,cacheRead:r,cacheWrite:w})
})
it('lists recent GPT models at official standard short-context prices',()=>{
 const want={'gpt-6-astra':[10,50,1,12.5],'gpt-5-5':[5,30,0.5,0],'gpt-5-4':[2.5,15,0.25,0],'gpt-5-4-mini':[0.75,4.5,0.075,0],'gpt-5-4-nano':[0.2,1.25,0.02,0],'gpt-5-3-codex':[1.75,14,0.175,0],'gpt-5-2':[1.75,14,0.175,0],'gpt-5-1':[1.25,10,0.125,0],'gpt-5':[1.25,10,0.125,0],'gpt-5-mini':[0.25,2,0.025,0],'gpt-5-nano':[0.05,0.4,0.005,0],'gpt-5-5-pro':[30,180,30,0],'gpt-5-4-pro':[30,180,30,0],'gpt-5-2-pro':[21,168,21,0],'gpt-5-pro':[15,120,15,0]}
 for(const [k,[i,o,r,w]] of Object.entries(want))expect(rates(pricing.models[k]),k).toEqual({input:i,output:o,cacheRead:r,cacheWrite:w})
})
it('GPT-5.6 Terra/Luna switch prices at the 07-30 cut; Sol stays at its list price through the promotion',async()=>{
 const cost=async(model,day)=>(await aggregatePlanCosts('codex',[rec(day+'T04:00:00Z',model)],pricing)).total
 expect(await cost('gpt-5.6-sol','2026-08-20')).toBe(35);expect(await cost('gpt-5.6-sol','2026-08-21')).toBe(35) // Sol 促销价不计，始终原价
 expect(await cost('gpt-5.6-terra','2026-07-29')).toBe(17.5);expect(await cost('gpt-5.6-terra','2026-07-30')).toBe(14)
 expect(await cost('gpt-5.6-luna','2026-07-29')).toBe(7);expect(await cost('gpt-5.6-luna','2026-07-30')).toBeCloseTo(1.4,10)
})
