import {test} from 'node:test';
import {promises as fsPromises} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.mjs';
import {JobStore} from '../src/jobs.mjs';
import {startHttp} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function fixture(t,{uncertain=false,working=false}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'claude-profiles-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const calls=join(root,'calls'),gone=join(root,'gone'),docker=join(root,'docker');
 const profile={backend:'docker',container:'registered-project',user:'1000:1000',root:'/project',roots:['/project'],node:'/usr/bin/node',cli:'/usr/bin/claude',expected_mounts:[{type:'bind',source:'/trusted/project',target:'/project'}],expected_labels:{'project.owner':'test'},tools:[{name:'python',command:'/usr/bin/python3',args:['--version']}]};
 const registry=join(root,'profiles.json');await writeFile(registry,JSON.stringify({profiles:{project:profile}}));
 await writeFile(docker,`#!/usr/bin/env node
const fs=require('fs');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args:a.filter(x=>x.length<200),env_names:Object.keys(process.env)})+'\\n');
if(a[0]==='inspect'){if(fs.existsSync(${JSON.stringify(gone)})){process.exitCode=1;return;}console.log(JSON.stringify({id:'a'.repeat(64),running:true,mounts:[{Type:'bind',Source:'/trusted/project',Destination:'/project'}],labels:{'project.owner':'test'}}));return;}
const p=JSON.parse(s);
if(p.mode==='probe'){console.log(JSON.stringify({cwd:'/project',roots:['/project'],platform:'linux',uid:1000,gid:1000,cli:{ok:true,output:'2.1.326 (Claude Code)'},tools:[{name:'python',ok:true,output:'Python 3.12.13'}]}));return;}
if(p.mode==='release'){console.log(JSON.stringify({released:true}));return;}
if(p.mode==='cancel'){console.log(JSON.stringify({nonce:p.nonce,cleanup:{status:${JSON.stringify(uncertain?'uncertain':'confirmed')}}}));return;}
if(p.mode==='run'){
console.log(JSON.stringify({type:'claude_mcp',event:'started',nonce:p.nonce,helper_pid:101,child_pid:102}));
${working?"setInterval(()=>{},1000);":"console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({cwd:p.cwd,args:p.argv,forwarded:a.filter((x,i)=>a[i-1]==='--env')})}));console.log(JSON.stringify({type:'claude_mcp',event:'finished',nonce:p.nonce,cleanup:{status:'confirmed'},exit_code:0}));"}
}
});`,{mode:0o755});
 const config=loadConfig({PATH:process.env.PATH,HOME:root,CLAUDE_MCP_WORKSPACE:root,CLAUDE_MCP_JOB_DIR:join(root,'jobs'),CLAUDE_MCP_PROFILES_FILE:registry,CLAUDE_MCP_DOCKER_COMMAND:docker,CLAUDE_MCP_MODELS:'test-model',ANTHROPIC_AUTH_TOKEN:'private-provider-fixture',ANTHROPIC_CUSTOM_HEADERS:'X-Private: private-header-fixture',CLAUDE_MCP_TOKEN:'mcp-fixture-secret',UNRELATED_SECRET:'unrelated-fixture',PORT:'0'});
 return {root,config,profile,registry,calls,gone};
}

test('profile registry validates fixed targets and rejects unknown or credential-bearing configuration',async t=>{
 const {config,registry,profile}=await fixture(t);
 assert.equal(config.executionProfiles.project.container,'registered-project');
 for(const bad of [{...profile,container:'--privileged'},{...profile,cli:'claude'},{...profile,env:{ANTHROPIC_API_KEY:'no'}},{...profile,unexpected:'no'}]){
  await writeFile(registry,JSON.stringify({profiles:{project:bad}}));
  assert.throws(()=>loadConfig({...config.env,CLAUDE_MCP_PROFILES_FILE:registry}),/profile/i);
 }
});

test('Docker jobs use target cwd and one central credential source without caller-controlled launch arguments',async t=>{
 const {config,calls}=await fixture(t);const store=new JobStore(config);t.after(()=>store.close());
 const first=await store.start({prompt:'literal $(not-a-shell)',model:'test-model',execution_profile:'project',cwd:'/project'});
 const done=await store.get(first.job_id,3000);assert.equal(done.status,'completed',JSON.stringify(done.error));
 assert.equal(done.execution_context.profile,'project');assert.equal(done.execution_context.container_id,'a'.repeat(64));
 assert.equal(done.execution_context.cleanup.status,'confirmed');assert.equal(done.result.execution_context.profile,'project');
 const answer=JSON.parse(done.result.answer);assert.equal(answer.cwd,'/project');assert.ok(answer.args.includes('--bare'));assert.ok(answer.args.includes('--no-session-persistence'));
 assert.ok(answer.forwarded.includes('ANTHROPIC_AUTH_TOKEN'));assert.ok(!answer.forwarded.includes('CLAUDE_MCP_TOKEN'));assert.ok(!answer.forwarded.includes('UNRELATED_SECRET'));
 const invocations=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(!JSON.stringify(invocations.map(c=>c.args)).includes('private-provider-fixture'));
 assert.ok(invocations.filter(c=>c.args[0]==='exec').every(c=>c.args.includes('a'.repeat(64))));
 assert.ok(invocations.every(c=>!c.env_names.includes('UNRELATED_SECRET')&&!c.env_names.includes('CLAUDE_MCP_TOKEN')));
 assert.equal((await store.page()).jobs[0].execution_context.profile,'project');
});

test('remote idempotency survives a vanished container and restart but rejects changed profile policy',async t=>{
 const {config,gone}=await fixture(t);let store=new JobStore(config);
 const args={prompt:'one invocation',execution_profile:'project',idempotency_key:'only-once'};
 const first=await store.start(args);assert.equal((await store.get(first.job_id,3000)).status,'completed');await store.close();
 await writeFile(gone,'gone');store=new JobStore(config);t.after(()=>store.close());
 assert.equal((await store.start(args)).job_id,first.job_id);
 const changed={...config,executionProfiles:{...config.executionProfiles,project:{...config.executionProfiles.project,user:'2000:2000'}}};
 const other=new JobStore(changed);t.after(()=>other.close());
 await assert.rejects(other.start(args),e=>e.code==='idempotency_conflict');
});

test('remote resume is rejected before session state allocation and unknown profiles never fall back',async t=>{
 const {config,root}=await fixture(t);const store=new JobStore(config);t.after(()=>store.close());
 await assert.rejects(store.start({prompt:'x',execution_profile:'project',resumable:true,review:true,model:'test-model'}),e=>e.code==='unsupported');
 await assert.rejects(readFile(join(root,'sessions'),'utf8'),e=>e.code==='ENOENT');
 await assert.rejects(store.start({prompt:'x',execution_profile:'unknown'}),e=>e.code==='invalid_profile');
});

test('cancel retains remote cleanup uncertainty durably instead of hiding it behind cancelled status',async t=>{
 const {config}=await fixture(t,{working:true,uncertain:true});let store=new JobStore(config);
 const first=await store.start({prompt:'x',execution_profile:'project'});
 await new Promise(resolve=>setTimeout(resolve,150));
 const cancelled=await store.cancel(first.job_id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.execution_context.cleanup.status,'uncertain');
 assert.equal(cancelled.error.details.cleanup.status,'uncertain');await store.close();
 store=new JobStore(config);t.after(()=>store.close());assert.equal((await store.get(first.job_id)).execution_context.cleanup.status,'uncertain');
});

test('read-only execution_context probes actual target tools without creating a job or invoking a model',async t=>{
 const {config}=await fixture(t);const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'contexts-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`),{requestInit:{headers:{Authorization:'Bearer mcp-fixture-secret'}}}));t.after(()=>client.close());
 const names=(await client.listTools()).tools.map(x=>x.name);assert.ok(names.includes('execution_context'));
 const result=await client.callTool({name:'execution_context',arguments:{execution_profile:'project',cwd:'/project'}});
 assert.ok(!result.isError,JSON.stringify(result));const ctx=result.structuredContent;assert.equal(ctx.status,'probed');assert.equal(ctx.platform,'linux');assert.match(ctx.tools[0].output,/Python 3.12/);
 assert.deepEqual((await client.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs,[]);
});

test('configured project mismatch fails before a receipt or generation is allocated',async t=>{
 const {config}=await fixture(t);config.executionProfiles.project.expected_mounts[0].source='/wrong/source';
 const store=new JobStore(config);t.after(()=>store.close());
 await assert.rejects(store.start({prompt:'x',execution_profile:'project'}),e=>e.code==='invalid_context'&&e.details.reason==='project_mount_mismatch'&&e.details.execution_started===false);
 assert.deepEqual((await store.page()).jobs,[]);
});

test('remote reviews receive one combined context/review note without granting extra tools',async t=>{
 const {config}=await fixture(t);const store=new JobStore(config);t.after(()=>store.close());
 const job=await store.start({prompt:'review',execution_profile:'project',review:true});const done=await store.get(job.job_id,3000);
 const args=JSON.parse(done.result.answer).args,notes=args.filter(x=>x.startsWith('--append-system-prompt='));
 assert.equal(notes.length,1);assert.match(notes[0],/code reviewer/);assert.match(notes[0],/backend=Docker/);assert.match(notes[0],/Python 3.12/);
 assert.ok(args.includes('--tools=Read,Grep,Glob'));assert.ok(args.includes('--setting-sources'));
});

test('local worker receives factual cwd/OS and unprobed tool context without additional probing',async t=>{
 const {config,root}=await fixture(t);const cli=join(root,'local-cli');
 await writeFile(cli,'#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:JSON.stringify(process.argv.slice(2))})));',{mode:0o755});
 config.command=cli;const store=new JobStore(config);t.after(()=>store.close());
 const job=await store.start({prompt:'x',review:true});const done=await store.get(job.job_id,3000);
 const args=JSON.parse(done.result.answer),notes=args.filter(x=>x.startsWith('--append-system-prompt='));
 assert.equal(notes.length,1);assert.match(notes[0],/backend=local/);assert.match(notes[0],/unprobed/);assert.ok(notes[0].includes(root));assert.match(notes[0],/code reviewer/);
});

test('restart marks remote resources uncertain and retains their exact target identity without rerunning',async t=>{
 const {config}=await fixture(t);let store=new JobStore(config);
 const job=await store.start({prompt:'x',execution_profile:'project'});const done=await store.get(job.job_id,3000);await store.close();
 const file=join(config.stateDir,job.job_id+'.json'),raw=JSON.parse(await readFile(file,'utf8'));raw.status='working';raw.result=null;raw.execution_context.cleanup={status:'pending'};await writeFile(file,JSON.stringify(raw));
 store=new JobStore(config);t.after(()=>store.close());const recovered=await store.get(job.job_id);
 assert.equal(recovered.status,'failed');assert.equal(recovered.execution_context.cleanup.status,'uncertain');assert.equal(recovered.execution_context.container_id,done.execution_context.container_id);assert.equal(recovered.error.details.cleanup.status,'uncertain');
});

test('shutdown retains the final cleanup outcome rather than its initial interruption uncertainty',async t=>{
 const {config}=await fixture(t,{working:true});const store=new JobStore(config);
 const job=await store.start({prompt:'x',execution_profile:'project'});await new Promise(r=>setTimeout(r,100));await store.close();
 const done=await store.get(job.job_id);assert.equal(done.status,'failed');assert.equal(done.error.code,'interrupted');assert.equal(done.execution_context.cleanup.status,'confirmed');assert.equal(done.error.details.cleanup.status,'confirmed');
});


test('remote cancellation during initial persistence records cleanup not required without launching',async t=>{
 const {config}=await fixture(t);let launches=0;
 const store=new JobStore(config,{run:async()=>{launches++;throw new Error('Cancelled remote runner must not launch');}});t.after(()=>store.close());
 await store.ready();
 const entered=Promise.withResolvers(),resume=Promise.withResolvers();
 const original=fsPromises.writeFile;let first=true,jobId;
 fsPromises.writeFile=async(...args)=>{
  if(first&&String(args[0]).startsWith(config.stateDir)){first=false;entered.resolve();await resume.promise;}
  return original(...args);
 };
 syncBuiltinESMExports();
 try{
  const starting=store.start({prompt:'cancel-before-launch',execution_profile:'project'});
  await entered.promise;[{job_id:jobId}]=await store.list();
  const cancelling=store.cancel(jobId);
  assert.equal((await store.get(jobId)).status,'cancelled');
  resume.resolve();await starting;await cancelling;
 }finally{resume.resolve();fsPromises.writeFile=original;syncBuiltinESMExports();}
 assert.equal(launches,0);
 const done=await store.get(jobId);
 assert.equal(done.execution_context.execution_started,false);
 assert.equal(done.execution_context.cleanup.status,'not_required');
 assert.equal(done.execution_context.resource.cleanup.status,'not_required');
 assert.equal(done.error.details.execution_started,false);
 assert.equal(done.error.details.cleanup.status,'not_required');
 await store.close();const reopened=new JobStore(config);t.after(()=>reopened.close());
 const recovered=await reopened.get(jobId);
 assert.equal(recovered.execution_context.execution_started,false);
 assert.equal(recovered.execution_context.cleanup.status,'not_required');
 assert.equal(recovered.error.details.execution_started,false);
});
