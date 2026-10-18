import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.mjs';

async function fixture(context){
  const root=await realpath(await mkdtemp(join(tmpdir(),'terminal-cleanup-')));
  context.after(()=>rm(root,{recursive:true,force:true}));
  const command=join(root,'cli');
  await writeFile(command,'#!/usr/bin/env node\n'+`const fs=require('fs');fs.appendFileSync('runs','1');const id=process.argv.find(arg=>arg.startsWith('--session-id=')).split('=')[1];console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'UNCONFIRMED'}}}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:id,result:'UNCONFIRMED',usage:{input_tokens:3,output_tokens:4},total_cost_usd:0.1,permission_denials:[{tool_name:'Bash',tool_input:'PRIVATE INPUT'}]}));setInterval(()=>{},1000);`,{mode:0o755});
  const config={root,command,env:{...process.env},stateDir:join(root,'jobs'),maxOutput:10000,permissionMode:'acceptEdits',allowedTools:[]};
  const store=new JobStore(config);context.after(()=>store.close());
  const initial=await store.start({prompt:'PRIVATE PROMPT',model:'m1',review:true,resumable:true});
  return {root,config,store,initial};
}

test('post-result failure retains accounting and suppresses denied output without allowing resume',{timeout:15000},async context=>{
  const {root,config,store,initial}=await fixture(context);
  const failed=await store.get(initial.job_id,12000);
  assert.equal(failed.status,'failed');assert.equal(failed.error.code,'cli_shutdown_timeout');
  assert.equal(failed.error.details?.usage?.invocation.outputTokens,4);
  assert.equal(failed.error.details.permission_denied,true);
  assert.equal(failed.partial_answer,'');assert.equal(failed.session.resume_available,false);
  await assert.rejects(store.start({prompt:'again',resume_job_id:initial.job_id}),error=>error.code==='chain_blocked');
  assert.equal(await readFile(join(root,'runs'),'utf8'),'1');
  const persisted=await readFile(join(config.stateDir,initial.job_id+'.json'),'utf8');
  assert.doesNotMatch(persisted,/UNCONFIRMED|PRIVATE/);
});

test('cancellation after a denied terminal result also clears retained partial output',async context=>{
  const {config,store,initial}=await fixture(context);
  const working=await store.get(initial.job_id,1000);
  assert.equal(working.status,'working');assert.equal(working.partial_answer,'UNCONFIRMED');
  const cancelled=await store.cancel(initial.job_id);
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.partial_answer,'');
  assert.equal(cancelled.session.resume_available,false);
  assert.doesNotMatch(await readFile(join(config.stateDir,initial.job_id+'.json'),'utf8'),/UNCONFIRMED|PRIVATE/);
});
