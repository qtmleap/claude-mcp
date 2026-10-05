import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listModels } from '../src/models.mjs';
async function api(t, handler) {
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 return `http://127.0.0.1:${server.address().port}`;
}
const config=(base,env={})=>({env:{ANTHROPIC_BASE_URL:base,...env},models:[],modelsTimeoutMs:500,maxOutput:10000});
test('models lists API pages with supplied bearer and Cloudflare identity',async t=>{
 const base=await api(t,(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer test-token');assert.equal(req.headers['cf-access-client-secret'],'access-secret');
  res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.includes('after_id')?{data:[{id:'model-b'}],has_more:false}:{data:[{id:'model-a'}],has_more:true,last_id:'model-a'}));
 });
 const result=await listModels(config(base,{ANTHROPIC_AUTH_TOKEN:'test-token',CF_ACCESS_CLIENT_SECRET:'access-secret'}));
 assert.deepEqual(result.models.map(x=>x.id),['model-a','model-b']);assert.equal(result.source,'api');
});
test('API key and /v1 base URL use correct header and endpoint',async t=>{
 const base=await api(t,(req,res)=>{assert.equal(req.url,'/v1/models');assert.equal(req.headers['x-api-key'],'key');assert.equal(req.headers.authorization,undefined);res.end(JSON.stringify({data:[{id:'custom'}]}));});
 assert.equal((await listModels(config(base+'/v1',{ANTHROPIC_API_KEY:'key'}))).models[0].id,'custom');
});
test('403 and invalid data fallback only to configured models',async t=>{
 const base=await api(t,(_,res)=>{res.statusCode=403;res.end('private-token');});
 const cfg=config(base,{ANTHROPIC_AUTH_TOKEN:'private-token'});cfg.models=['sonnet'];
 const result=await listModels(cfg);assert.equal(result.source,'configured');assert.equal(result.warning,'models_api_http_403');assert.ok(!JSON.stringify(result).includes('private-token'));
 cfg.models=[];await assert.rejects(listModels(cfg),e=>e.code==='models_unavailable');
});
test('redirects never forward credentials and oversized output is bounded',async t=>{
 let redirected=0;const sink=await api(t,(_,res)=>{redirected++;res.end('{}');});
 const base=await api(t,(_,res)=>{res.statusCode=307;res.setHeader('location',sink);res.end();});
 const cfg=config(base,{ANTHROPIC_AUTH_TOKEN:'private-token'});cfg.models=['configured'];
 assert.equal((await listModels(cfg)).source,'configured');assert.equal(redirected,0);
 const huge=await api(t,(_,res)=>res.end('x'.repeat(20000)));
 cfg.env.ANTHROPIC_BASE_URL=huge;assert.equal((await listModels(cfg)).warning,'models_api_invalid');
});
