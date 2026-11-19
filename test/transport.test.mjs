import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startHttp} from '../src/server.mjs';
import {loadConfig} from '../src/config.mjs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {spawnSync} from 'node:child_process';
async function cfg(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'claude-mcp-transport-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'cli');await writeFile(file,'#!/usr/bin/env node\nlet p="";process.stdin.on("data",c=>p+=c);process.stdin.on("end",()=>console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"answer:"+p})));',{mode:0o755});
 return loadConfig({...process.env,CLAUDE_MCP_WORKSPACE:root,CLAUDE_MCP_JOB_DIR:join(root,'state'),CLAUDE_MCP_COMMAND:file,CLAUDE_MCP_MODELS:'gateway/model-a,gateway/model-b',ANTHROPIC_BASE_URL:'',PORT:'0'});
}
test('HTTP initialization, tools, configured models and completed ask',async t=>{
 const config=await cfg(t);const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>client.close());
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['models','ask','start_job','get_job','list_jobs','cancel_job','delete_job']);
 assert.equal((await client.callTool({name:'models',arguments:{}})).structuredContent.source,'configured');
 const answer=await client.callTool({name:'ask',arguments:{prompt:'hello',model:'custom/anything'}});
 assert.equal(answer.structuredContent.answer,'answer:hello');
 assert.equal(answer.structuredContent.model,'custom/anything');
 const bad=await client.callTool({name:'ask',arguments:{prompt:'hello',cwd:'missing'}});assert.equal(bad.isError,true);
});
test('STDIO is protocol-only and supports the same tools',async t=>{
 const config=await cfg(t);const transport=new StdioClientTransport({command:process.execPath,args:['src/main.mjs','--transport','stdio'],cwd:process.cwd(),env:{...process.env,CLAUDE_MCP_WORKSPACE:config.root,CLAUDE_MCP_JOB_DIR:join(config.root,'stdio-state'),CLAUDE_MCP_COMMAND:config.command,CLAUDE_MCP_MODELS:'sonnet',ANTHROPIC_BASE_URL:''},stderr:'pipe'});
 const client=new Client({name:'stdio-test',version:'1'});await client.connect(transport);t.after(()=>client.close());
 assert.equal((await client.listTools()).tools.length,7);
 assert.equal((await client.callTool({name:'ask',arguments:{prompt:'stdio'}})).structuredContent.answer,'answer:stdio');
});
test('optional MCP auth and host validation guard HTTP',async t=>{
 const config=await cfg(t);config.token='optional-test-token';const app=await startHttp(config);t.after(()=>app.close());
 assert.equal((await fetch(`http://127.0.0.1:${app.port}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
 const status=await new Promise(resolve=>{const req=request({hostname:'127.0.0.1',port:app.port,path:'/mcp',method:'POST',headers:{Host:'evil.example',Authorization:'Bearer optional-test-token','content-type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});req.end('{}');});
 assert.equal(status,403);
});

test('foreign browser Origin cannot invoke unauthenticated MCP',async t=>{
 const config=await cfg(t);const app=await startHttp(config);t.after(()=>app.close());
 assert.equal((await fetch(`http://127.0.0.1:${app.port}/mcp`,{method:'POST',headers:{Origin:'https://evil.example','content-type':'application/json'},body:'{}'})).status,403);
});

test('HTTP ask disconnect leaves job running and recoverable across sessions',async t=>{
 const config=await cfg(t);await writeFile(config.command,'#!/usr/bin/env node\nsetTimeout(()=>console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"survived"})),200);',{mode:0o755});
 const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'detach-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));
 const receipt=(await client.callTool({name:'ask',arguments:{prompt:'wait',wait_ms:0}})).structuredContent;
 assert.equal(receipt.status,'working');await client.close();
 const next=new Client({name:'recover-test',version:'1'});await next.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>next.close());
 const done=(await next.callTool({name:'get_job',arguments:{job_id:receipt.job_id,wait_ms:1000}})).structuredContent;
 assert.equal(done.status,'completed');assert.equal(done.result.answer,'survived');
});
test('SDK deadline cancels wait only; explicit cancel_job stops generation',async t=>{
 const config=await cfg(t);await writeFile(config.command,'#!/usr/bin/env node\nrequire("fs").writeFileSync("async-pid",String(process.pid));setInterval(()=>{},1000);',{mode:0o755});
 const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'cancel-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>client.close());
 await assert.rejects(client.callTool({name:'ask',arguments:{prompt:'wait',wait_ms:1000}},undefined,{timeout:100}));
 const listed=(await client.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs;
 assert.equal(listed[0].status,'working');
 const cancelled=(await client.callTool({name:'cancel_job',arguments:{job_id:listed[0].job_id}})).structuredContent;
 assert.equal(cancelled.status,'cancelled');
 const {readFile}=await import('node:fs/promises');const pid=Number(await readFile(join(config.root,'async-pid'),'utf8'));
 assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('repeated reconnects do not exhaust idle session capacity',async t=>{
 const config=await cfg(t);const app=await startHttp(config);t.after(()=>app.close());
 for(let i=0;i<66;i++){
  const client=new Client({name:'reconnect-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));
  assert.equal((await client.listTools()).tools.length,7);await client.close();
 }
});

test('unsupported batch calls are rejected before execution',async t=>{
 const config=await cfg(t);const app=await startHttp(config);t.after(()=>app.close());
 await writeFile(config.command,'#!/usr/bin/env node\nrequire("fs").writeFileSync("batch-ran","yes");console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"done"}));',{mode:0o755});
 const client=new Client({name:'batch-test',version:'1'});const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`));await client.connect(transport);t.after(()=>client.close());
 const response=await fetch(`http://127.0.0.1:${app.port}/mcp`,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json, text/event-stream','Mcp-Session-Id':transport.sessionId},body:JSON.stringify([{jsonrpc:'2.0',id:50,method:'tools/call',params:{name:'ask',arguments:{prompt:'batch'}}}])});
 assert.equal(response.status,400);const {stat}=await import('node:fs/promises');await assert.rejects(stat(join(config.root,'batch-ran')));
});

test('MCP advertises its cwd context and returns actionable pre-execution errors',async t=>{
 const config=await cfg(t);const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'cwd-context-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>client.close());
 const models=await client.callTool({name:'models',arguments:{}});
 assert.equal(models.structuredContent.execution_context.default_cwd,config.root);
 assert.deepEqual(models.structuredContent.execution_context.mounted_roots,[config.root]);
 assert.equal(models.structuredContent.execution_context.permission_mode,config.permissionMode);
 assert.deepEqual(models.structuredContent.execution_context.allowed_tools,config.allowedTools);
 const error=await client.callTool({name:'ask',arguments:{prompt:'1+1',cwd:'/foreign-host/not-mounted'}});
 assert.equal(error.isError,true);
 assert.equal(error.structuredContent.error.code,'invalid_cwd');
 assert.equal(error.structuredContent.error.details.reason,'path_not_found');
 assert.equal(error.structuredContent.error.details.execution_started,false);
 assert.equal(error.structuredContent.error.details.default_cwd,config.root);

test('delete_job over MCP removes terminal jobs, rejects active ones; list_jobs is summary-only',async t=>{
 const config=await cfg(t);const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'delete-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>client.close());
 const done=(await client.callTool({name:'ask',arguments:{prompt:'hi'}})).structuredContent;assert.equal(done.answer,'answer:hi');
 const listed=(await client.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs;
 assert.equal(listed.length,1);assert.equal('result' in listed[0],false);assert.equal('partial_answer' in listed[0],false);
 const removed=await client.callTool({name:'delete_job',arguments:{job_id:listed[0].job_id}});
 assert.deepEqual(removed.structuredContent,{job_id:listed[0].job_id,deleted:true});
 assert.deepEqual((await client.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs,[]);
 const again=await client.callTool({name:'delete_job',arguments:{job_id:listed[0].job_id}});
 assert.equal(again.isError,true);assert.equal(again.structuredContent.error.code,'not_found');
});

test('two STDIO processes sharing a state directory stay isolated',async t=>{
 const config=await cfg(t);await writeFile(config.command,'#!/usr/bin/env node\nsetInterval(()=>{},1000);',{mode:0o755});
 const {readdir}=await import('node:fs/promises');const shared=join(config.root,'shared-state');
 const connect=async name=>{
  const transport=new StdioClientTransport({command:process.execPath,args:['src/main.mjs','--transport','stdio'],cwd:process.cwd(),env:{...process.env,CLAUDE_MCP_WORKSPACE:config.root,CLAUDE_MCP_JOB_DIR:shared,CLAUDE_MCP_COMMAND:config.command,CLAUDE_MCP_MODELS:'sonnet',ANTHROPIC_BASE_URL:''},stderr:'pipe'});
  const client=new Client({name,version:'1'});await client.connect(transport);t.after(()=>client.close());return client;
 };
 const a=await connect('stdio-a');
 const receiptA=(await a.callTool({name:'ask',arguments:{prompt:'a',wait_ms:0}})).structuredContent;assert.equal(receiptA.status,'working');
 const b=await connect('stdio-b');
 const receiptB=(await b.callTool({name:'start_job',arguments:{prompt:'b'}})).structuredContent;
 const listB=(await b.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs.map(j=>j.job_id);
 assert.deepEqual(listB,[receiptB.job_id]);
 const foreign=await b.callTool({name:'cancel_job',arguments:{job_id:receiptA.job_id}});assert.equal(foreign.isError,true);
 assert.equal((await a.callTool({name:'get_job',arguments:{job_id:receiptA.job_id}})).structuredContent.status,'working');
 assert.equal((await a.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs.length,1);
 const runs=await readdir(join(shared,'stdio'));assert.equal(runs.length,2);
 assert.equal((await a.callTool({name:'cancel_job',arguments:{job_id:receiptA.job_id}})).structuredContent.status,'cancelled');
 assert.equal((await b.callTool({name:'get_job',arguments:{job_id:receiptB.job_id}})).structuredContent.status,'working');
 await b.callTool({name:'cancel_job',arguments:{job_id:receiptB.job_id}});
});

test('ask cancelled by another HTTP session is an MCP error with job_id; get_job stays a snapshot',async t=>{
 const config=await cfg(t);await writeFile(config.command,'#!/usr/bin/env node\nsetInterval(()=>{},1000);',{mode:0o755});
 const app=await startHttp(config);t.after(()=>app.close());
 const mk=async name=>{const c=new Client({name,version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>c.close());return c;};
 const a=await mk('ask-a'),b=await mk('ask-b');
 const pending=a.callTool({name:'ask',arguments:{prompt:'wait',wait_ms:20000}});
 let id;for(let i=0;i<100&&!id;i++){await new Promise(r=>setTimeout(r,50));id=(await b.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs[0]?.job_id;}
 assert.ok(id);await b.callTool({name:'cancel_job',arguments:{job_id:id}});
 const ask=await pending;assert.equal(ask.isError,true);
 assert.equal(ask.structuredContent.error.code,'cancelled');assert.equal(ask.structuredContent.error.details.job_id,id);
 const got=await b.callTool({name:'get_job',arguments:{job_id:id}});assert.notEqual(got.isError,true);assert.equal(got.structuredContent.status,'cancelled');
});
 const valid=await client.callTool({name:'ask',arguments:{prompt:'1+1'}});assert.equal(valid.structuredContent.answer,'answer:1+1');
});

test('active call outlives idle TTL; idle clock restarts at response end; idle sessions expire but jobs remain',async t=>{
 const config=await cfg(t);config.sessionIdleMs=300;
 await writeFile(config.command,'#!/usr/bin/env node\nsetTimeout(()=>console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"slow"})),700);',{mode:0o755});
 const app=await startHttp(config);t.after(()=>app.close());
 const url=new URL(`http://127.0.0.1:${app.port}/mcp`);
 const client=new Client({name:'ttl-test',version:'1'});const transport=new StreamableHTTPClientTransport(url);await client.connect(transport);t.after(()=>client.close());
 const answer=await client.callTool({name:'ask',arguments:{prompt:'slow',wait_ms:5000}});
 assert.equal(answer.structuredContent.answer,'slow');
 await new Promise(r=>setTimeout(r,150));
 const listed=(await client.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs;
 assert.equal(listed.length,1);
 await new Promise(r=>setTimeout(r,900));
 const stale=await fetch(url,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json, text/event-stream','Mcp-Session-Id':transport.sessionId},body:JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/list'})});
 assert.equal(stale.status,404);
 const next=new Client({name:'ttl-next',version:'1'});await next.connect(new StreamableHTTPClientTransport(url));t.after(()=>next.close());
 const got=(await next.callTool({name:'get_job',arguments:{job_id:listed[0].job_id}})).structuredContent;
 assert.equal(got.status,'completed');assert.equal(got.result.answer,'slow');
});

test('maxSessions bounds protocol sessions and rejects when all are in flight',async t=>{
 const config=await cfg(t);config.maxSessions=1;
 await writeFile(config.command,'#!/usr/bin/env node\nsetInterval(()=>{},1000);',{mode:0o755});
 const app=await startHttp(config);t.after(()=>app.close());
 const url=new URL(`http://127.0.0.1:${app.port}/mcp`);
 const a=new Client({name:'max-a',version:'1'});await a.connect(new StreamableHTTPClientTransport(url));t.after(()=>a.close());
 const long=a.callTool({name:'ask',arguments:{prompt:'x',wait_ms:30000}}).catch(()=>{});
 await new Promise(r=>setTimeout(r,300));
 const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'b',version:'1'}}})});
 assert.equal(res.status,503);
 const listed=(await a.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs;
 for(const j of listed)await a.callTool({name:'cancel_job',arguments:{job_id:j.job_id}});await long;
});

test('a pending initialization reserves capacity before the transport connects',async t=>{
 const config=await cfg(t);config.maxSessions=1;
 const app=await startHttp(config);t.after(()=>app.close());
 const entered=Promise.withResolvers();const resume=Promise.withResolvers();
 const connect=McpServer.prototype.connect;
 t.mock.method(McpServer.prototype,'connect',async function(...args){
  entered.resolve();await resume.promise;return connect.apply(this,args);
 });
 const url=`http://127.0.0.1:${app.port}/mcp`;
 const init=()=>fetch(url,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'pending-test',version:'1'}}})});
 const first=init();
 try{
  await entered.promise;
  const blocked=await Promise.all(Array.from({length:4},init));
  await Promise.all(blocked.map(r=>r.text()));
  assert.deepEqual(blocked.map(r=>r.status),[503,503,503,503]);
 }finally{resume.resolve();}
 const admitted=await first;await admitted.text();assert.equal(admitted.status,200);
});

test('a transport connect failure returns an error and frees admission without crashing the service',()=>{
 const script=`
  import {mkdtemp,rm} from 'node:fs/promises';
  import {tmpdir} from 'node:os';import {join} from 'node:path';
  import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
  import {startHttp} from './src/server.mjs';import {loadConfig} from './src/config.mjs';
  const state=await mkdtemp(join(tmpdir(),'claude-connect-failure-'));
  const config=loadConfig({PORT:'0',CLAUDE_MCP_WORKSPACE:process.cwd(),CLAUDE_MCP_JOB_DIR:state,CLAUDE_MCP_MAX_SESSIONS:'1'});
  const connect=McpServer.prototype.connect;let fail=true;
  McpServer.prototype.connect=async function(...args){if(fail){fail=false;throw Error('fixture connect failure');}return connect.apply(this,args);};
  const app=await startHttp(config);
  try{
   const init=()=>fetch('http://127.0.0.1:'+app.port+'/mcp',{method:'POST',headers:{'content-type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'failure-test',version:'1'}}})});
   const failed=await init();const error=await failed.json();
   const recovered=await init();await recovered.text();
   console.log(JSON.stringify({failed:failed.status,message:error.error.message,recovered:recovered.status}));
  }finally{await app.close();await rm(state,{recursive:true,force:true});}
 `;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout.trim()),{failed:500,message:'MCP request failed',recovered:200});
});

test('session with an in-flight request is not idle-expired even if JSON-RPC ids collide',async t=>{
 const config=await cfg(t);config.sessionIdleMs=100;
 await writeFile(config.command,'#!/usr/bin/env node\nsetInterval(()=>{},1000);',{mode:0o755});
 const app=await startHttp(config);t.after(()=>app.close());
 const url=new URL(`http://127.0.0.1:${app.port}/mcp`);
 const client=new Client({name:'dup',version:'1'});const transport=new StreamableHTTPClientTransport(url);await client.connect(transport);t.after(()=>client.close());
 const hdr={'content-type':'application/json',Accept:'application/json, text/event-stream','Mcp-Session-Id':transport.sessionId};
 const ctl=new AbortController();
 const first=fetch(url,{method:'POST',headers:hdr,signal:ctl.signal,body:JSON.stringify({jsonrpc:'2.0',id:77,method:'tools/call',params:{name:'ask',arguments:{prompt:'x',wait_ms:30000}}})}).catch(()=>{});
 await new Promise(r=>setTimeout(r,100));
 await (await fetch(url,{method:'POST',headers:hdr,body:JSON.stringify({jsonrpc:'2.0',id:77,method:'tools/call',params:{name:'list_jobs',arguments:{}}})})).text();
 await new Promise(r=>setTimeout(r,500)); // several idle TTLs while the first call is still in flight
 const alive=await fetch(url,{method:'POST',headers:hdr,body:JSON.stringify({jsonrpc:'2.0',id:78,method:'tools/list'})});await alive.text();
 assert.equal(alive.status,200);
 const listed=(await client.callTool({name:'list_jobs',arguments:{}})).structuredContent.jobs;
 for(const j of listed)await client.callTool({name:'cancel_job',arguments:{job_id:j.job_id}});
 ctl.abort();await first;
});
