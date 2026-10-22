// Container smoke: health, MCP initialize and tools/list only. Never calls models or ask.
// Run inside the image so its installed SDK is reused:
//   docker exec -i -w /opt/claude-mcp "$CID" /nodejs/bin/node --input-type=module - < scripts/smoke.mjs
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base=process.env.CLAUDE_MCP_SMOKE_URL??'http://127.0.0.1:8877';
const deadline=Date.now()+Number(process.env.CLAUDE_MCP_SMOKE_TIMEOUT_MS??60000);
const TOOLS=['models','ask','start_job','get_job','list_jobs','cancel_job','delete_job'];

let healthy=false;
while(!healthy){
 try{
  const res=await fetch(`${base}/healthz`,{signal:AbortSignal.timeout(2000)});
  healthy=res.status===200&&(await res.json()).status==='ok';
 }catch{}
 if(!healthy){
  assert.ok(Date.now()<deadline,'Timed out waiting for /healthz status ok');
  await new Promise(resolve=>setTimeout(resolve,500));
 }
}

const expected=JSON.parse(await readFile('package.json','utf8')).version;
const client=new Client({name:'claude-mcp-smoke',version:'1'});
try{
 await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
 const server=client.getServerVersion();
 assert.equal(server.name,'claude-mcp');
 assert.equal(server.version,expected,'MCP server version must equal package.json version');
 const names=(await client.listTools()).tools.map(t=>t.name);
 assert.deepEqual([...names].sort(),[...TOOLS].sort());
 console.log(JSON.stringify({smoke:'ok',version:server.version,node:process.versions.node,tools:names.length}));
}finally{
 await client.close().catch(()=>{});
}
