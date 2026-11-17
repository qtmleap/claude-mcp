import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capture} from '../src/command-capture.mjs';

test('context probe deadline stays bounded after a leader exits with an escaped pipe holder',{timeout:2000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'context-bound-')),file=join(root,'pid');
 t.after(async()=>{const pid=Number(await readFile(file,'utf8').catch(()=>0));if(pid)try{process.kill(pid,'SIGKILL')}catch{}await rm(root,{recursive:true,force:true});});
 const code=`const fs=require('fs'),cp=require('child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});fs.writeFileSync(${JSON.stringify(file)},String(c.pid));c.unref();process.exit(0);`;
 await assert.rejects(capture(process.execPath,['-e',code],{env:{PATH:process.env.PATH},timeoutMs:150}),e=>e.code==='context_timeout');
});
