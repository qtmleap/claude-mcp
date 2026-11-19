import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAsk} from '../src/runner.mjs';
async function fixture(t,code){const root=await realpath(await mkdtemp(join(tmpdir(),'claude-stream-')));t.after(()=>rm(root,{recursive:true,force:true}));const command=join(root,'cli');await writeFile(command,'#!/usr/bin/env node\n'+code,{mode:0o755});return {root,command,env:{...process.env,ANTHROPIC_AUTH_TOKEN:'split-secret'},maxOutput:1024,permissionMode:'acceptEdits',allowedTools:[]};}
test('stream progress hides thinking and split secrets while final result survives verbose trace',async t=>{
 const config=await fixture(t,`const send=x=>console.log(JSON.stringify(x));send({type:'assistant',message:{content:[{type:'thinking',thinking:'PRIVATE THINKING'},{type:'tool_use',input:{secret:'PRIVATE INPUT'}}]}});send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'split-'}}});setTimeout(()=>{send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'secret'}}});for(let i=0;i<100;i++)send({type:'user',message:{content:'TRACE'.repeat(30)}});send({type:'result',subtype:'success',is_error:false,result:'split-secret final'});},40);`);
 const progress=[];const result=await runAsk({prompt:'x'},config,undefined,{stream:true,onProgress:x=>progress.push(x)});
 assert.equal(result.answer,'[redacted] final');const text=JSON.stringify(progress);assert.ok(!text.includes('split-'));assert.ok(!text.includes('PRIVATE'));assert.ok(progress.length>0);
});
test('generation has no default deadline when not explicitly supplied',async t=>{
 const config=await fixture(t,`setTimeout(()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'late'})),100);`);
 config.timeoutMs=undefined;assert.equal((await runAsk({prompt:'x'},config)).answer,'late');
});
test('redaction happens before output-tail trimming across secret and split delta boundary',async t=>{
 const secret='0123456789-sensitive-suffix';
 const config=await fixture(t,`const send=text=>console.log(JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text}}}));send('prefix 0123456789-');setTimeout(()=>{send('sensitive-suffix end');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));},20);`);
 config.maxOutput=12;config.env.ANTHROPIC_AUTH_TOKEN=secret;
 const progress=[];await runAsk({prompt:'x'},config,undefined,{stream:true,onProgress:x=>progress.push(x.partial_answer)});
 assert.ok(progress.length);for(const text of progress){assert.ok(!text.includes('suffix'),text);assert.ok(!text.includes('01234'),text);}
 assert.match(progress.at(-1),/dacted\] end$/);
});
test('stderr secret crossing capture boundary is redacted before final message limit',async t=>{
 const config=await fixture(t,`process.stderr.write('x'.repeat(1995)+'split-secret');process.exitCode=3;`);
 await assert.rejects(runAsk({prompt:'x'},config,undefined,{stream:true}),error=>{
  assert.equal(error.code,'claude_exit');assert.ok(!error.message.endsWith('split'));assert.ok(!error.message.includes('split-'));return true;
 });
});
test('stderr redaction compression cannot expose a truncated repeated secret prefix',async t=>{
 const secret='reviewSecret-'+ 'a'.repeat(88);
 const config=await fixture(t,`process.stderr.write(${JSON.stringify(secret)}.repeat(100));process.exitCode=3;`);
 config.env.ANTHROPIC_AUTH_TOKEN=secret;
 await assert.rejects(runAsk({prompt:'x'},config,undefined,{stream:true}),error=>{
  assert.equal(error.code,'claude_exit');assert.ok(!error.message.includes('reviewSecret'),error.message);return true;
 });
});
