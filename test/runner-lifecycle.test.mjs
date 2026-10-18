import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAsk } from '../src/runner.mjs';

async function fixture(context, code) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-lifecycle-')));
  const command = join(root, 'cli');
  const pids = join(root, 'pids');
  await writeFile(command, '#!/usr/bin/env node\n' + code, { mode: 0o755 });
  context.after(async () => {
    const owned = JSON.parse(await readFile(pids, 'utf8').catch(() => '[]'));
    for (const pid of owned) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, command, env: { ...process.env }, maxOutput: 2 * 1024 * 1024, permissionMode: 'acceptEdits', allowedTools: [] };
}

const holder = `const fs=require('fs'),cp=require('child_process');
const holder=cp.spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{detached:true,stdio:['ignore',1,2]});
fs.writeFileSync('pids',JSON.stringify([holder.pid]));holder.unref();`;
const success = `JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'})`;

test('leader exit settles without waiting for an escaped inherited pipe', { timeout: 4000 }, async context => {
  const config = await fixture(context, holder + `process.stdout.write(${success}+'\\n',()=>process.exit(0));`);
  const result = await runAsk({ prompt: 'synthetic' }, config, undefined, { stream: true });
  assert.equal(result.answer, 'done');
});

test('inherited pipe cleanup preserves a natural nonzero exit', { timeout: 4000 }, async context => {
  const config = await fixture(context, holder + `process.stdout.write(${success}+'\\n',()=>process.exit(7));`);
  await assert.rejects(runAsk({ prompt: 'synthetic' }, config, undefined, { stream: true }), error => error.code === 'claude_exit' && /code 7/.test(error.message));
});

test('inherited pipe cleanup drains a large result written before exit', { timeout: 4000 }, async context => {
  const config = await fixture(context, holder + `process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'x'.repeat(900000)}),()=>process.exit(0));`);
  const result = await runAsk({ prompt: 'synthetic' }, config, undefined, { stream: true });
  assert.equal(result.answer.length, 900000);
});

test('cancellation settles after leader exit even when an escaped holder keeps pipes open', { timeout: 4000 }, async context => {
  const config = await fixture(context, holder + `setTimeout(()=>process.exit(0),40);`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  context.after(() => clearTimeout(timer));
  await assert.rejects(runAsk({ prompt: 'synthetic' }, config, controller.signal, { stream: true }), error => error.code === 'cancelled');
});

test('a valid terminal result cannot hold a live print process forever', { timeout: 8000 }, async context => {
  const config = await fixture(context, `require('fs').writeFileSync('pids',JSON.stringify([process.pid]));console.log(${success});setInterval(()=>{},1000);`);
  await assert.rejects(runAsk({ prompt: 'synthetic' }, config, undefined, { stream: true }), error => error.code === 'cli_shutdown_timeout');
});

test('JSON print mode also detects a terminal result followed by a lingering process', { timeout: 8000 }, async context => {
  const config = await fixture(context, `require('fs').writeFileSync('pids',JSON.stringify([process.pid]));console.log(${success});setInterval(()=>{},1000);`);
  await assert.rejects(runAsk({ prompt: 'synthetic' }, config), error => error.code === 'cli_shutdown_timeout');
});

test('natural exit stops the execution deadline while inherited pipes are closing', { timeout: 4000 }, async context => {
  const config = await fixture(context, holder + `process.stdout.write(${success}+'\\n',()=>process.exit(0));`);
  assert.equal((await runAsk({ prompt: 'synthetic', timeout_ms: 250 }, config, undefined, { stream: true })).answer, 'done');
});

test('a later result cannot replace the first terminal result', async context => {
  const config = await fixture(context, `console.log(${success});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'replacement'}));`);
  assert.equal((await runAsk({ prompt: 'synthetic' }, config, undefined, { stream: true })).answer, 'done');
});

test('generation without a terminal result is not stopped by cleanup timers', { timeout: 8000 }, async context => {
  const config = await fixture(context, `setTimeout(()=>console.log(${success}),5500);`);
  assert.equal((await runAsk({ prompt: 'synthetic' }, config, undefined, { stream: true })).answer, 'done');
});
