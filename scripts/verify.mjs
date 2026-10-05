import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const mode=process.argv[2]??'http';
if(!['http','stdio','docker-stdio'].includes(mode))throw new Error('Usage: node scripts/verify.mjs http|stdio|docker-stdio');
const repo=fileURLToPath(new URL('..',import.meta.url));
const env={...process.env};
const transport=mode==='http'
 ?new StreamableHTTPClientTransport(new URL(env.CLAUDE_MCP_URL??'http://127.0.0.1:8877/mcp'),env.CLAUDE_MCP_TOKEN?{requestInit:{headers:{Authorization:'Bearer '+env.CLAUDE_MCP_TOKEN}}}:{})
 :mode==='docker-stdio'
 ?new StdioClientTransport({command:'docker',args:['compose','exec','-T','claude-mcp','node','src/main.mjs','--transport','stdio'],cwd:env.CLAUDE_MCP_COMPOSE_DIR??repo,stderr:'pipe'})
 :new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/main.mjs',import.meta.url)),'--transport','stdio'],cwd:env.CLAUDE_MCP_WORKSPACE??repo,env,stderr:'pipe'});
const client=new Client({name:'claude-mcp-verification',version:'1'});
async function completed(result){let value=data(result);while(value.job_id&&value.status==='working')value=data(await client.callTool({name:'get_job',arguments:{job_id:value.job_id,wait_ms:10000}},undefined,{timeout:15000}));if(value.job_id){assert.equal(value.status,'completed',JSON.stringify(value));return value.result;}return value;}
function data(result){assert.ok(!result.isError,result.content?.[0]?.text);return result.structuredContent;}
try{
 await client.connect(transport);
 const names=(await client.listTools()).tools.map(t=>t.name);assert.deepEqual(names,['models','ask','start_job','get_job','list_jobs','cancel_job']);
 const list=data(await client.callTool({name:'models',arguments:{}}));assert.ok(list.models.length);
 console.log(JSON.stringify({transport:mode,tools:names,models_source:list.source,models:list.models.map(x=>x.id),execution_context:list.execution_context,warning:list.warning}));
 const marker=mode==='http'?'CLAUDE_MCP_HTTP_OK':'CLAUDE_MCP_STDIO_OK';
 const answer=await completed(await client.callTool({name:'ask',arguments:{prompt:`Reply with exactly ${marker}. Do not use tools.`,model:env.CLAUDE_MCP_VERIFY_MODEL??'sonnet',timeout_ms:120000}},undefined,{timeout:150000}));
 assert.equal(answer.answer.trim(),marker);console.log(JSON.stringify({transport:mode,ask:answer.answer.trim(),cwd:answer.cwd}));
 if(env.CLAUDE_MCP_VERIFY_FILE){
  assert.ok(env.CLAUDE_MCP_VERIFY_EXPECTED,'Set CLAUDE_MCP_VERIFY_EXPECTED for the optional package file check');
  const read=await completed(await client.callTool({name:'ask',arguments:{prompt:`Read the actual JSON package file ${env.CLAUDE_MCP_VERIFY_FILE} with the Read tool, then return only its name property. Do not guess or use a shell.`,model:env.CLAUDE_MCP_VERIFY_MODEL??'sonnet',timeout_ms:120000}},undefined,{timeout:150000}));
  assert.equal(read.answer.trim(),env.CLAUDE_MCP_VERIFY_EXPECTED);console.log(JSON.stringify({file_read:'passed',answer:read.answer.trim()}));
 }
}finally{await client.close();}
