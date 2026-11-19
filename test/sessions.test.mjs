import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, realpath, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.mjs';
import { RunnerError } from '../src/runner.mjs';

const PROMPT = 'RAW-PROMPT-MUST-NOT-PERSIST';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = { prompt: 'q', model: 'm1', resumable: true, review: true };

async function setup(t, extra = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-sess-')));
  t.after(async () => { await sleep(30); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const root = join(dir, 'root'); await mkdir(root);
  const config = { root, command: 'unused', timeoutMs: 1000, maxOutput: 1000, permissionMode: 'acceptEdits', allowedTools: [],
    env: { ...process.env }, stateDir: join(dir, 'state'), ...extra };
  return { dir, root, config };
}
// Fake runner: writes the transcript a real CLI would; `hold` keeps calls open until finish()/fail(); `costs` is a queue.
function fake({ hold = false, costs = [] } = {}) {
  const calls = [];
  const run = async (args, config, signal) => {
    const call = { args }; calls.push(call);
    const s = args.session;
    if (s?.mode === 'new') {
      const d = join(s.configDir, 'projects', 'p'); await mkdir(d, { recursive: true });
      await writeFile(join(d, `${s.uuid}.jsonl`), '{}');
    }
    if (hold) await new Promise((res, rej) => { call.finish = res; call.fail = rej; signal.addEventListener('abort', () => rej(new RunnerError('cancelled', 'aborted')), { once: true }); });
    const cost = costs.length ? costs.shift() : 0.5;
    return { answer: 'ok', cwd: args.cwd, ...(s ? { cli_session_id: s.uuid } : {}), ...(cost === undefined ? {} : { usage: { conversationCostUSD: cost } }) };
  };
  return { run, calls };
}
async function open(t, config, run) {
  const store = new JobStore(config, { run }); await store.ready(); t.after(() => store.close()); return store;
}
const done = (store, id) => store.get(id, 2000);
const code = (store, args) => store.start(args).then(() => null, e => e.code);
// Start a held turn, release it, and wait for completion.
async function turn(store, f, args) {
  const n = f.calls.length; const snap = await store.start(args);
  for (let i = 0; i < 100 && !f.calls[n]?.finish; i++) await sleep(5);
  f.calls[n].finish(); await done(store, snap.job_id); return snap;
}

test('new resumable validates arguments before any execution', async t => {
  const { config } = await setup(t); const { run, calls } = fake(); const store = await open(t, config, run);
  assert.equal(await code(store, { ...base, model: undefined }), 'model_required');
  assert.equal(await code(store, { ...base, review: false }), 'unsupported');
  assert.equal(await code(store, { prompt: 'q', model: 'm1', resumable: true }), 'unsupported');
  assert.equal(await code(store, { ...base, resume_job_id: 'job_abc' }), 'invalid_request');
  assert.equal(await code(store, { prompt: 'q', resume_job_id: 'job_abc', resumable: true }), 'invalid_request');
  for (const max_budget_usd of [0, -1, 100.5, NaN, Infinity, '5']) assert.equal(await code(store, { prompt: 'q', max_budget_usd }), 'invalid_request', String(max_budget_usd));
  assert.equal(await code(store, { prompt: 'q', resume_job_id: 'job_unknown' }), 'not_found');
  assert.equal(calls.length, 0);
});

test('new chain: server uuid, private files, review/budget forwarded, resume_available tracks head, no prompt persisted', async t => {
  const { config, dir } = await setup(t); const f = fake({ hold: true }); const store = await open(t, config, f.run);
  const snap = await store.start({ ...base, prompt: PROMPT, max_budget_usd: 2.5 });
  assert.equal(snap.session.resume_available, false);
  await sleep(30);
  const { args } = f.calls[0]; const s = args.session;
  assert.equal(s.mode, 'new'); assert.match(s.uuid, UUID); assert.equal(s.previousCost, 0);
  assert.equal(args.review, true); assert.equal(args.max_budget_usd, 2.5); assert.equal(args.model, 'm1');
  assert.ok(s.configDir.startsWith(join(dir, 'sessions')));
  assert.equal((await stat(s.configDir)).mode & 0o777, 0o700);
  assert.equal(snap.session.cli_session_id, s.uuid);
  f.calls[0].finish();
  const fin = await done(store, snap.job_id);
  assert.equal(fin.status, 'completed'); assert.equal(fin.session.resume_available, true); assert.equal(fin.session.cli_session_id, s.uuid);
  for (const d of ['state', 'sessions']) for (const e of await readdir(join(dir, d), { recursive: true, withFileTypes: true })) {
    const file = join(e.parentPath, e.name);
    if (e.isFile()) { assert.ok(!(await readFile(file, 'utf8')).includes(PROMPT), file); if (!file.includes('/claude/')) assert.equal((await stat(file)).mode & 0o777, 0o600, file); }
  }
});

test('resume inherits model/cwd/review and confirmed cost; mismatches rejected without launching', async t => {
  const { config, root } = await setup(t); await mkdir(join(root, 'other'));
  const f = fake(); const store = await open(t, config, f.run);
  const a = await store.start(base); await done(store, a.job_id);
  assert.equal(await code(store, { prompt: 'n', resume_job_id: a.job_id, model: 'm2' }), 'session_mismatch');
  assert.equal(await code(store, { prompt: 'n', resume_job_id: a.job_id, cwd: 'other' }), 'session_mismatch');
  assert.equal(await code(store, { prompt: 'n', resume_job_id: a.job_id, review: false }), 'session_mismatch');
  assert.equal(f.calls.length, 1);
  const b = await store.start({ prompt: 'n', resume_job_id: a.job_id, model: 'm1', review: true }); await done(store, b.job_id);
  const r = f.calls[1].args;
  assert.equal(r.session.mode, 'resume'); assert.equal(r.session.uuid, f.calls[0].args.session.uuid);
  assert.equal(r.session.previousCost, 0.5); assert.equal(r.model, 'm1'); assert.equal(r.cwd, config.root); assert.equal(r.review, true);
  assert.equal(b.model, 'm1');
});

test('exclusion: same-conversation concurrent resumes across two stores allow exactly one launch', async t => {
  const { config } = await setup(t);
  const f1 = fake({ hold: true }); const s1 = await open(t, config, f1.run);
  const a = await turn(s1, f1, base);
  const f2 = fake({ hold: true }); const s2 = await open(t, config, f2.run); // second "process", same directories
  const results = await Promise.allSettled([s1.start({ prompt: 'x', resume_job_id: a.job_id }), s2.start({ prompt: 'y', resume_job_id: a.job_id }),
    s2.start({ prompt: 'z', resume_job_id: a.job_id }), s1.start({ prompt: 'w', resume_job_id: a.job_id })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of results.filter(r => r.status === 'rejected')) assert.equal(r.reason.code, 'chain_busy');
  await sleep(30);
  assert.equal(f1.calls.length + f2.calls.length, 2); // first turn + one resume
  const winner = results.find(r => r.status === 'fulfilled').value;
  (f1.calls[1] ?? f2.calls[0]).finish();
  await done(s1, winner.job_id).catch(() => done(s2, winner.job_id));
  assert.equal(await code(s2, { prompt: 'x', resume_job_id: a.job_id }), 'stale_ancestor');
});

test('stale ancestor is rejected; the new head continues', async t => {
  const { config } = await setup(t); const f = fake(); const store = await open(t, config, f.run);
  const a = await store.start(base); await done(store, a.job_id);
  const b = await store.start({ prompt: 'n', resume_job_id: a.job_id }); await done(store, b.job_id);
  assert.equal(await code(store, { prompt: 'n', resume_job_id: a.job_id }), 'stale_ancestor');
  const c = await store.start({ prompt: 'n', resume_job_id: b.job_id }); assert.equal((await done(store, c.job_id)).status, 'completed');
  assert.equal(f.calls.length, 3);
});

test('failed, cancelled and restart-interrupted latest attempts block the conversation', async t => {
  const { config } = await setup(t);
  const f = fake({ hold: true }); const store = await open(t, config, f.run);
  const resume = async parent => { const n = f.calls.length; const s = await store.start({ prompt: 'n', resume_job_id: parent.job_id });
    for (let i = 0; i < 100 && !f.calls[n]?.finish; i++) await sleep(5); return { s, call: f.calls[n] }; };
  // failure
  const a = await turn(store, f, base);
  const b = await resume(a); b.call.fail(new RunnerError('claude_error', 'boom'));
  assert.equal((await done(store, b.s.job_id)).status, 'failed');
  assert.equal(await code(store, { prompt: 'n', resume_job_id: b.s.job_id }), 'chain_blocked');
  assert.equal(await code(store, { prompt: 'n', resume_job_id: a.job_id }), 'stale_ancestor'); // no fallback to the good ancestor
  // cancel
  const c = await turn(store, f, base);
  const d = await resume(c);
  assert.equal((await store.cancel(d.s.job_id)).status, 'cancelled');
  assert.equal(await code(store, { prompt: 'n', resume_job_id: d.s.job_id }), 'chain_blocked');
  // restart while a continuation runs
  const e = await turn(store, f, base);
  const g = await resume(e);
  await store.close();
  const again = await open(t, config, fake().run);
  assert.equal((await again.get(g.s.job_id)).status, 'failed');
  assert.equal(await code(again, { prompt: 'n', resume_job_id: g.s.job_id }), 'chain_blocked');
  assert.equal(await code(again, { prompt: 'n', resume_job_id: e.job_id }), 'stale_ancestor');
});

test('missing transcript blocks the chain without launching', async t => {
  const { config, dir } = await setup(t); const f = fake(); const store = await open(t, config, f.run);
  const a = await store.start(base); await done(store, a.job_id);
  for (const id of await readdir(join(dir, 'sessions'))) await rm(join(dir, 'sessions', id, 'claude', 'projects'), { recursive: true, force: true });
  assert.equal(await code(store, { prompt: 'n', resume_job_id: a.job_id }), 'transcript_missing');
  assert.equal(f.calls.length, 1);
  assert.equal(await code(store, { prompt: 'n', resume_job_id: a.job_id }), 'chain_blocked');
});

test('chain survives job deletion and restart (root record independent of job pruning)', async t => {
  const { config } = await setup(t); const f = fake(); const store = await open(t, config, f.run);
  const a = await store.start(base); await done(store, a.job_id); await store.close();
  const again = await open(t, config, f.run);
  const b = await again.start({ prompt: 'n', resume_job_id: a.job_id }); assert.equal((await done(again, b.job_id)).status, 'completed');
  await done(again, b.job_id); await again.delete(a.job_id); // pruning an ancestor does not matter
  const c = await again.start({ prompt: 'n', resume_job_id: b.job_id }); assert.equal((await done(again, c.job_id)).status, 'completed');
  await again.delete(c.job_id); // pruning the head keeps the id resumable
  const d = await again.start({ prompt: 'n', resume_job_id: c.job_id }); assert.equal((await done(again, d.job_id)).status, 'completed');
});

test('idempotent resume retry returns the original; changed role/budget/prompt conflict', async t => {
  const { config } = await setup(t); const f = fake({ hold: true }); const store = await open(t, config, f.run);
  const a = await turn(store, f, { ...base, idempotency_key: 'k0' });
  const args = { prompt: 'n', resume_job_id: a.job_id, idempotency_key: 'k1', max_budget_usd: 1 };
  const [b1, b2] = await Promise.all([store.start(args), store.start(args)]);
  assert.equal(b1.job_id, b2.job_id);
  assert.equal((await store.start(args)).job_id, b1.job_id); // chain is busy, key still resolves first
  await sleep(30); assert.equal(f.calls.length, 2);
  for (const x of [{ max_budget_usd: 2 }, { review: false }, { prompt: 'different' }]) assert.equal(await code(store, { ...args, ...x }), 'idempotency_conflict', JSON.stringify(x));
  assert.equal((await store.start({ ...base, idempotency_key: 'k0' })).job_id, a.job_id);
  assert.equal(await code(store, { ...base, idempotency_key: 'k0', review: false }), 'idempotency_conflict');
  assert.equal(await code(store, { ...base, idempotency_key: 'k0', max_budget_usd: 3 }), 'idempotency_conflict');
});

test('cost reset establishes a new baseline and missing accounting makes the next delta unknown', async t => {
  const { config } = await setup(t); const f = fake({ costs: [0.5, 0.2, undefined, 0.9, 1.0] }); const store = await open(t, config, f.run);
  let head = (await store.start(base)).job_id;
  for (let i = 0; i < 4; i++) { await done(store, head); head = (await store.start({ prompt: 'n', resume_job_id: head })).job_id; }
  await done(store, head);
  assert.deepEqual(f.calls.map(c => c.args.session.previousCost), [0, 0.5, 0.2, null, 0.9]);
});

test('stateless default is untouched: no session args, no session metadata', async t => {
  const { config } = await setup(t); const f = fake(); const store = await open(t, config, f.run);
  const s = await store.start({ prompt: 'q' }); const r = await done(store, s.job_id);
  assert.equal(f.calls[0].args.session, undefined); assert.equal(f.calls[0].args.review, undefined);
  assert.equal('session' in r, false); assert.equal('session' in s, false);
});

test('page: newest-first, bounded, filtered, opaque cursor, metadata only', async t => {
  const { config } = await setup(t, { maxJobs: 500, maxConcurrentJobs: 50 }); const f = fake(); const store = await open(t, config, f.run);
  const ids = [];
  for (let i = 0; i < 25; i++) { ids.push((await store.start({ prompt: PROMPT + i })).job_id); await sleep(2); }
  for (const id of ids) await done(store, id);
  const p1 = await store.page({});
  assert.equal(p1.jobs.length, 20); assert.equal(p1.has_more, true); assert.equal(p1.count, 20); assert.equal(typeof p1.next_cursor, 'string');
  const p2 = await store.page({ cursor: p1.next_cursor });
  assert.equal(p2.jobs.length, 5); assert.equal(p2.has_more, false); assert.equal(p2.next_cursor, null);
  assert.deepEqual([...p1.jobs, ...p2.jobs].map(j => j.job_id), [...ids].reverse());
  assert.equal((await store.page({ limit: 3 })).jobs.length, 3);
  assert.equal((await store.page({ status: 'failed' })).jobs.length, 0);
  assert.equal((await store.page({ status: 'completed', limit: 100 })).jobs.length, 25);
  for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { status: 'bogus' }, { cursor: 'garbage' }])
    await assert.rejects(store.page(bad), e => ['invalid_request', 'invalid_cursor'].includes(e.code), JSON.stringify(bad));
  assert.ok(!JSON.stringify(p1).includes('RAW-PROMPT') && !('result' in p1.jobs[0]) && !('partial_answer' in p1.jobs[0]));
  assert.equal((await store.list()).length, 25); // legacy array preserved
});
