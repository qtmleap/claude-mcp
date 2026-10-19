import { createHash, randomBytes } from 'node:crypto';
import { mkdir, chmod, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { runAsk, resolveCwd, redact, RunnerError, validBudget, REVIEW_POLICY } from './runner.mjs';
import { SessionChains } from './sessions.mjs';

const MAX_WAIT_MS = 30000;
const NO_DEADLINE_MS = 0; // Runner uses no timer when omitted/zero.
const ID_PATTERN = /^job_[A-Za-z0-9_-]{1,64}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STATUSES = ['working', 'completed', 'failed', 'cancelled'];
const DEFAULT_PAGE = 20, MAX_PAGE = 100;
const DROPPED_KEYS = new Set(['tool_input', 'tool_inputs', 'input', 'inputs', 'thinking', 'prompt']);

export class JobError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const timeOf = job => Date.parse(job.updated_at);

export class JobStore {
  #config; #run; #dir; #maxJobs; #maxConcurrent; #retentionMs; #maxOutput;
  #jobs = new Map(); #keys = new Map(); #sessions; #lock = Promise.resolve();
  // Unsettled executions, independent of #jobs visibility: delete/purge cannot free a slot or hide a runner from close().
  #active = new Set(); #ready; #closing;

  constructor(config, { run = runAsk } = {}) {
    this.#config = config; this.#run = run;
    this.#dir = config.stateDir ?? join(homedir(), '.local', 'state', 'claude-mcp', 'jobs');
    this.#maxJobs = config.maxJobs ?? 128;
    this.#maxConcurrent = config.maxConcurrentJobs ?? 4;
    this.#retentionMs = config.jobRetentionMs ?? 7 * 24 * 3600 * 1000;
    this.#maxOutput = config.maxOutput ?? 1024 * 1024;
    this.#sessions = new SessionChains(config.sessionDir ?? join(dirname(this.#dir), 'sessions'), config.sessionRetentionMs ?? this.#retentionMs);
  }
  #sessionsInit() { return this.#sessions.init(); }

  ready() { return this.#ready ??= this.#load(); }

  async #load() {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await chmod(this.#dir, 0o700);
    for (const name of await readdir(this.#dir)) {
      if (name.endsWith('.tmp')) { await unlink(join(this.#dir, name)).catch(() => {}); continue; }
      if (!name.endsWith('.json')) continue;
      let data;
      try { data = JSON.parse(await readFile(join(this.#dir, name), 'utf8')); } catch { continue; }
      if (!data || data.job_id !== name.slice(0, -5) || !ID_PATTERN.test(data.job_id)
        || !['working', ...TERMINAL].includes(data.status) || Number.isNaN(Date.parse(data.updated_at))) continue;
      const entry = this.#entry(data);
      if (data.status === 'working') this.#interrupt(entry); // Never rerun: the previous process may have executed it.
      if (data.session?.id) {
        // Recovered state is a hint; existing claims are never taken over based on PID or elapsed time.
        if (data.status === 'working') await this.#sessions.recover(data.session.id, data.job_id).catch(() => {});
        const root = await this.#sessions.read(data.session.id);
        entry.job.session.resume_available = data.status === 'completed' && root?.head_job_id === data.job_id && root.state === 'ready';
      }
      if (entry.job.idempotency?.key_hash) this.#keys.set(entry.job.idempotency.key_hash, entry);
    }
    await Promise.all([...this.#jobs.values()].map(e => e.chain));
    this.#purge();
  }

  #entry(job) {
    const entry = { job, chain: Promise.resolve(), step: null, controller: null, settled: null, waiters: new Set() };
    this.#jobs.set(job.job_id, entry);
    return entry;
  }

  #interrupt(entry, message = 'Job interrupted by server restart; execution uncertain. Not retried.') {
    this.#finish(entry, 'failed', { error: { code: 'interrupted', message } });
  }

  #finish(entry, status, fields) {
    Object.assign(entry.job, { status, updated_at: new Date().toISOString(), ...fields,
      ...(status === 'completed' ? { partial_answer: '' } : {}) });
    this.#persist(entry).catch(() => {});
    for (const wake of [...entry.waiters]) wake();
  }

  #snapshot({ job }) {
    const { job_id, status, created_at, updated_at, model, cwd, partial_answer, result, error, session } = job;
    return structuredClone({ job_id, status, created_at, updated_at, model, cwd, partial_answer, result, error, ...(session ? { session } : {}) });
  }

  // Lightweight listing entry: no partial_answer/result/error bodies (each up to maxOutput); use get for those.
  #summary({ job }) {
    const { job_id, status, created_at, updated_at, model, cwd, error } = job;
    return { job_id, status, created_at, updated_at, model, cwd, error_code: error?.code ?? null };
  }

  // Writes are serialized per job; queued writes coalesce and always persist the latest state.
  #persist(entry) {
    if (entry.step && !entry.started) return entry.step;
    const step = entry.chain.then(async () => {
      entry.started = true; entry.step = null;
      const file = join(this.#dir, `${entry.job.job_id}.json`);
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      const body = JSON.stringify({ ...this.#snapshot(entry), idempotency: entry.job.idempotency ?? null });
      try {
        await writeFile(tmp, body, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, file);
      } catch (error) { await unlink(tmp).catch(() => {}); throw error; }
    });
    entry.started = false; entry.step = step;
    entry.chain = step.catch(() => {});
    return step;
  }

  #purge() {
    const cutoff = Date.now() - this.#retentionMs;
    for (const [id, entry] of [...this.#jobs]) {
      if (!TERMINAL.has(entry.job.status) || timeOf(entry.job) > cutoff) continue;
      this.#jobs.delete(id);
      const key = entry.job.idempotency?.key_hash;
      if (key && this.#keys.get(key) === entry) this.#keys.delete(key);
      entry.chain.then(() => unlink(join(this.#dir, `${id}.json`))).catch(() => {});
    }
  }

  #sanitize(value, depth = 0) {
    if (typeof value === 'string') return redact(value, this.#config.env);
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth > 6) return null;
    if (Array.isArray(value)) return value.map(v => this.#sanitize(v, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) if (!DROPPED_KEYS.has(k)) out[redact(k, this.#config.env)] = this.#sanitize(v, depth + 1);
      return out;
    }
    return null;
  }

  #error(error) {
    const code = typeof error?.code === 'string' ? error.code : 'job_failed';
    const result = { code, message: this.#sanitize(String(error?.message ?? 'Job failed')).slice(0, 4000) };
    if (error?.details && typeof error.details === 'object') result.details = this.#sanitize(error.details);
    return result;
  }

  async start(args) {
    if (this.#closing) throw new JobError('closed', 'Job store is closed');
    await this.ready();
    if (!validBudget(args.max_budget_usd)) throw new JobError('invalid_request', 'max_budget_usd must be a finite number in (0, 100]');
    if (args.resumable && args.resume_job_id) throw new JobError('invalid_request', 'resumable and resume_job_id are mutually exclusive');
    // Serialize admission through first persistence, including stateless starts: a slot cannot be stolen
    // while a session head is reserved. Generations run concurrently; cross-process claims stay exclusive.
    const run = this.#lock.then(() => this.#start(args));
    this.#lock = run.catch(() => {});
    return run;
  }

  // New chains pin model/cwd/review; continuations inherit them and reject any explicit mismatch.
  async #prepare(args) {
    await this.#sessionsInit();
    const policy = review => sha256(JSON.stringify([!!review, review ? REVIEW_POLICY : [this.#config.permissionMode, this.#config.allowedTools ?? []]]));
    if (args.resumable) {
      if (!args.model) throw new JobError('model_required', 'A new resumable conversation needs an explicit model');
      if (args.review !== true) throw new JobError('unsupported', 'resumable currently requires review:true (isolated CLI config would otherwise drop hooks/plugins)');
      return { cwd: await resolveCwd(args.cwd, this.#config.root, this.#config.mountedRoots ?? [this.#config.root]), model: args.model, review: true, policy: policy(true) };
    }
    const parent = this.#jobs.get(args.resume_job_id);
    if (parent && !parent.job.session) throw new JobError('invalid_request', 'resume_job_id does not name a resumable job');
    if (parent && parent.job.status !== 'completed') throw new JobError('chain_blocked', 'Only a successfully completed current turn can be resumed');
    const root = parent ? await this.#sessions.read(parent.job.session.id) : await this.#sessions.findByHead(args.resume_job_id);
    if (!root) throw new JobError('not_found', 'Unknown or expired resumable job_id');
    if (args.model && args.model !== root.model) throw new JobError('session_mismatch', 'model differs from the conversation');
    if (args.review !== undefined && args.review !== root.review) throw new JobError('session_mismatch', 'review differs from the conversation');
    if (args.cwd !== undefined && await resolveCwd(args.cwd, this.#config.root, this.#config.mountedRoots ?? [this.#config.root]) !== root.cwd)
      throw new JobError('session_mismatch', 'cwd differs from the conversation');
    if (root.policy !== policy(root.review)) throw new JobError('session_mismatch', 'server permission policy changed since the conversation began');
    return { cwd: root.cwd, model: root.model, review: root.review, policy: root.policy, root, parent };
  }

  async #start(args) {
    const session = args.resumable || args.resume_job_id;
    // Session requests fingerprint the arguments as given, so a retry with changed role/budget conflicts before mismatch checks.
    const fingerprintOf = cwd => {
      const fields = [args.prompt, args.model ?? null, cwd, args.execution_timeout_ms ?? null];
      // New fields extend the fingerprint only when used, so stateless retries stay compatible with earlier snapshots.
      if (session || args.review || args.max_budget_usd !== undefined)
        fields.push(args.resumable ?? false, args.resume_job_id ?? null, args.review ?? null, args.max_budget_usd ?? null);
      return sha256(JSON.stringify(fields));
    };
    const keyHash = args.idempotency_key == null ? null : sha256(String(args.idempotency_key));
    const replay = fingerprint => {
      const existing = keyHash && this.#keys.get(keyHash);
      if (!existing) return null;
      if (existing.job.idempotency.fingerprint !== fingerprint)
        throw new JobError('idempotency_conflict', 'idempotency_key was already used with different arguments');
      return this.#snapshot(existing);
    };
    if (session) { const hit = replay(fingerprintOf(args.cwd ?? null)); if (hit) return hit; }
    const prep = session ? await this.#prepare(args) : null;
    const cwd = prep ? prep.cwd : await resolveCwd(args.cwd, this.#config.root, this.#config.mountedRoots ?? [this.#config.root]);
    const model = prep ? prep.model : args.model;
    // No await between the capacity checks and registering the job (stateless path), so concurrent starts, deletes and purges cannot interleave.
    if (this.#closing) throw new JobError('closed', 'Job store is closed');
    this.#purge();
    const fingerprint = fingerprintOf(session ? (args.cwd ?? null) : cwd);
    if (!session) { const hit = replay(fingerprint); if (hit) return hit; }
    const capacity = () => {
      if (this.#jobs.size >= this.#maxJobs)
        throw new JobError('capacity', `Retained job history is full (${this.#maxJobs} jobs). cancel_job does not free history: delete_job finished jobs or wait for retention expiry.`);
      // A cancelled job still unwinding its runner holds its slot until the runner actually settles.
      if (this.#active.size >= this.#maxConcurrent)
        throw new JobError('capacity', `Maximum concurrent running jobs reached (${this.#maxConcurrent}). Wait for a job to finish; a cancelled job frees its slot once its process has exited.`);
    };
    capacity();
    const jobId = `job_${randomBytes(16).toString('hex')}`;
    let chain = null;
    if (session) {
      // The attempt becomes the conversation head before launch, so it supersedes the parent whatever its outcome.
      chain = prep.root
        ? (await this.#sessions.reserve(prep.root.uuid, args.resume_job_id, jobId)).session
        : await this.#sessions.create({ jobId, cwd, model, review: prep.review, policy: prep.policy });
      try { if (this.#closing) throw new JobError('closed', 'Job store is closed'); capacity(); } catch (error) { await this.#sessions.settle(chain.id, false).catch(() => {}); throw error; }
      if (prep.parent?.job.session) prep.parent.job.session.resume_available = false;
    }
    const now = new Date().toISOString();
    const entry = this.#entry({ job_id: jobId, status: 'working', created_at: now, updated_at: now,
      model: model ?? null, cwd, partial_answer: '', result: null, error: null,
      ...(chain ? { session: { id: chain.id, cli_session_id: chain.uuid, resume_available: false } } : {}),
      idempotency: { key_hash: keyHash, fingerprint } });
    entry.chain_session = chain;
    if (keyHash) this.#keys.set(keyHash, entry);
    entry.controller = new AbortController();
    this.#active.add(entry); // Reserved before the awaited first persistence and released only in #execute.
    const snapshot = this.#snapshot(entry);
    const persisted = this.#persist(entry);
    entry.settled = this.#execute(entry, { ...args, model, review: prep?.review ?? args.review }, cwd, persisted);
    await persisted; // On failure #execute has already removed the entry and released the reservation.
    return snapshot;
  }

  // Settles the conversation claim (blocking it unless the turn completed) before the execution slot is freed.
  async #end(entry, ok = false) {
    const chain = entry.chain_session;
    if (chain) {
      entry.chain_session = null;
      const cost = ok ? entry.job.result?.usage?.conversationCostUSD : undefined;
      let saved = false;
      try { await this.#sessions.settle(chain.id, ok, cost); saved = true; } catch {}
      entry.job.session.resume_available = ok && saved;
      if (!saved) entry.job.session.blocked_reason = 'state_persistence_failed';
      if (this.#jobs.get(entry.job.job_id) === entry) await this.#persist(entry).catch(() => {});
    }
    this.#release(entry);
  }
  #release(entry) { this.#active.delete(entry); entry.controller = null; entry.settled = null; }

  async #execute(entry, args, cwd, persisted) {
    const { prompt, model, execution_timeout_ms } = args;
    const chain = entry.chain_session;
    const runArgs = { prompt, cwd, ...(model ? { model } : {}),
      timeout_ms: execution_timeout_ms ?? NO_DEADLINE_MS,
      ...(args.review ? { review: true } : {}), ...(args.max_budget_usd !== undefined ? { max_budget_usd: args.max_budget_usd } : {}),
      ...(chain ? { session: { mode: chain.mode, uuid: chain.uuid, configDir: chain.configDir, previousCost: chain.previousCost } } : {}) };
    const onProgress = ({ partial_answer } = {}) => {
      if (entry.job.status !== 'working' || typeof partial_answer !== 'string') return;
      entry.job.partial_answer = redact(partial_answer, this.#config.env).slice(-this.#maxOutput);
      entry.job.updated_at = new Date().toISOString();
      this.#persist(entry).catch(() => {});
    };
    try { await persisted; }
    catch {
      if (this.#jobs.get(entry.job.job_id) === entry) this.#jobs.delete(entry.job.job_id);
      const key = entry.job.idempotency?.key_hash;
      if (key && this.#keys.get(key) === entry) this.#keys.delete(key);
      await this.#end(entry);
      return;
    }
    let ok = false;
    try {
      if (entry.job.status !== 'working') return; // Cancelled/interrupted during first persistence: never start the runner.
      const result = await this.#run(runArgs, this.#config, entry.controller.signal, { onProgress, stream: true });
      if (entry.job.status === 'working') this.#finish(entry, 'completed', { result: this.#sanitize(result), error: null });
      ok = entry.job.status === 'completed';
    } catch (error) {
      if((error?.code==='permission_denied'||error?.details?.permission_denied===true) && entry.job.status!=='working'){
        entry.job.partial_answer='';
        if(this.#jobs.get(entry.job.job_id)===entry) await this.#persist(entry).catch(()=>{});
      }
      if (entry.job.status === 'working') this.#finish(entry, error?.code === 'cancelled' ? 'cancelled' : 'failed', { error: this.#error(error),...(error?.code==='permission_denied'||error?.details?.permission_denied===true?{partial_answer:''}:{}) });
    } finally {
      await entry.chain;
      // Release only after the runner settled and persistence completed; snapshot, keys and results remain.
      await this.#end(entry, ok);
    }
  }

  async get(id, wait_ms = 0) {
    await this.ready(); this.#purge();
    const entry = this.#jobs.get(id);
    if (!entry) throw new JobError('not_found', 'Unknown job_id');
    const wait = Math.min(Math.max(Number(wait_ms) || 0, 0), MAX_WAIT_MS);
    const deadline = performance.now() + wait;
    if (wait > 0 && entry.job.status === 'working') {
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); entry.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, wait);
        entry.waiters.add(wake);
      });
    }
    const remaining = deadline - performance.now();
    if (TERMINAL.has(entry.job.status) && remaining > 0) {
      // Settlement may lag completion. Respect the original wait budget; never cancel generation or disk I/O.
      // Until settlement confirms readiness, resume_available stays false and callers may poll again.
      let timer;
      const settled = async () => {
        await entry.chain;
        if (entry.job.session && (entry.job.status === 'completed' || (entry.job.status === 'failed' && entry.job.error?.code !== 'interrupted')))
          await entry.settled;
      };
      try { await Promise.race([settled(), new Promise(resolve => { timer = setTimeout(resolve, remaining); })]); }
      finally { clearTimeout(timer); }
    }
    return this.#snapshot(entry);
  }

  async list() {
    await this.ready(); this.#purge();
    return [...this.#jobs.values()].map(e => this.#summary(e)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  // Metadata-only page, newest first (created_at, then id); the opaque cursor is the last returned sort key.
  async page({ limit = DEFAULT_PAGE, status, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new JobError('invalid_request', `limit must be an integer in 1..${MAX_PAGE}`);
    if (status !== undefined && !STATUSES.includes(status)) throw new JobError('invalid_request', 'Unknown status filter');
    let after = null;
    if (cursor !== undefined) {
      try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch {}
      if (!Array.isArray(after) || after.length !== 2 || after.some(x => typeof x !== 'string')) throw new JobError('invalid_cursor', 'Invalid cursor');
    }
    await this.ready(); this.#purge();
    const key = e => e.job.created_at + '\u0000' + e.job.job_id;
    const rows = [...this.#jobs.values()].filter(e => !status || e.job.status === status).sort((a, b) => key(b) < key(a) ? -1 : key(b) > key(a) ? 1 : 0)
      .filter(e => !after || key(e) < after[0] + '\u0000' + after[1]);
    const jobs = rows.slice(0, limit).map(e => this.#summary(e));
    const more = rows.length > limit, last = jobs.at(-1);
    return { jobs, count: jobs.length, has_more: more, next_cursor: more ? Buffer.from(JSON.stringify([last.created_at, last.job_id])).toString('base64url') : null };
  }

  async cancel(id) {
    await this.ready();
    const entry = this.#jobs.get(id);
    if (!entry) throw new JobError('not_found', 'Unknown job_id');
    if (entry.job.status === 'working') {
      this.#finish(entry, 'cancelled', { error: { code: 'cancelled', message: 'Job cancelled; execution may have started. Not retried.' } });
      entry.controller?.abort();
      await entry.settled;
      await entry.chain;
    }
    return this.#snapshot(entry);
  }

  // Deletes only terminal jobs. Capacity and the idempotency key are released synchronously; the snapshot is
  // unlinked after queued persistence so a late write cannot resurrect it.
  async delete(id) {
    await this.ready();
    const entry = this.#jobs.get(id);
    if (!entry) throw new JobError('not_found', 'Unknown job_id');
    if (!TERMINAL.has(entry.job.status)) throw new JobError('job_active', 'Job is still working; cancel_job it before deleting');
    this.#jobs.delete(id);
    const key = entry.job.idempotency?.key_hash;
    const ownsKey = key && this.#keys.get(key) === entry;
    if (ownsKey) this.#keys.delete(key);
    try {
      await entry.chain;
      await unlink(join(this.#dir, `${id}.json`)).catch(error => { if (error?.code !== 'ENOENT') throw error; });
    } catch (error) {
      // The snapshot may survive and resurrect on restart: keep the job visible so the caller can retry.
      this.#jobs.set(id, entry);
      if (ownsKey && !this.#keys.has(key)) this.#keys.set(key, entry);
      throw error;
    }
    return { job_id: id, deleted: true };
  }

  close() {
    return this.#closing ??= (async () => {
      await this.#ready?.catch(() => {});
      const unsettled = [...this.#active]; // Includes cancelled jobs deleted/purged while their runner unwinds.
      const entries = [...new Set([...this.#jobs.values(), ...unsettled])];
      for (const entry of entries.filter(e => e.job.status === 'working'))
        this.#interrupt(entry, 'Job interrupted by server shutdown; execution uncertain. Not retried.');
      for (const entry of unsettled) entry.controller?.abort();
      let timer;
      const grace = new Promise(resolve => { timer = setTimeout(resolve, this.#config.closeTimeoutMs ?? 5000); timer.unref?.(); });
      await Promise.race([Promise.all(unsettled.map(e => e.settled)), grace]);
      clearTimeout(timer);
      await Promise.all(entries.map(e => e.chain));
    })();
  }
}
