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
async function cfg(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'claude-mcp-transport-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'cli');await writeFile(file,'#!/usr/bin/env node\nlet p="";process.stdin.on("data",c=>p+=c);process.stdin.on("end",()=>console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"answer:"+p})));',{mode:0o755});
 return loadConfig({...process.env,CLAUDE_MCP_WORKSPACE:root,CLAUDE_MCP_JOB_DIR:join(root,'state'),CLAUDE_MCP_COMMAND:file,CLAUDE_MCP_MODELS:'gateway/model-a,gateway/model-b',ANTHROPIC_BASE_URL:'',PORT:'0'});
}
test('HTTP initialization, two tools, configured models and completed ask',async t=>{
 const config=await cfg(t);const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>client.close());
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['models','ask','start_job','get_job','list_jobs','cancel_job']);
 assert.equal((await client.callTool({name:'models',arguments:{}})).structuredContent.source,'configured');
 const answer=await client.callTool({name:'ask',arguments:{prompt:'hello',model:'custom/anything'}});
 assert.equal(answer.structuredContent.answer,'answer:hello');
 assert.equal(answer.structuredContent.model,'custom/anything');
 const bad=await client.callTool({name:'ask',arguments:{prompt:'hello',cwd:'missing'}});assert.equal(bad.isError,true);
});
test('STDIO is protocol-only and supports the same tools',async t=>{
 const config=await cfg(t);const transport=new StdioClientTransport({command:process.execPath,args:['src/main.mjs','--transport','stdio'],cwd:process.cwd(),env:{...process.env,CLAUDE_MCP_WORKSPACE:config.root,CLAUDE_MCP_JOB_DIR:join(config.root,'stdio-state'),CLAUDE_MCP_COMMAND:config.command,CLAUDE_MCP_MODELS:'sonnet',ANTHROPIC_BASE_URL:''},stderr:'pipe'});
 const client=new Client({name:'stdio-test',version:'1'});await client.connect(transport);t.after(()=>client.close());
 assert.equal((await client.listTools()).tools.length,6);
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
  assert.equal((await client.listTools()).tools.length,6);await client.close();
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
 const error=await client.callTool({name:'ask',arguments:{prompt:'1+1',cwd:'/foreign-host/not-mounted'}});
 assert.equal(error.isError,true);
 assert.equal(error.structuredContent.error.code,'invalid_cwd');
 assert.equal(error.structuredContent.error.details.reason,'path_not_found');
 assert.equal(error.structuredContent.error.details.execution_started,false);
 assert.equal(error.structuredContent.error.details.default_cwd,config.root);
 const valid=await client.callTool({name:'ask',arguments:{prompt:'1+1'}});assert.equal(valid.structuredContent.answer,'answer:1+1');
});
