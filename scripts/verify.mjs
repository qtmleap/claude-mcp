import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const mode=process.argv[2]??'http';
const transport=mode==='stdio'
 ?new StdioClientTransport({command:'docker',args:['compose','exec','-T','claude-mcp','node','src/main.mjs','--transport','stdio'],cwd:process.env.LOCALGPT_COMPOSE_DIR??'/Users/devonly/Developer/local-gpt',stderr:'pipe'})
 :new StreamableHTTPClientTransport(new URL(process.env.CLAUDE_MCP_URL??'http://127.0.0.1:8877/mcp'));
const client=new Client({name:'claude-mcp-verification',version:'1'});
function data(result){assert.ok(!result.isError,result.content?.[0]?.text);return result.structuredContent;}
try{
 await client.connect(transport);
 const names=(await client.listTools()).tools.map(t=>t.name);assert.deepEqual(names,['models','ask']);
 const list=data(await client.callTool({name:'models',arguments:{}}));assert.ok(list.models.length);
 console.log(JSON.stringify({transport:mode,tools:names,models_source:list.source,models:list.models.map(x=>x.id),warning:list.warning}));
 const marker=mode==='stdio'?'CLAUDE_MCP_STDIO_OK':'CLAUDE_MCP_HTTP_OK';
 const answer=data(await client.callTool({name:'ask',arguments:{prompt:`Reply with exactly ${marker}. Do not use tools.`,model:process.env.CLAUDE_MCP_VERIFY_MODEL??'sonnet',timeout_ms:120000}},undefined,{timeout:150000}));
 assert.equal(answer.answer.trim(),marker);console.log(JSON.stringify({transport:mode,ask:answer.answer.trim(),cwd:answer.cwd}));
 if(mode==='http'){
  const target='/Users/devonly/Developer/claude-mcp/package.json';
  const read=data(await client.callTool({name:'ask',arguments:{prompt:`Read the actual host file ${target} with the Read tool, then return only the package name. Do not guess or use a shell.`,model:process.env.CLAUDE_MCP_VERIFY_MODEL??'sonnet',cwd:'claude-mcp',timeout_ms:120000}},undefined,{timeout:150000}));
  assert.equal(read.answer.trim(),'claude-mcp');console.log(JSON.stringify({absolute_file:target,answer:read.answer.trim(),cwd:read.cwd}));
  const bad=await client.callTool({name:'ask',arguments:{prompt:'Do not execute anything',cwd:'/not-mounted/does-not-exist'}});assert.equal(bad.isError,true);console.log('PASS: invalid cwd rejected before execution');
 }
}finally{await client.close();}
