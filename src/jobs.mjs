import { createHash, randomBytes } from 'node:crypto';
import { mkdir, chmod, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAsk, resolveCwd, redact, RunnerError } from './runner.mjs';

const MAX_WAIT_MS = 30000;
const NO_DEADLINE_MS = 0; // Runner uses no timer when omitted/zero.
const ID_PATTERN = /^job_[A-Za-z0-9_-]{1,64}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const DROPPED_KEYS = new Set(['tool_input', 'tool_inputs', 'input', 'inputs', 'thinking', 'prompt']);

export class JobError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const timeOf = job => Date.parse(job.updated_at);

export class JobStore {
  #config; #run; #dir; #maxJobs; #maxConcurrent; #retentionMs; #maxOutput;
  #jobs = new Map(); #keys = new Map(); #ready; #closing;

  constructor(config, { run = runAsk } = {}) {
    this.#config = config; this.#run = run;
    this.#dir = config.stateDir ?? join(homedir(), '.local', 'state', 'claude-mcp', 'jobs');
    this.#maxJobs = config.maxJobs ?? 128;
    this.#maxConcurrent = config.maxConcurrentJobs ?? 4;
    this.#retentionMs = config.jobRetentionMs ?? 7 * 24 * 3600 * 1000;
    this.#maxOutput = config.maxOutput ?? 1024 * 1024;
  }

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
    Object.assign(entry.job, { status, updated_at: new Date().toISOString(), ...fields });
    this.#persist(entry).catch(() => {});
    for (const wake of [...entry.waiters]) wake();
  }

  #snapshot({ job }) {
    const { job_id, status, created_at, updated_at, model, cwd, partial_answer, result, error } = job;
    return structuredClone({ job_id, status, created_at, updated_at, model, cwd, partial_answer, result, error });
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
    const cwd = await resolveCwd(args.cwd, this.#config.root, this.#config.mountedRoots ?? [this.#config.root]);
    // No await between here and registering the job, so concurrent starts, deletes and purges cannot interleave.
    if (this.#closing) throw new JobError('closed', 'Job store is closed');
    this.#purge();
    const fingerprint = sha256(JSON.stringify([args.prompt, args.model ?? null, cwd, args.execution_timeout_ms ?? null]));
    const keyHash = args.idempotency_key == null ? null : sha256(String(args.idempotency_key));
    if (keyHash) {
      const existing = this.#keys.get(keyHash);
      if (existing) {
        if (existing.job.idempotency.fingerprint !== fingerprint)
          throw new JobError('idempotency_conflict', 'idempotency_key was already used with different arguments');
        return this.#snapshot(existing);
      }
    }
    const running = [...this.#jobs.values()].filter(e => e.job.status === 'working').length;
    if (this.#jobs.size >= this.#maxJobs || running >= this.#maxConcurrent)
      throw new JobError('capacity', 'Job capacity reached; wait for jobs to finish or cancel one');
    const now = new Date().toISOString();
    const entry = this.#entry({ job_id: `job_${randomBytes(16).toString('hex')}`, status: 'working', created_at: now, updated_at: now,
      model: args.model ?? null, cwd, partial_answer: '', result: null, error: null,
      idempotency: { key_hash: keyHash, fingerprint } });
    if (keyHash) this.#keys.set(keyHash, entry);
    entry.controller = new AbortController();
    const snapshot = this.#snapshot(entry);
    try { await this.#persist(entry); }
    catch (error) {
      this.#jobs.delete(entry.job.job_id); if (keyHash) this.#keys.delete(keyHash);
      throw error;
    }
    entry.settled = this.#execute(entry, args, cwd);
    return snapshot;
  }

  async #execute(entry, args, cwd) {
    const { prompt, model, execution_timeout_ms } = args;
    const runArgs = { prompt, cwd, ...(model ? { model } : {}),
      timeout_ms: execution_timeout_ms ?? NO_DEADLINE_MS };
    const onProgress = ({ partial_answer } = {}) => {
      if (entry.job.status !== 'working' || typeof partial_answer !== 'string') return;
      entry.job.partial_answer = redact(partial_answer, this.#config.env).slice(-this.#maxOutput);
      entry.job.updated_at = new Date().toISOString();
      this.#persist(entry).catch(() => {});
    };
    try {
      const result = await this.#run(runArgs, this.#config, entry.controller.signal, { onProgress, stream: true });
      if (entry.job.status === 'working') this.#finish(entry, 'completed', { result: this.#sanitize(result), error: null });
    } catch (error) {
      if (entry.job.status === 'working') this.#finish(entry, error?.code === 'cancelled' ? 'cancelled' : 'failed', { error: this.#error(error),...(error?.code==='permission_denied'?{partial_answer:''}:{}) });
    }
    await entry.chain;
  }

  async get(id, wait_ms = 0) {
    await this.ready(); this.#purge();
    const entry = this.#jobs.get(id);
    if (!entry) throw new JobError('not_found', 'Unknown job_id');
    const wait = Math.min(Math.max(Number(wait_ms) || 0, 0), MAX_WAIT_MS);
    if (wait > 0 && entry.job.status === 'working') {
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); entry.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, wait);
        entry.waiters.add(wake);
      });
    }
    if(TERMINAL.has(entry.job.status))await entry.chain;
    return this.#snapshot(entry);
  }

  async list() {
    await this.ready(); this.#purge();
    return [...this.#jobs.values()].map(e => this.#summary(e)).sort((a, b) => a.created_at.localeCompare(b.created_at));
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
      const entries = [...this.#jobs.values()];
      const live = entries.filter(e => e.job.status === 'working');
      for (const entry of live) {
        this.#interrupt(entry, 'Job interrupted by server shutdown; execution uncertain. Not retried.');
        entry.controller?.abort();
      }
      let timer;
      const grace = new Promise(resolve => { timer = setTimeout(resolve, this.#config.closeTimeoutMs ?? 5000); timer.unref?.(); });
      await Promise.race([Promise.all(live.map(e => e.settled)), grace]);
      clearTimeout(timer);
      await Promise.all(entries.map(e => e.chain));
    })();
  }
}
