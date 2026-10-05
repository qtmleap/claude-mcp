import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, realpath, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.mjs';
import { RunnerError } from '../src/runner.mjs';

const SECRET = 'private-test-token';
const PROMPT = 'PROMPT-SHOULD-NOT-PERSIST';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const keys = ['job_id','status','created_at','updated_at','model','cwd','partial_answer','result','error'];

async function setup(t, extra = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claude-jobs-')));
  t.after(async () => { await sleep(30); await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const root = join(base, 'root'); await mkdir(root);
  const config = { root, command: 'unused', timeoutMs: 1000, maxOutput: 1000, permissionMode: 'acceptEdits',
    allowedTools: [], env: { ...process.env, ANTHROPIC_AUTH_TOKEN: SECRET }, stateDir: join(base, 'state'), ...extra };
  return { base, root, config };
}
function fakeRun() {
  const calls = [];
  const run = (args, config, signal, options) => new Promise((resolve, reject) => {
    const call = { args, config, signal, options, resolve, reject };
    signal.addEventListener('abort', () => call.onAbort?.(), { once: true });
    call.onAbort = () => setImmediate(() => reject(new RunnerError('cancelled', 'aborted')));
    calls.push(call);
  });
  return { run, calls };
}
async function open(t, config, run) {
  const store = new JobStore(config, { run });
  await store.ready();
  t.after(() => store.close());
  return store;
}
const files = config => readdir(config.stateDir).then(f => f.filter(n => n.endsWith('.json')));

test('start validates cwd before execution and returns redacted working snapshot', async t => {
  const { config } = await setup(t);
  const { run, calls } = fakeRun();
  const store = await open(t, config, run);
  await assert.rejects(store.start({ prompt: PROMPT, cwd: 'missing' }), e => e.code === 'invalid_cwd');
  assert.equal(calls.length, 0);
  assert.deepEqual(await files(config), []);
  const snap = await store.start({ prompt: PROMPT, model: 'm1' });
  assert.deepEqual(Object.keys(snap).sort(), [...keys].sort());
  assert.equal(snap.status, 'working'); assert.match(snap.job_id, /^job_/);
  assert.equal(snap.model, 'm1'); assert.equal(snap.cwd, config.root);
  await sleep(10);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.prompt, PROMPT);
  assert.equal(calls[0].args.cwd, config.root);
  assert.deepEqual(calls[0].options.stream, true);
  assert.equal(typeof calls[0].options.onProgress, 'function');
});

test('execution_timeout_ms maps to timeout_ms; default is effectively no deadline', async t => {
  const { config } = await setup(t);
  const { run, calls } = fakeRun();
  const store = await open(t, config, run);
  await store.start({ prompt: 'a', execution_timeout_ms: 5000 });
  await store.start({ prompt: 'b' });
  await sleep(10);
  assert.equal(calls[0].args.timeout_ms, 5000);
  assert.equal('execution_timeout_ms' in calls[0].args, false);
  assert.equal(calls[1].args.timeout_ms,0);
});

test('progress accumulates safe text, completion stores result, no prompt persisted', async t => {
  const { config } = await setup(t);
  const { run, calls } = fakeRun();
  const store = await open(t, config, run);
  const { job_id } = await store.start({ prompt: PROMPT });
  await sleep(10);
  calls[0].options.onProgress({ partial_answer: `hello ${SECRET}` });
  const mid = await store.get(job_id);
  assert.equal(mid.status, 'working'); assert.equal(mid.partial_answer, 'hello [redacted]');
  calls[0].resolve({ answer: 'done', model: null, cwd: config.root, duration_ms: 3 });
  const done = await store.get(job_id, 1000);
  assert.equal(done.status, 'completed'); assert.equal(done.result.answer, 'done');
  assert.deepEqual(Object.keys(done).sort(), [...keys].sort());
  calls[0].options.onProgress({ partial_answer: 'late' });
  assert.notEqual((await store.get(job_id)).partial_answer, 'late');
  const text = await readFile(join(config.stateDir, (await files(config))[0]), 'utf8');
  assert.ok(!text.includes(PROMPT)); assert.ok(!text.includes(SECRET));
  assert.equal((await store.list()).length, 1);
});

test('get waits boundedly without cancelling and wakes early on completion', async t => {
  const { config } = await setup(t);
  const { run, calls } = fakeRun();
  const store = await open(t, config, run);
  const { job_id } = await store.start({ prompt: 'x' });
  const t0 = Date.now();
  const snap = await store.get(job_id, 60);
  assert.equal(snap.status, 'working'); assert.ok(Date.now() - t0 >= 50);
  assert.equal(calls[0].signal.aborted, false);
  setTimeout(() => calls[0].resolve({ answer: 'ok' }), 30);
  const t1 = Date.now();
  assert.equal((await store.get(job_id, 20000)).status, 'completed');
  assert.ok(Date.now() - t1 < 5000);
  await assert.rejects(store.get('job_nope'), e => e.code === 'not_found');
  await assert.rejects(store.get('../../etc/passwd'), e => e.code === 'not_found');
});

test('cancel is idempotent, aborts only its own controller, and keeps terminal jobs unchanged', async t => {
  const { config } = await setup(t);
  const { run, calls } = fakeRun();
  const store = await open(t, config, run);
  const a = await store.start({ prompt: 'a' }); const b = await store.start({ prompt: 'b' });
  await sleep(10);
  const c1 = await store.cancel(a.job_id);
  assert.equal(c1.status, 'cancelled'); assert.equal(c1.error.code, 'cancelled');
  assert.equal(calls[0].signal.aborted, true); assert.equal(calls[1].signal.aborted, false);
  const c2 = await store.cancel(a.job_id);
  assert.equal(c2.status, 'cancelled'); assert.equal(c2.updated_at, c1.updated_at);
  calls[0].reject(new RunnerError('cancelled', 'x'));
  await sleep(10);
  assert.equal((await store.get(a.job_id)).status, 'cancelled');
  calls[1].resolve({ answer: 'ok' });
  assert.equal((await store.get(b.job_id, 1000)).status, 'completed');
  assert.equal((await store.cancel(b.job_id)).status, 'completed');
  await assert.rejects(store.cancel('job_missing'), e => e.code === 'not_found');
});

test('idempotency key dedups races and conflicts on different args', async t => {
  const { config } = await setup(t);
  const { run, calls } = fakeRun();
  const store = await open(t, config, run);
  const results = await Promise.allSettled([
    store.start({ prompt: 'p', idempotency_key: 'k1' }),
    store.start({ prompt: 'p', idempotency_key: 'k1' }),
    store.start({ prompt: 'p2', idempotency_key: 'k1' }),
    store.start({ prompt: 'p', idempotency_key: 'k1' }),
  ]);
  const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value.job_id);
  // Filesystem validation may admit either fingerprint first. Matching callers
  // must share its job, while every conflicting fingerprint is rejected.
  assert.ok(ok.length === 1 || ok.length === 3); assert.equal(new Set(ok).size, 1);
  assert.equal(results[0].status, results[1].status);
  assert.equal(results[0].status, results[3].status);
  assert.notEqual(results[2].status, results[0].status);
  for(const result of results.filter(r=>r.status==='rejected'))assert.equal(result.reason.code,'idempotency_conflict');
  assert.equal(calls.length, 1);
  const other = await store.start({ prompt: 'p' });
  assert.notEqual(other.job_id, ok[0]);
  const text = await readFile(join(config.stateDir, `${ok[0]}.json`), 'utf8');
  assert.ok(!text.includes('k1')); assert.ok(!text.includes('"p"'));
});

test('idempotency survives restart', async t => {
  const { config } = await setup(t);
  const { run } = fakeRun();
  const s1 = new JobStore(config, { run }); await s1.ready();
  const a = await s1.start({ prompt: 'p', idempotency_key: 'k' });
  await s1.close();
  const f = fakeRun();
  const s2 = await open(t, config, f.run);
  assert.equal((await s2.start({ prompt: 'p', idempotency_key: 'k' })).job_id, a.job_id);
  await assert.rejects(s2.start({ prompt: 'q', idempotency_key: 'k' }), e => e.code === 'idempotency_conflict');
  await sleep(10); assert.equal(f.calls.length, 0);
});

test('close marks working jobs interrupted, aborts, waits for settlement; restart never reruns', async t => {
  const { config } = await setup(t);
  const { run, calls } = fakeRun();
  const unhandled = []; const h = e => unhandled.push(e); process.on('unhandledRejection', h);
  t.after(() => process.off('unhandledRejection', h));
  const store = new JobStore(config, { run }); await store.ready();
  const { job_id } = await store.start({ prompt: 'x' });
  await sleep(10);
  let settled = false;
  calls[0].onAbort = () => setTimeout(() => { settled = true; calls[0].reject(new RunnerError('cancelled', 'aborted')); }, 40);
  await store.close();
  assert.equal(settled, true); assert.equal(calls[0].signal.aborted, true);
  await sleep(20); assert.deepEqual(unhandled, []);
  const f = fakeRun();
  const s2 = await open(t, config, f.run);
  const snap = await s2.get(job_id);
  assert.equal(snap.status, 'failed'); assert.equal(snap.error.code, 'interrupted');
  assert.match(snap.error.message, /uncertain/i);
  await sleep(10); assert.equal(f.calls.length, 0);
});

test('crashed working file becomes interrupted on ready and is not rerun', async t => {
  const { config } = await setup(t);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  await writeFile(join(config.stateDir, 'job_crash.json'), JSON.stringify({ job_id: 'job_crash', status: 'working',
    created_at: now, updated_at: now, model: null, cwd: config.root, partial_answer: 'part', result: null, error: null }), { mode: 0o600 });
  await writeFile(join(config.stateDir, 'job_garbage.json'), '{not json');
  const f = fakeRun();
  const store = await open(t, config, f.run);
  const snap = await store.get('job_crash');
  assert.equal(snap.status, 'failed'); assert.equal(snap.error.code, 'interrupted');
  assert.equal(snap.partial_answer, 'part');
  assert.equal(JSON.parse(await readFile(join(config.stateDir, 'job_crash.json'), 'utf8')).status, 'failed');
  assert.equal(f.calls.length, 0);
});

test('state is private, atomic, and latest state wins under serialized writes', async t => {
  const { config } = await setup(t);
  const { run, calls } = fakeRun();
  const store = await open(t, config, run);
  assert.equal((await stat(config.stateDir)).mode & 0o777, 0o700);
  const { job_id } = await store.start({ prompt: 'x' });
  await sleep(10);
  calls[0].resolve({ answer: 'ok' });
  await store.get(job_id, 1000);
  await store.cancel(job_id);
  await store.close();
  const names = await readdir(config.stateDir);
  assert.deepEqual(names.filter(n => !n.endsWith('.json')), []);
  const file = join(config.stateDir, `${job_id}.json`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'completed');
});

test('errors are redacted recursively without tool inputs or thinking', async t => {
  const { config } = await setup(t);
  const { run, calls } = fakeRun();
  const store = await open(t, config, run);
  const { job_id } = await store.start({ prompt: 'x' });
  await sleep(10);
  calls[0].reject(new RunnerError('permission_denied', `denied ${SECRET}`, { tool_names: [`T-${SECRET}`],
    nested: { deep: [`x ${SECRET}`] }, tool_input: { command: 'SECRET-INPUT' }, thinking: 'SECRET-THOUGHT' }));
  const snap = await store.get(job_id, 1000);
  assert.equal(snap.status, 'failed'); assert.equal(snap.error.code, 'permission_denied');
  const text = JSON.stringify(snap) + await readFile(join(config.stateDir, `${job_id}.json`), 'utf8');
  for (const bad of [SECRET, 'SECRET-INPUT', 'SECRET-THOUGHT']) assert.ok(!text.includes(bad), bad);
  assert.ok(text.includes('[redacted]'));
  const { job_id: id2 } = await store.start({ prompt: 'y' });
  await sleep(10);
  calls[1].reject(new Error(`boom ${SECRET}`));
  const s2 = await store.get(id2, 1000);
  assert.equal(s2.status, 'failed'); assert.ok(!JSON.stringify(s2).includes(SECRET));
});

test('capacity rejects without evicting running jobs; concurrency limit enforced', async t => {
  const { config } = await setup(t, { maxJobs: 2, maxConcurrentJobs: 1 });
  const { run, calls } = fakeRun();
  const store = await open(t, config, run);
  const a = await store.start({ prompt: 'a' });
  await assert.rejects(store.start({ prompt: 'b' }), e => e.code === 'capacity');
  calls[0].resolve({ answer: 'ok' }); await store.get(a.job_id, 1000);
  await store.start({ prompt: 'c' });
  await sleep(10);
  assert.equal((await store.get(a.job_id)).status, 'completed');
  const { config: c2 } = await setup(t, { maxJobs: 1, maxConcurrentJobs: 4 });
  const f = fakeRun(); const s2 = await open(t, c2, f.run);
  const r = await s2.start({ prompt: 'a' });
  await assert.rejects(s2.start({ prompt: 'b' }), e => e.code === 'capacity');
  assert.equal((await s2.get(r.job_id)).status, 'working');
});

test('terminal jobs past retention are removed from memory and disk', async t => {
  const { config } = await setup(t, { jobRetentionMs: 40 });
  const { run, calls } = fakeRun();
  const s1 = await open(t, config, run);
  const done = await s1.start({ prompt: 'a' });
  const live = await s1.start({ prompt: 'b' });
  await sleep(10);
  calls[0].resolve({ answer: 'ok' }); await s1.get(done.job_id, 1000);
  await sleep(80);
  assert.equal((await s1.list()).map(j => j.job_id).join(), live.job_id);
  await assert.rejects(s1.get(done.job_id), e => e.code === 'not_found');
  assert.deepEqual(await files(config), [`${live.job_id}.json`]);
  await s1.close();
  await sleep(80);
  const s2 = await open(t, config, fakeRun().run);
  assert.deepEqual(await s2.list(), []);
  assert.deepEqual(await files(config), []);
});

test('real runner with delayed temp CLI completes asynchronously', async t => {
  const { root, config } = await setup(t);
  const cli = join(root, 'claude');
  await writeFile(cli, `#!/usr/bin/env node
process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'late'})),300));`, { mode: 0o755 });
  const store = await open(t, { ...config, command: cli, timeoutMs: 5000, maxOutput: 10000 });
  const t0 = Date.now();
  const snap = await store.start({ prompt: 'hi' });
  assert.equal(snap.status, 'working'); assert.ok(Date.now() - t0 < 250);
  assert.equal((await store.get(snap.job_id, 100)).status, 'working');
  const done = await store.get(snap.job_id, 5000);
  assert.equal(done.status, 'completed'); assert.equal(done.result.answer, 'late');
});

test('permission denial clears accumulated partial answer from retained error result',async t=>{
 const {config}=await setup(t);const {run,calls}=fakeRun();const store=await open(t,config,run);
 const job=await store.start({prompt:'x'});calls[0].options.onProgress({partial_answer:'unconfirmed answer'});
 calls[0].reject(new RunnerError('permission_denied','tool denied',{tool_names:['Bash']}));
 const done=await store.get(job.job_id,1000);assert.equal(done.status,'failed');assert.equal(done.partial_answer,'');
});
