import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {capture} from '../src/command-capture.mjs';
import {JobStore} from '../src/jobs.mjs';
import {executionContext} from '../src/execution.mjs';

const container=process.env.CLAUDE_MCP_TEST_CONTAINER,node=process.env.CLAUDE_MCP_TEST_NODE;
const enabled=!!container&&!!node;
async function fixture(t){
 const root='/tmp/claude-mcp-fixture-'+randomBytes(12).toString('hex');
 const local=await realpath(await mkdtemp(join(tmpdir(),'claude-helper-test-')));
 let store;
 const env={PATH:process.env.PATH,HOME:process.env.HOME};
 const remote=(code,input={})=>capture('docker',['exec','--interactive','--user','vscode',container,node,'--input-type=module','--eval',code],{env,input:JSON.stringify(input),timeoutMs:5000});
 const identity=`function proc(pid){try{const s=fs.readFileSync('/proc/'+pid+'/stat','utf8'),a=s.slice(s.lastIndexOf(')')+2).split(' ');return {pid,state:a[0],start:a[19]};}catch{return null;}}`;
 // Cleanup is registered before creating target files or processes, and only
 // touches exact fixture PIDs after matching their recorded Linux start times.
 t.after(async()=>{
  await store?.close();
  await remote(`import fs from 'node:fs';${identity}const root=${JSON.stringify(root)};for(const name of ['owned.json','bystander.json']){let owned=[];try{owned=JSON.parse(fs.readFileSync(root+'/'+name,'utf8'));}catch{}for(const p of owned){const now=proc(p.pid);if(now&&now.start===p.start)try{process.kill(p.pid,'SIGKILL')}catch{}}}fs.rmSync(root,{recursive:true,force:true});`);
  await rm(local,{recursive:true,force:true});
 });
 const cli=root+'/cli';
 const source=`#!${node}\nconst fs=require('fs'),cp=require('child_process');${identity}
if(process.argv.includes('--version')){console.log('fixture CLI 1.0');process.exit(0)}
let p='';process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>{
if(p.startsWith('tree')){const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});fs.writeFileSync(${JSON.stringify(root+'/owned.json')},JSON.stringify([proc(c.pid)]));if(p==='tree-wait'){setInterval(()=>{},1000);return;}}
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({cwd:process.cwd(),env_names:Object.keys(process.env),args:process.argv.slice(2),home:process.env.HOME,config:process.env.CLAUDE_CONFIG_DIR})}));process.exit(0);});`;
 await remote(`import fs from 'node:fs';import cp from 'node:child_process';${identity}fs.mkdirSync(${JSON.stringify(root)},{mode:0o700});fs.writeFileSync(${JSON.stringify(cli)},${JSON.stringify(source)},{mode:0o755});const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(root+'/bystander.json')},JSON.stringify([proc(c.pid)]));c.unref();fs.symlinkSync('/tmp',${JSON.stringify(root+'/escape')});`);
 const id=(await capture('docker',['inspect','--format','{{.Id}}',container],{env})).trim();
 const mounts=JSON.parse(await capture('docker',['inspect','--format','{{json .Mounts}}',id],{env}));
 const mount=mounts.find(x=>x.Type==='bind'&&x.Destination==='/home/vscode/app');assert.ok(mount,'Explicit test target must have the expected project bind mount');
 const profile={backend:'docker',container:id,user:'vscode',root,roots:[root],node,cli,expected_mounts:[{type:'bind',source:mount.Source,target:mount.Destination}],expected_labels:{},tools:[{name:'node',command:node,args:['--version']}],env:{PATH:'/usr/bin:/bin'}};
 const config={root:local,mountedRoots:[local],dockerCommand:'docker',executionProfiles:{test:profile},env:{...env,ANTHROPIC_AUTH_TOKEN:'synthetic-fixture-token',ANTHROPIC_CUSTOM_HEADERS:'X-Fixture: synthetic-header-value',UNRELATED_SECRET:'must-not-forward',CLAUDE_MCP_TOKEN:'must-not-forward'},stateDir:join(local,'jobs'),maxOutput:16384,permissionMode:'acceptEdits',allowedTools:['Read','Grep','Glob']};
 store=new JobStore(config);
 const alive=async name=>JSON.parse(await remote(`import fs from 'node:fs';${identity}const list=JSON.parse(fs.readFileSync(${JSON.stringify(root)}+'/'+${JSON.stringify(name)},'utf8'));console.log(JSON.stringify(list.map(p=>{const now=proc(p.pid);return !!now&&now.start===p.start&&now.state!=='Z';})));`));
 return {root,store,config,remote,alive};
}

test('real Docker helper scrubs inherited auth/config and removes private stateless state',{skip:!enabled,timeout:15000},async t=>{
 const {store,remote}=await fixture(t);const job=await store.start({prompt:'environment',execution_profile:'test'});const done=await store.get(job.job_id,10000);
 assert.equal(done.status,'completed',JSON.stringify(done.error));const answer=JSON.parse(done.result.answer);
 for(const forbidden of ['UNRELATED_SECRET','CLAUDE_MCP_TOKEN','DOCKER_HOST','CLAUDECODE'])assert.ok(!answer.env_names.includes(forbidden));
 assert.ok(answer.env_names.includes('ANTHROPIC_AUTH_TOKEN'));assert.ok(answer.args.includes('--bare'));assert.ok(answer.args.includes('--setting-sources'));
 assert.equal(JSON.parse(await remote(`import fs from 'node:fs';console.log(JSON.stringify(fs.existsSync(${JSON.stringify(answer.home)})));`)),false);
 assert.equal(done.execution_context.cleanup.status,'confirmed');
});

test('real Docker helper cleans a fast-exiting leader and detached pipe holder, preserving a bystander',{skip:!enabled,timeout:15000},async t=>{
 const {store,alive}=await fixture(t);const job=await store.start({prompt:'tree-fast-exit',execution_profile:'test'});const done=await store.get(job.job_id,10000);
 assert.equal(done.status,'completed',JSON.stringify(done.error));assert.deepEqual(await alive('owned.json'),[false]);assert.deepEqual(await alive('bystander.json'),[true]);
});

test('real Docker cancel cleans its detached process tree and does not stop its container or bystander',{skip:!enabled,timeout:15000},async t=>{
 const {store,alive}=await fixture(t);const job=await store.start({prompt:'tree-wait',execution_profile:'test'});
 await new Promise(r=>setTimeout(r,250));const cancelled=await store.cancel(job.job_id);
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.execution_context.cleanup.status,'confirmed',JSON.stringify(cancelled.error));
 assert.deepEqual(await alive('owned.json'),[false]);assert.deepEqual(await alive('bystander.json'),[true]);
});

test('real target symlink escape fails before generation',{skip:!enabled,timeout:15000},async t=>{
 const {config,root}=await fixture(t);
 await assert.rejects(executionContext({execution_profile:'test',cwd:root+'/escape'},config),e=>e.details?.execution_started===false);
});

test('real remote execution deadline cleans owned processes and preserves bystanders',{skip:!enabled,timeout:15000},async t=>{
 const {store,alive}=await fixture(t);const job=await store.start({prompt:'tree-wait',execution_profile:'test',execution_timeout_ms:500});
 const done=await store.get(job.job_id,10000);assert.equal(done.status,'failed');assert.equal(done.error.code,'timeout');assert.equal(done.execution_context.cleanup.status,'confirmed');assert.deepEqual(await alive('owned.json'),[false]);assert.deepEqual(await alive('bystander.json'),[true]);
});

test('real remote shutdown confirms cleanup within the five-second close budget',{skip:!enabled,timeout:15000},async t=>{
 const {store,alive}=await fixture(t);const job=await store.start({prompt:'tree-wait',execution_profile:'test'});
 await new Promise(r=>setTimeout(r,250));const start=performance.now();await store.close();assert.ok(performance.now()-start<4500);
 const done=await store.get(job.job_id);assert.equal(done.status,'failed');assert.equal(done.error.code,'interrupted');assert.equal(done.execution_context.cleanup.status,'confirmed');assert.equal(done.error.details.cleanup.status,'confirmed');assert.deepEqual(await alive('owned.json'),[false]);assert.deepEqual(await alive('bystander.json'),[true]);
});
