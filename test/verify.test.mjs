import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.mjs';
import {startHttp} from '../src/server.mjs';
const exec=promisify(execFile);
test('portable verification script checks native HTTP and STDIO without deployment paths',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'claude-mcp-verify-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const cli=join(root,'cli');await writeFile(cli,'#!/usr/bin/env node\nlet s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:/Reply with exactly (\\w+)/.exec(s)?.[1]||"unknown"})));',{mode:0o755});
 const env={...process.env,CLAUDE_MCP_COMMAND:cli,CLAUDE_MCP_WORKSPACE:root,CLAUDE_MCP_MODELS:'sonnet',ANTHROPIC_BASE_URL:'',CLAUDE_MCP_TOKEN:'',PORT:'0'};
 delete env.CLAUDE_MCP_VERIFY_FILE;delete env.CLAUDE_MCP_VERIFY_EXPECTED;
 const app=await startHttp(loadConfig(env));t.after(()=>app.close());
 const script=fileURLToPath(new URL('../scripts/verify.mjs',import.meta.url));
 for(const mode of ['http','stdio']){
  const result=await exec(process.execPath,[script,mode],{env:{...env,CLAUDE_MCP_URL:`http://127.0.0.1:${app.port}/mcp`},timeout:10000});
  assert.match(result.stdout,mode==='http'?/CLAUDE_MCP_HTTP_OK/:/CLAUDE_MCP_STDIO_OK/);
 }
});
