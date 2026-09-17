/* @vitest-environment node */
/** Source-family eligibility and query-time pricing. @module tests/planCosts */
import {it,expect} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {aggregatePlanCosts,getEffectivePricing}=require('../../electron/services/plan/planUsageService')
const rates=(input=2)=>({input,output:10,cacheRead:0.2,cacheWrite:4,displayName:'Claude Opus 5'})
const pricing={models:{'claude-opus-5':rates(),'gpt-6-astra':rates(3)},aliases:{'opus':'claude-opus-5'}}
const record=(model='claude-opus-5',input=1e6,source='claude')=>({model,input,output:0,cacheRead:0,cacheCreate:0,source})
it('TC-002 four token classes use USD per million without rounding',async()=>{
 const r=await aggregatePlanCosts('claude',[{...record(),output:2e5,cacheRead:3e5,cacheCreate:2.5e5}],pricing);expect(r.total).toBeCloseTo(5.06,10)
})
it('TC-003 canonical alias merge happens before family and amount sorting',async()=>{
 const r=await aggregatePlanCosts('claude',[record('opus'),record('Claude Opus 5',5e6)],pricing);expect(r.models).toHaveLength(1);expect(r.total).toBe(12);expect(r.models[0]).toMatchObject({name:'Claude Opus 5',cost:12})
})
it('TC-033 DSH and wrong source never enter either subscription',async()=>{
 const records=[record(),record('gpt-6-astra',1e6,'codex'),record('claude-opus-5',50e6,'dsh')];expect((await aggregatePlanCosts('claude',records,pricing)).total).toBe(2);expect((await aggregatePlanCosts('codex',records,pricing)).total).toBe(3)
})
it('TC-036 eligible missing price stays visible with null amount',async()=>{
 const r=await aggregatePlanCosts('claude',[record(),record('claude-new-9')],pricing);expect(r.total).toBe(2);expect(r.models.find(x=>x.name==='Claude New 9').cost).toBeNull()
})
it('TC-056 historical tokens reprice at effective current snapshot',async()=>{
 expect((await aggregatePlanCosts('claude',[record()],pricing)).total).toBe(2);expect((await aggregatePlanCosts('claude',[record()],{...pricing,models:{'claude-opus-5':rates(3)}})).total).toBe(3)
})
it('TC-057 all eligible models unpriced means null, never zero',async()=>{
 const r=await aggregatePlanCosts('claude',[record('claude-new-9')],pricing);expect(r.total).toBeNull();expect(r.models[0].cost).toBeNull()
})
it('TC-058 excluded-only, partially excluded and eligible-unpriced both CLIs',async()=>{
 for(const id of ['claude','codex']){
  const excluded=['unknown','codex','DeepSeek Flash'].map(m=>record(m,1e6,id));const r=await aggregatePlanCosts(id,excluded,pricing);expect(r.total).toBe(0);expect(r.models).toEqual([]);expect(r.excludedModels).toHaveLength(3);expect(Object.keys(r.excludedModels[0]).sort()).toEqual(['count','model','tokens']);
  const eligible=id==='claude'?'claude-opus-5':'gpt-6-astra';const partial=await aggregatePlanCosts(id,[...excluded,record(eligible,1e6,id)],pricing);expect(partial.models).toHaveLength(1);expect(partial.total).toBe(id==='claude'?2:3);
  const unknownPrice=await aggregatePlanCosts(id,[record(id==='claude'?'claude-new-9':'gpt-new-9',1e6,id)],pricing);expect(unknownPrice.total).toBeNull();expect(unknownPrice.models).toHaveLength(1)
 }
})
it('TC-059 runtime models and aliases merge into immutable packaged fallback',()=>{
 const remote={models:{'claude-opus-5':rates(3)},aliases:{'local-opus':'claude-opus-5'}};const merged=getEffectivePricing(pricing,remote);expect(merged.models['claude-opus-5'].input).toBe(3);expect(merged.models['gpt-6-astra'].input).toBe(3);expect(merged.aliases).toEqual({opus:'claude-opus-5','local-opus':'claude-opus-5'});remote.models['claude-opus-5'].input=100;expect(merged.models['claude-opus-5'].input).toBe(3)
})
