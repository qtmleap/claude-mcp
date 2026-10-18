import { randomBytes } from 'node:crypto';
import { mkdir, chmod, readdir, readFile, writeFile, rename, unlink, rm, open } from 'node:fs/promises';
import { join } from 'node:path';

export class SessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const INSTANCE = randomBytes(8).toString('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// One private directory per conversation: root.json (atomic record), claim (exclusive O_EXCL file), claude/ (CLI config dir).
// Single-owner local boundary: the claim excludes concurrent processes, it is not a multitenant ACL.
// A claim is never overridden by age; blocked conversations are abandoned by starting a new chain.
export class SessionChains {
  #dir; #ttl;
  constructor(dir, ttlMs) { this.#dir = dir; this.#ttl = ttlMs; }

  async init() {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await chmod(this.#dir, 0o700);
    for (const id of await readdir(this.#dir)) {
      if (!UUID.test(id)) continue;
      const root = await this.read(id);
      // A missing root may belong to a concurrent creator, not abandoned state.
      if (!root || Date.parse(root.expires_at) > Date.now()) continue;
      try { await this.#claim(id, 'retention'); } catch { continue; }
      try {
        const current = await this.read(id);
        if (current && Date.parse(current.expires_at) <= Date.now()) {
          // Keep root.json if transcript removal fails, so the next sweep can retry.
          await rm(join(this.#dir, id, 'claude'), { recursive: true, force: true });
          await rm(join(this.#dir, id), { recursive: true, force: true });
        }
      } catch (error) {
        // One unreadable/busy expired directory must not block unrelated admissions.
        console.warn(`Session retention cleanup failed for ${id}: ${error.code ?? 'unknown'}`);
      } finally { await this.#release(id); }
    }
  }

  #path(id, name) { return join(this.#dir, id, name); }
  async read(id) {
    try { const root = JSON.parse(await readFile(this.#path(id, 'root.json'), 'utf8')); return root?.uuid === id ? root : null; } catch { return null; }
  }
  async #write(root) {
    const file = this.#path(root.uuid, 'root.json'), tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try { await writeFile(tmp, JSON.stringify(root), { mode: 0o600 }); await chmod(tmp, 0o600); await rename(tmp, file); }
    catch (error) { await unlink(tmp).catch(() => {}); throw error; }
  }
  async #claim(id, jobId) {
    try { const h = await open(this.#path(id, 'claim'), 'wx', 0o600); await h.writeFile(JSON.stringify({ job_id: jobId, pid: process.pid, instance: INSTANCE })); await h.close(); }
    catch (error) {
      if (error.code === 'EEXIST') throw new SessionError('chain_busy', 'Another turn of this conversation is in flight or its owner did not release it; start a new chain if it never finishes');
      throw error;
    }
  }
  #release(id) { return unlink(this.#path(id, 'claim')).catch(() => {}); }
  // PID namespaces/reuse prevent proving that an existing claim is abandoned.
  // Only quarantine an unconfirmed head when an exclusive claim is available.
  async recover(id, jobId) {
    try { await this.#claim(id, jobId); } catch { return; }
    try {
      const root = await this.read(id);
      if (root?.head_job_id === jobId) await this.#write({ ...root, state: 'blocked' });
    } finally { await this.#release(id); }
  }
  #expiry() { return new Date(Date.now() + this.#ttl).toISOString(); }

  async create({ jobId, cwd, model, review, policy }) {
    const uuid = crypto.randomUUID(), configDir = this.#path(uuid, 'claude');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(this.#path(uuid, '.'), 0o700); await chmod(configDir, 0o700);
    await this.#claim(uuid, jobId);
    await this.#write({ uuid, head_job_id: jobId, state: 'inflight', cwd, model, review, policy, baseline_cost: 0, created_at: new Date().toISOString(), expires_at: this.#expiry() });
    return { id: uuid, uuid, configDir, mode: 'new', previousCost: 0 };
  }

  // Finds the conversation whose current head is jobId (jobs may have been pruned from the job store).
  async findByHead(jobId) {
    for (const id of await readdir(this.#dir).catch(() => [])) {
      const root = UUID.test(id) ? await this.read(id) : null;
      if (root?.head_job_id === jobId && Date.parse(root.expires_at) > Date.now()) return root;
    }
    return null;
  }

  // Atomically makes jobId the head before launch: any later attempt (not only success) supersedes the parent.
  async reserve(id, parentJobId, jobId) {
    await this.#claim(id, jobId).catch(error => { throw error.code === 'ENOENT' ? new SessionError('not_found', 'Unknown conversation') : error; });
    try {
      const root = await this.read(id);
      if (!root || Date.parse(root.expires_at) <= Date.now()) throw new SessionError('not_found', 'Conversation expired');
      if (root.head_job_id !== parentJobId) throw new SessionError('stale_ancestor', `resume_job_id is not the current head of its conversation (${root.head_job_id}); resume the latest job`);
      if (root.state !== 'ready') throw new SessionError('chain_blocked', 'The latest turn of this conversation did not complete successfully; the conversation cannot be resumed. Start a new chain');
      const configDir = this.#path(id, 'claude');
      const projects = await readdir(join(configDir, 'projects')).catch(() => []);
      if (!(await Promise.all(projects.map(d => this.#exists(join(configDir, 'projects', d, `${id}.jsonl`))))).some(Boolean)) {
        await this.#write({ ...root, state: 'blocked' });
        throw new SessionError('transcript_missing', 'The native transcript for this conversation is missing; it cannot be resumed. Start a new chain');
      }
      await this.#write({ ...root, state: 'inflight', head_job_id: jobId, expires_at: this.#expiry() });
      return { root, session: { id, uuid: id, configDir, mode: 'resume', previousCost: root.baseline_cost ?? null } };
    } catch (error) { await this.#release(id); throw error; }
  }
  #exists(file) { return open(file, 'r').then(h => h.close().then(() => true), () => false); }

  // Missing accounting stays unknown; a reported reset becomes a new baseline,
  // while normalizeUsage marks that invocation's decreasing delta unknown.
  async settle(id, ready, cost) {
    try {
      const root = await this.read(id);
      if (!root) throw new SessionError('session_state_missing', 'Conversation state is unavailable; start a new chain');
      await this.#write({ ...root, state: ready ? 'ready' : 'blocked',
        baseline_cost: ready && Number.isFinite(cost) && cost >= 0 ? cost : null, expires_at: this.#expiry() });
    } finally { await this.#release(id); }
  }
}
