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
 return loadConfig({...process.env,CLAUDE_MCP_WORKSPACE:root,CLAUDE_MCP_COMMAND:file,CLAUDE_MCP_MODELS:'gateway/model-a,gateway/model-b',ANTHROPIC_BASE_URL:'',PORT:'0'});
}
test('HTTP initialization, two tools, configured models and completed ask',async t=>{
 const config=await cfg(t);const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>client.close());
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['models','ask']);
 assert.equal((await client.callTool({name:'models',arguments:{}})).structuredContent.source,'configured');
 const answer=await client.callTool({name:'ask',arguments:{prompt:'hello',model:'custom/anything'}});
 assert.equal(answer.structuredContent.answer,'answer:hello');
 assert.equal(answer.structuredContent.model,'custom/anything');
 const bad=await client.callTool({name:'ask',arguments:{prompt:'hello',cwd:'missing'}});assert.equal(bad.isError,true);
});
test('STDIO is protocol-only and supports the same tools',async t=>{
 const config=await cfg(t);const transport=new StdioClientTransport({command:process.execPath,args:['src/main.mjs','--transport','stdio'],cwd:process.cwd(),env:{...process.env,CLAUDE_MCP_WORKSPACE:config.root,CLAUDE_MCP_COMMAND:config.command,CLAUDE_MCP_MODELS:'sonnet',ANTHROPIC_BASE_URL:''},stderr:'pipe'});
 const client=new Client({name:'stdio-test',version:'1'});await client.connect(transport);t.after(()=>client.close());
 assert.equal((await client.listTools()).tools.length,2);
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

test('HTTP disconnect and service shutdown terminate running Claude processes',async t=>{
 const config=await cfg(t);
 await writeFile(config.command,'#!/usr/bin/env node\nrequire("fs").writeFileSync("active-pid",String(process.pid));setInterval(()=>{},1000);',{mode:0o755});
 const {readFile}=await import('node:fs/promises');
 for(const kind of ['disconnect','shutdown']){
  const app=await startHttp(config);const controller=new AbortController();
  const init=await fetch(`http://127.0.0.1:${app.port}/mcp`,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'disconnect-test',version:'1'}}})});
  const session=init.headers.get('mcp-session-id');await init.text();
  const pending=fetch(`http://127.0.0.1:${app.port}/mcp`,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26','Mcp-Session-Id':session},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ask',arguments:{prompt:'wait'}}})}).then(async r=>{await r.text();}).catch(()=>{});
  let pid;
  for(let i=0;i<50;i++){try{pid=Number(await readFile(join(config.root,'active-pid'),'utf8'));break;}catch{await new Promise(r=>setTimeout(r,10));}}
  assert.ok(pid,'CLI started');
  if(kind==='disconnect')controller.abort();else await app.close();
  await pending;
  let alive=true;for(let i=0;i<50;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,10));}catch(e){if(e.code==='ESRCH'){alive=false;break;}throw e;}}
  assert.equal(alive,false,kind+' must stop CLI');
  await app.close();await rm(join(config.root,'active-pid'));
 }
});

test('SDK deadline cancellation stops the original HTTP Claude call',async t=>{
 const config=await cfg(t);
 await writeFile(config.command,'#!/usr/bin/env node\nrequire("fs").writeFileSync("cancel-pid",String(process.pid));setInterval(()=>{},1000);',{mode:0o755});
 const {readFile}=await import('node:fs/promises');
 const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'cancel-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>client.close());
 await assert.rejects(client.callTool({name:'ask',arguments:{prompt:'wait'}},undefined,{timeout:150}));
 const pid=Number(await readFile(join(config.root,'cancel-pid'),'utf8'));
 let alive=true;for(let i=0;i<50;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,10));}catch(e){if(e.code==='ESRCH'){alive=false;break;}throw e;}}
 assert.equal(alive,false,'SDK cancellation must stop CLI without client.close');
});

test('repeated reconnects do not exhaust idle session capacity',async t=>{
 const config=await cfg(t);const app=await startHttp(config);t.after(()=>app.close());
 for(let i=0;i<66;i++){
  const client=new Client({name:'reconnect-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));
  assert.equal((await client.listTools()).tools.length,2);await client.close();
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
