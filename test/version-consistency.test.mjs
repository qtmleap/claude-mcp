import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startHttp} from '../src/server.mjs';
import {loadConfig} from '../src/config.mjs';

const json=async name=>JSON.parse(await readFile(new URL(`../${name}`,import.meta.url),'utf8'));

test('package, lockfile root and MCP server report one release version',async t=>{
 const pkg=await json('package.json');const lock=await json('package-lock.json');
 assert.equal(lock.version,pkg.version);
 assert.equal(lock.packages[''].version,pkg.version);
 const config=loadConfig({...process.env,CLAUDE_MCP_MODELS:'sonnet',ANTHROPIC_BASE_URL:'',PORT:'0'});
 const app=await startHttp(config);t.after(()=>app.close());
 const client=new Client({name:'version-test',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`)));t.after(()=>client.close());
 assert.equal(client.getServerVersion().version,pkg.version);
});
