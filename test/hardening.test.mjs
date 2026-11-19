import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionChains} from '../src/sessions.mjs';
import {runAsk} from '../src/runner.mjs';
import {JobStore} from '../src/jobs.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'mcp-hardening-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return root;
}
test('initialization preserves a conversation being created before its root record exists',async t=>{
 const dir=await fixture(t),id=randomUUID();
 await mkdir(join(dir,id));await writeFile(join(dir,id,'claim'),'in-flight creation');
 await new SessionChains(dir,1000).init();
 assert.equal(await readFile(join(dir,id,'claim'),'utf8'),'in-flight creation');
});
test('restart recovery never takes over a claim based on a numeric PID from another incarnation',async t=>{
 const dir=await fixture(t),store=new SessionChains(dir,10000);await store.init();
 const s=await store.create({jobId:'job_a',cwd:dir,model:'m',review:true,policy:'p'});
 await writeFile(join(dir,s.id,'claim'),JSON.stringify({job_id:'job_a',pid:process.pid,instance:'different-pid-namespace'}));
 await store.recover(s.id,'job_a');
 assert.equal(JSON.parse(await readFile(join(dir,s.id,'claim'),'utf8')).instance,'different-pid-namespace');
});
test('missing cumulative cost remains an unknown baseline on the next turn',async t=>{
 const dir=await fixture(t),store=new SessionChains(dir,10000);await store.init();
 const s=await store.create({jobId:'job_a',cwd:dir,model:'m',review:true,policy:'p'});
 await mkdir(join(s.configDir,'projects','fixture'),{recursive:true});
 await writeFile(join(s.configDir,'projects','fixture',s.id+'.jsonl'),'{}\n');
 await store.settle(s.id,true,undefined);
 const next=await store.reserve(s.id,'job_a','job_b');
 assert.equal(next.session.previousCost,null);
 await store.settle(s.id,false);
});
test('failed CLI results preserve reported accounting without exposing their arbitrary fields',async t=>{
 const dir=await fixture(t),file=join(dir,'cli');
 const payload={type:'result',subtype:'error_max_budget_usd',is_error:true,result:'budget reached',usage:{input_tokens:42,output_tokens:3},total_cost_usd:0.02,secret_field:'do-not-copy'};
 await writeFile(file,'#!/usr/bin/env node\nconsole.log('+JSON.stringify(JSON.stringify(payload))+');process.exitCode=1;\n',{mode:0o755});
 await assert.rejects(runAsk({prompt:'x'},{root:dir,command:file,env:{...process.env},permissionMode:'acceptEdits',allowedTools:[],maxOutput:10000}),e=>{
  assert.equal(e.details.usage.invocation.inputTokens,42);
  assert.equal(e.details.usage.conversationCostUSD,0.02);
  assert.ok(!JSON.stringify(e.details).includes('do-not-copy'));
  return true;
 });
});
test('completed jobs do not repeat the final answer in the partial progress field',async t=>{
 const dir=await fixture(t);
 const store=new JobStore({root:dir,stateDir:join(dir,'jobs'),env:{},maxOutput:10000},{run:async(_a,_c,_s,o)=>{
  o.onProgress({partial_answer:'same answer'});return {answer:'same answer'};
 }});t.after(()=>store.close());
 const job=await store.start({prompt:'x'}),done=await store.get(job.job_id,1000);
 assert.equal(done.result.answer,'same answer');assert.equal(done.partial_answer,'');
});

test('a terminal job deleted while session settlement runs cannot reappear on disk',async t=>{
 const dir=await fixture(t),original=SessionChains.prototype.settle;
 let release,entered;const barrier=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 SessionChains.prototype.settle=async function(...args){entered();await gate;return original.apply(this,args);};
 const config={root:dir,stateDir:join(dir,'jobs'),env:{},maxOutput:10000};
 const store=new JobStore(config,{run:async()=>({answer:'done'})});
 try {
  const job=await store.start({prompt:'x',model:'m',resumable:true,review:true});
  await barrier;await store.delete(job.job_id);release();await store.close();
  await assert.rejects(readFile(join(config.stateDir,job.job_id+'.json')),e=>e.code==='ENOENT');
 } finally {release();SessionChains.prototype.settle=original;await store.close();}
});

test('later session operations purge expired unclaimed transcripts in a long-lived store',async t=>{
 const dir=await fixture(t),config={root:dir,stateDir:join(dir,'jobs'),env:{},maxOutput:10000};
 const store=new JobStore(config,{run:async()=>({answer:'done'})});t.after(()=>store.close());
 const first=await store.start({prompt:'a',model:'m',resumable:true,review:true});await store.get(first.job_id,1000);
 const path=join(dir,'sessions',first.session.id,'root.json'),root=JSON.parse(await readFile(path,'utf8'));
 await writeFile(path,JSON.stringify({...root,expires_at:'2000-01-01T00:00:00.000Z'}));
 const next=await store.start({prompt:'b',model:'m',resumable:true,review:true});await store.get(next.job_id,1000);
 await assert.rejects(readFile(path),e=>e.code==='ENOENT');
});

test('stateless admission cannot take a slot while a resumed turn reserves its head',async t=>{
 const dir=await fixture(t),config={root:dir,stateDir:join(dir,'jobs'),env:{},maxOutput:10000,maxConcurrentJobs:1};
 let calls=0,finish;
 const store=new JobStore(config,{run:async(args)=>{
  if(args.session?.mode==='new'){
   const d=join(args.session.configDir,'projects','fixture');await mkdir(d,{recursive:true});await writeFile(join(d,args.session.uuid+'.jsonl'),'{}');
  }
  if(++calls>1)await new Promise(r=>finish=r);
  return {answer:'done'};
 }});
 const first=await store.start({prompt:'a',model:'m',resumable:true,review:true});await store.get(first.job_id,1000);
 const original=SessionChains.prototype.reserve;let entered,release;
 const barrier=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 SessionChains.prototype.reserve=async function(...args){entered();await gate;return original.apply(this,args);};
 try {
  const resumed=store.start({prompt:'b',resume_job_id:first.job_id});await barrier;
  const competing=store.start({prompt:'c'});await new Promise(r=>setTimeout(r,20));release();
  const [a,b]=await Promise.allSettled([resumed,competing]);
  assert.equal(a.status,'fulfilled');assert.equal(b.status,'rejected');assert.equal(b.reason.code,'capacity');
 } finally {release();finish?.();SessionChains.prototype.reserve=original;await store.close();}
});

test('missing root cannot report successful settlement or strand the owned claim',async t=>{
 const dir=await fixture(t),store=new SessionChains(dir,10000);await store.init();
 const s=await store.create({jobId:'job_a',cwd:dir,model:'m',review:true,policy:'p'});
 const root=join(dir,s.id,'root.json');await rm(root);await mkdir(root);
 await assert.rejects(store.settle(s.id,true,0.1));
 await assert.rejects(readFile(join(dir,s.id,'claim')),e=>e.code==='ENOENT');
});

test('an undeletable expired transcript does not prevent unrelated review sessions',async t=>{
 const dir=await fixture(t),store=new SessionChains(dir,10000);await store.init();
 const s=await store.create({jobId:'job_a',cwd:dir,model:'m',review:true,policy:'p'});await store.settle(s.id,true,0.1);
 const root=join(dir,s.id,'root.json'),data=JSON.parse(await readFile(root,'utf8'));await writeFile(root,JSON.stringify({...data,expires_at:'2000-01-01T00:00:00.000Z'}));
 const fs=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module'),original=fs.rm;
 fs.rm=async(path,...args)=>{if(path===join(dir,s.id))throw Object.assign(new Error('busy'),{code:'EBUSY'});return original(path,...args);};syncBuiltinESMExports();
 try {await assert.doesNotReject(store.init());}finally{fs.rm=original;syncBuiltinESMExports();}
});

test('get_job remains bounded while successful session settlement is delayed',async t=>{
 const dir=await fixture(t),original=SessionChains.prototype.settle;
 let release,entered;const barrier=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 SessionChains.prototype.settle=async function(...args){entered();await gate;return original.apply(this,args);};
 const store=new JobStore({root:dir,stateDir:join(dir,'jobs'),env:{},maxOutput:10000},{run:async()=>({answer:'done'})});
 const safety=setTimeout(()=>release(),500);
 try {
  const job=await store.start({prompt:'x',model:'m',review:true,resumable:true});await barrier;
  const started=Date.now(),snapshot=await store.get(job.job_id,20);
  assert.ok(Date.now()-started<200,'wait_ms exceeded while settlement was blocked');assert.equal(snapshot.session.resume_available,false);
  release();assert.equal((await store.get(job.job_id,1000)).session.resume_available,true);
 }finally {clearTimeout(safety);release();SessionChains.prototype.settle=original;await store.close();}
});

test('partial transcript cleanup preserves the root so expiry cleanup can retry',async t=>{
 const dir=await fixture(t),store=new SessionChains(dir,10000);await store.init();
 const s=await store.create({jobId:'job_a',cwd:dir,model:'m',review:true,policy:'p'});await store.settle(s.id,true,0.1);
 const root=join(dir,s.id,'root.json'),data=JSON.parse(await readFile(root,'utf8'));await writeFile(root,JSON.stringify({...data,expires_at:'2000-01-01T00:00:00.000Z'}));
 const fs=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module'),original=fs.rm;
 fs.rm=async(path,...args)=>{
  if(path===join(dir,s.id)){await fs.unlink(root);throw Object.assign(new Error('partial removal'),{code:'EBUSY'});}
  if(path===s.configDir)throw Object.assign(new Error('busy transcript'),{code:'EBUSY'});
  return original(path,...args);
 };syncBuiltinESMExports();
 try {await store.init();assert.equal(JSON.parse(await readFile(root,'utf8')).uuid,s.id);}
 finally {fs.rm=original;syncBuiltinESMExports();}
 await store.init();await assert.rejects(readFile(root),e=>e.code==='ENOENT');
});
