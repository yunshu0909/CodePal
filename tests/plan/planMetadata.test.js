/* @vitest-environment node */
/** Credential metadata uses fake readers and a strict whitelist. @module tests/planMetadata */
import {it,expect,vi} from 'vitest'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {readPlanMetadata}=require('../../electron/services/plan/planMetadataService')
const jwt=claims=>'e30.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture'
it('TC-006 valid local types without guessing subscription price',async()=>{
 expect(await readPlanMetadata('claude',{platform:'darwin',readClaudeFn:async()=>JSON.stringify({claudeAiOauth:{subscriptionType:'pro'}})})).toMatchObject({type:'Pro',suggestedPrice:20});expect(await readPlanMetadata('codex',{readCodexFn:async()=>JSON.stringify({tokens:{id_token:jwt({'https://api.openai.com/auth':{chatgpt_plan_type:'prolite'}})}})})).toMatchObject({type:'prolite'});expect((await readPlanMetadata('claude',{platform:'darwin',readClaudeFn:async()=>JSON.stringify({claudeAiOauth:{subscriptionType:'max'}})})).suggestedPrice).toBeNull()
})
it('TC-034 malformed and denied metadata reader safely return unknown',async()=>{
 for(const reader of [async()=>'{broken',async()=>{throw Error('token_redacted')},async()=>JSON.stringify({claudeAiOauth:{subscriptionType:'unexpected'}})])expect(await readPlanMetadata('claude',{platform:'darwin',readClaudeFn:reader})).toMatchObject({type:'未知',suggestedPrice:null});const never=await readPlanMetadata('claude',{platform:'darwin',readClaudeFn:()=>new Promise(()=>{}),timeoutMs:5});expect(never.type).toBe('未知')
})
it('TC-070 only safe type and prefill fields cross the boundary',async()=>{
 const data={tokens:{access_token:'token_redacted',refresh_token:'refresh_token_redacted',id_token:jwt({'https://api.openai.com/auth':{chatgpt_plan_type:'plus',chatgpt_subscription_active_start:'2026-01-20',account_id:'account_redacted'}})},API_KEY:'sk-***'};const r=await readPlanMetadata('codex',{readCodexFn:async()=>JSON.stringify(data)});expect(Object.keys(r).sort()).toEqual(['suggestedBillingDay','suggestedPrice','type']);expect(r.suggestedBillingDay).toBe(20);expect(JSON.stringify(r)).not.toMatch(/token|account|sk-/i)
})
it('TC-071 nonmacOS never invokes security or fake Claude reader',async()=>{
 const reader=vi.fn();expect((await readPlanMetadata('claude',{platform:'win32',readClaudeFn:reader})).type).toBe('未知');expect(reader).not.toHaveBeenCalled()
})
