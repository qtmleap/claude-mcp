import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {loadConfig} from '../src/config.mjs';

test('structured native stream diagnostics require an explicit validated opt-in',()=>{
  assert.equal(loadConfig({}).streamDiagnostics,false);
  assert.equal(loadConfig({CLAUDE_MCP_STREAM_DIAGNOSTICS:'1'}).streamDiagnostics,true);
  for(const value of ['true','2','-1']) assert.throws(()=>loadConfig({CLAUDE_MCP_STREAM_DIAGNOSTICS:value}));
});
test('native default workspace follows the process working directory',()=>{
 const config=loadConfig({});assert.equal(config.root,process.cwd());assert.deepEqual(config.mountedRoots,[process.cwd()]);
});
test('explicit workspace remains configurable independently of platform',()=>{
 const config=loadConfig({CLAUDE_MCP_WORKSPACE:'project'});assert.equal(config.root,resolve('project'));
});
test('session idle TTL and max sessions have defaults and validated ranges',()=>{
 const config=loadConfig({});assert.equal(config.sessionIdleMs,300000);assert.equal(config.maxSessions,64);
 const custom=loadConfig({CLAUDE_MCP_SESSION_IDLE_MS:'1000',CLAUDE_MCP_MAX_SESSIONS:'1024'});
 assert.equal(custom.sessionIdleMs,1000);assert.equal(custom.maxSessions,1024);
 for(const env of [{CLAUDE_MCP_SESSION_IDLE_MS:'999'},{CLAUDE_MCP_SESSION_IDLE_MS:'86400001'},{CLAUDE_MCP_MAX_SESSIONS:'0'},{CLAUDE_MCP_MAX_SESSIONS:'1025'}])
  assert.throws(()=>loadConfig(env),/Invalid CLAUDE_MCP_(SESSION_IDLE_MS|MAX_SESSIONS)/);
});
