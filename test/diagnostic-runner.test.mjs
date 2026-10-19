import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.mjs';

test('native diagnostic mode persists only classified metadata and never raw stderr', async context=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'claude-diagnostic-')));
  context.after(()=>rm(root,{recursive:true,force:true}));
  const command=join(root,'cli');
  await writeFile(command,'#!/usr/bin/env node\n'+`process.stderr.write('PRIVATE RAW LOG\\n2026-10-18T20:28:42.031Z [ERROR] Connection error details: code=StreamTruncated, message=PRIVATE RAW LOG\\n');console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'PRIVATE THINKING'}}}));console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['Synthetic stream failed']}));process.exitCode=1;`,{mode:0o755});
  const config={root,command,env:{...process.env},stateDir:join(root,'jobs'),maxOutput:10000,permissionMode:'acceptEdits',allowedTools:[],streamDiagnostics:true};
  const store=new JobStore(config);
  context.after(()=>store.close());
  const started=await store.start({prompt:'PRIVATE PROMPT'});
  const result=await store.get(started.job_id,2000);
  assert.equal(result.status,'failed');
  assert.equal(result.error.details.stream_diagnostic.first_error,'StreamTruncated');
  assert.deepEqual(result.error.details.stream_diagnostic.event_counts,{thinking_delta:1});
  const body=await readFile(join(config.stateDir,started.job_id+'.json'),'utf8');
  assert.doesNotMatch(body,/PRIVATE|Connection error details|2026-10-18T20:28/);
});
