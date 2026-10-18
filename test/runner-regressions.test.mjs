import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAsk } from '../src/runner.mjs';

async function fixture(context, code) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-regression-')));
  const command = join(root, 'cli');
  await writeFile(command, '#!/usr/bin/env node\n'+code, { mode: 0o755 });
  context.after(async()=>{
    const pid = Number(await readFile(join(root,'pid'),'utf8').catch(()=>0));
    if(pid) { try { process.kill(pid,'SIGKILL'); } catch {} }
    await rm(root,{recursive:true,force:true});
  });
  return {root,command,env:{...process.env},maxOutput:8*1024*1024,permissionMode:'acceptEdits',allowedTools:[]};
}

test('a mismatched terminal session cannot keep a runner alive forever',{timeout:8000},async context=>{
  const config=await fixture(context,`require('fs').writeFileSync('pid',String(process.pid));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done',session_id:'wrong'}));setInterval(()=>{},1000);`);
  await assert.rejects(runAsk({prompt:'x',session:{uuid:'expected',mode:'new',configDir:config.root}},config,undefined,{stream:true}),error=>error.code==='session_mismatch');
});

test('JSON result observation avoids repeatedly copying the complete accumulated output',async context=>{
  const size=3*1024*1024;
  const config=await fixture(context,`const output=JSON.stringify({type:'result',subtype:'success',is_error:false,result:'x'.repeat(${size})});let offset=0;function send(){if(offset===output.length)return;const next=output.slice(offset,offset+4096);offset+=next.length;process.stdout.write(next,()=>setImmediate(send));}send();`);
  const concat=Buffer.concat;
  let copied=0;
  Buffer.concat=function(parts,...rest){copied+=parts.reduce((sum,part)=>sum+part.length,0);return concat.call(this,parts,...rest);};
  let result;
  try { result=await runAsk({prompt:'x'},config); } finally { Buffer.concat=concat; }
  assert.equal(result.answer.length,size);
  assert.ok(copied<size*4,`Copied ${copied} bytes for ${size} output bytes`);
});
