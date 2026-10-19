import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsage} from '../src/usage.mjs';

const live={
 usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:0,cache_creation_input_tokens:5,
  cache_creation:{ephemeral_5m_input_tokens:5,ephemeral_1h_input_tokens:0},output_tokens_details:{thinking_tokens:7},secret:'x',tools:[1]},
 modelUsage:{'claude-haiku-4-5':{inputTokens:100,outputTokens:50,cacheReadInputTokens:3,cacheCreationInputTokens:4,costUSD:0.02,thinkingTokens:9,extra:'no'}},
 total_cost_usd:0.05};

test('maps per-invocation usage, keeping meaningful zeros',()=>{
 const u=normalizeUsage(live,0.01);
 assert.deepEqual(u.invocation,{inputTokens:10,outputTokens:20,cacheReadInputTokens:0,cacheCreationInputTokens:5,
  cacheCreation5mInputTokens:5,cacheCreation1hInputTokens:0,thinkingTokens:7});
});
test('conversation cumulative model usage and cost are separately scoped',()=>{
 const u=normalizeUsage(live,0.01);
 assert.deepEqual(u.conversationModelUsage,{'claude-haiku-4-5':{inputTokens:100,outputTokens:50,cacheReadInputTokens:3,cacheCreationInputTokens:4,costUSD:0.02,thinkingTokens:9}});
 assert.equal(u.conversationCostUSD,0.05);
 assert.ok(Math.abs(u.invocationCostDeltaUSD-0.04)<1e-12);
 assert.equal(JSON.stringify(u).includes('secret'),false);
 assert.equal('percentSaved' in u,false);
});
test('cost delta: baseline 0 ok, unknown/invalid/decreasing baseline gives null',()=>{
 assert.equal(normalizeUsage(live,0).invocationCostDeltaUSD,0.05);
 assert.equal(normalizeUsage(live,0.05).invocationCostDeltaUSD,0);
 for(const b of [undefined,null,-1,NaN,Infinity,'0.01',[0],{},0.06])assert.equal(normalizeUsage(live,b).invocationCostDeltaUSD,null,String(b));
});
test('repeating the same latest result with the same baseline does not accumulate',()=>{
 const a=normalizeUsage(live,0.01),b=normalizeUsage(live,0.01);
 assert.deepEqual(a,b);
 assert.equal(normalizeUsage(live,a.conversationCostUSD).invocationCostDeltaUSD,0);
});
test('invalid values are null/omitted, never fake zero or coerced',()=>{
 const u=normalizeUsage({usage:{input_tokens:'5',output_tokens:-1,cache_read_input_tokens:NaN,cache_creation_input_tokens:Infinity,
  cache_creation:[],output_tokens_details:{thinking_tokens:null}},total_cost_usd:'1',modelUsage:[]},0);
 assert.deepEqual(u.invocation,{});
 assert.equal(u.conversationCostUSD,null);assert.equal(u.invocationCostDeltaUSD,null);
 assert.deepEqual(u.conversationModelUsage,{});
});
test('missing/garbage results are safe',()=>{
 for(const r of [undefined,null,'x',5,[],{},{usage:'a',modelUsage:'b'}]){
  const u=normalizeUsage(r);assert.deepEqual(u.invocation,{});assert.deepEqual(u.conversationModelUsage,{});
  assert.equal(u.conversationCostUSD,null);assert.equal(u.invocationCostDeltaUSD,null);}
});
test('model keys are sanitized and bounded; weird keys dropped',()=>{
 const mu=(k)=>({[k]:{inputTokens:1}});
 const ok=normalizeUsage({modelUsage:mu('claude-sonnet-4.5[1m]')}).conversationModelUsage;
 assert.deepEqual(Object.keys(ok),['claude-sonnet-4.5[1m]']);
 for(const k of ['sk-ant-api03-'+'a'.repeat(40),'a b','x'.repeat(100),'','__proto__','http://u:p@h','a'.repeat(30)+'=='])
  assert.deepEqual(normalizeUsage({modelUsage:mu(k)}).conversationModelUsage,{},k);
 const many={};for(let i=0;i<50;i++)many['m'+i]={inputTokens:i};
 assert.ok(Object.keys(normalizeUsage({modelUsage:many}).conversationModelUsage).length<=16);
 const bad=normalizeUsage({modelUsage:{m:{inputTokens:-1,costUSD:NaN,outputTokens:0}}}).conversationModelUsage;
 assert.deepEqual(bad,{m:{outputTokens:0}});
});
test('hostile getters/proxies do not throw',()=>{
 const r={get usage(){throw new Error('boom')}};
 assert.deepEqual(normalizeUsage(r).invocation,{});
});
