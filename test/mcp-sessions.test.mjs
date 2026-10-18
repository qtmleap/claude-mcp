import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';

async function boot(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-mcp-sess-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'cli');
  await writeFile(file, '#!/usr/bin/env node\nlet p="";process.stdin.on("data",c=>p+=c);process.stdin.on("end",()=>{const a=process.argv.slice(2).find(x=>/^--(session-id|resume)=/.test(x));if(a&&process.env.CLAUDE_CONFIG_DIR){const fs=require("fs"),d=process.env.CLAUDE_CONFIG_DIR+"/projects/p";fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+"/"+a.split("=")[1]+".jsonl","{}");}console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:a?a.split("=")[1]:undefined,total_cost_usd:0.1,result:"a:"+p}))});', { mode: 0o755 });
  const config = loadConfig({ PATH: process.env.PATH, HOME: root, CLAUDE_MCP_WORKSPACE: root, CLAUDE_MCP_JOB_DIR: join(root, 'state'), CLAUDE_MCP_COMMAND: file, PORT: '0' });
  const app = await startHttp(config); t.after(() => app.close());
  const client = new Client({ name: 't', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`))); t.after(() => client.close());
  return client;
}
const call = (c, name, args) => c.callTool({ name, arguments: args });

test('tool schemas expose session/review/budget inputs and list_jobs paging inputs', async t => {
  const c = await boot(t); const tools = Object.fromEntries((await c.listTools()).tools.map(x => [x.name, x]));
  for (const n of ['ask', 'start_job']) for (const k of ['resumable', 'resume_job_id', 'review', 'max_budget_usd']) assert.ok(tools[n].inputSchema.properties[k], `${n}.${k}`);
  for (const k of ['limit', 'status', 'cursor']) assert.ok(tools.list_jobs.inputSchema.properties[k], k);
  assert.match(tools.ask.description, /manifest/i);
});

test('list_jobs pages over MCP with stable cursors and no prompt leak', async t => {
  const c = await boot(t);
  for (let i = 0; i < 5; i++) await call(c, 'ask', { prompt: 'SECRET-PROMPT-' + i });
  const a = (await call(c, 'list_jobs', { limit: 2 })).structuredContent;
  assert.equal(a.jobs.length, 2); assert.equal(a.has_more, true);
  const b = (await call(c, 'list_jobs', { limit: 100, cursor: a.next_cursor, status: 'completed' })).structuredContent;
  assert.equal(b.jobs.length, 3); assert.equal(b.has_more, false);
  assert.ok(!JSON.stringify([a, b]).includes('SECRET-PROMPT'));
  assert.equal((await call(c, 'list_jobs', { cursor: 'nope' })).isError, true);
});

test('resumable review ask returns job_id and session; continuation works end to end', async t => {
  const c = await boot(t);
  const first = (await call(c, 'ask', { prompt: 'one', model: 'm1', resumable: true, review: true })).structuredContent;
  assert.equal(first.answer, 'a:one'); assert.match(first.job_id, /^job_/); assert.equal(first.session.resume_available, true);
  const second = (await call(c, 'ask', { prompt: 'two', resume_job_id: first.job_id })).structuredContent;
  assert.equal(second.answer, 'a:two', JSON.stringify(second)); assert.equal(second.session.cli_session_id, first.session.cli_session_id);
  const stale = await call(c, 'ask', { prompt: 'three', resume_job_id: first.job_id });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.error.code, 'stale_ancestor');
});

test('invalid session arguments surface as tool errors', async t => {
  const c = await boot(t);
  const r = await call(c, 'start_job', { prompt: 'x', resumable: true });
  assert.equal(r.isError, true); assert.equal(r.structuredContent.error.code, 'model_required');
});
