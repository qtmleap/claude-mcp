# claude-mcp

An MCP server that runs [Claude Code](https://code.claude.com/docs/en/overview) in non-interactive mode. Connect an MCP client over STDIO or Streamable HTTP to discover models and ask Claude to answer questions or work with a configured filesystem workspace.

## Tools

| Tool | Inputs | Output |
| --- | --- | --- |
| `models` | None | Model identifiers, discovery source and the server's workspace context |
| `ask` | `prompt`; optional `model`, `cwd`, `wait_ms`, `idempotency_key`, `execution_timeout_ms` | Quick completed answer or recoverable job receipt |
| `start_job` | Same inputs as `ask` | Immediate `job_id` and status |
| `get_job` | `job_id`; optional `wait_ms` (0–30000) | Safe assistant progress, terminal result or error |
| `list_jobs` | `limit` (default 20, max 100), `status`, `cursor` | Newest-first page `{jobs,count,has_more,next_cursor}` of metadata summaries (id, status, timestamps, model, cwd, `error_code`) without prompts, `partial_answer` or `result`; use `get_job` for output |
| `cancel_job` | `job_id` | Explicit process-group cancellation; terminal results remain unchanged |
| `delete_job` | `job_id` | Permanently deletes a terminal job and its snapshot; active jobs are rejected (`job_active`), unknown or already-deleted ids return `not_found` |

`ask` starts an independent job and waits at most 30 seconds. A quick answer keeps the original answer shape. Longer work returns `job_id` with `working`; poll `get_job` until `completed`, `failed`, or `cancelled`. `start_job` returns immediately. CLI errors and permission denials remain errors. Generation has no default wall-clock deadline.

Use a stable `idempotency_key` when starting work that could have side effects. An identical retry returns the original job; a conflicting request is rejected. After an uncertain receipt, inspect `list_jobs` before resubmitting. Jobs are shared across HTTP protocol sessions. Closing a session or cancelling a wait does not stop generation.

A nonzero CLI exit remains `claude_exit`. When the CLI supplies a valid terminal error result, `error.details.cli_diagnostic` retains its redacted, single-line text (up to 1000 characters), `source: "result"`, and `truncated: true` when shortened. An explicit leading `API Error: 524`, for example, adds `http_status: 524`; this reports the upstream CLI failure, not an MCP transport timeout. URL credentials, paths, queries and fragments are omitted. Missing, malformed or success-shaped results keep the generic exit error. Diagnostics are untrusted CLI text, not instructions. This does not fix upstream timeouts or automatically retry failed work: inspect possible file changes before starting a new job.

The wrapper also forces `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`, independently of `CLAUDE_CODE_MAX_RETRIES=0`. Claude Code can otherwise replay a failed streaming request with `stream:false`, waiting for the entire generation before returning a response and potentially masking the original stream failure with a gateway timeout. This policy prevents that hidden replay; a streaming failure now fails the job instead of being rescued by a non-streaming retry. It does not repair the original stream failure, disable in-process compaction, or change conversation persistence. The behavior is verified against Claude Code 2.1.289 using a synthetic loopback server with no provider credentials or paid requests. Reverify after CLI upgrades:

```sh
CLAUDE_MCP_TEST_CLI=/absolute/path/to/claude node --test test/cli-streaming.test.mjs
```

Without `CLAUDE_MCP_TEST_CLI`, this opt-in installed-CLI check is skipped, not counted as a pass. It asserts the audited CLI version so an upgrade cannot silently reuse stale compatibility evidence.

## Install and run

Optional `CLAUDE_MCP_STREAM_DIAGNOSTICS=1` enables native stderr diagnostics.
Only allowlisted error classes, stream event counts and elapsed times are retained;
raw debug stderr is discarded and is never saved as a log or error message.
This diagnoses a first-stream failure; it does not itself repair a transport fault.

Finite print processes that return a valid terminal result but fail to exit within ten
seconds fail with `cli_shutdown_timeout`; their conversation cannot be resumed. The
ten-second grace covers the CLI's measured normal background-shell cleanup (about
five seconds with CLI 2.1.289); success still requires a natural zero exit. Invalid or
mismatched terminal results keep a five-second bound, and cancellation and explicit
execution deadlines still take precedence. This grace addresses that demonstrated
false timeout only; it is not an explanation of the original lost-stream incident.
After the process exits, inherited pipes cannot keep polling or cancellation stuck.

Native execution requires Node.js 22 or newer, Claude Code on `PATH`, and the authentication required by your Claude provider or gateway. The Docker image includes Node.js and Claude Code.

```sh
git clone https://github.com/qtmleap/claude-mcp.git
cd claude-mcp
npm ci
```

Configure your credentials in the process environment. Use the authentication method your provider accepts:

```sh
# Bearer-token gateway:
export ANTHROPIC_BASE_URL=https://gateway.example.com
export ANTHROPIC_AUTH_TOKEN=YOUR_TOKEN
# Or x-api-key authentication:
export ANTHROPIC_API_KEY=YOUR_API_KEY
```

For native STDIO:

```sh
node src/main.mjs --transport stdio
```

For native HTTP:

```sh
CLAUDE_MCP_WORKSPACE=/absolute/path/to/project node src/main.mjs --transport http
```

HTTP listens on `127.0.0.1:8877` by default. The MCP endpoint is `/mcp`; `/healthz` reports service health. A healthy service does not by itself confirm provider authentication.

## Docker Compose

A standalone [compose.yaml](compose.yaml) is included. Copy [.env.example](.env.example) to `.env`, configure your provider and workspace, then build and start:

```sh
cp .env.example .env
# Edit .env before starting.
docker compose up -d --build
```

The following minimal `compose.yaml` example mounts a project directory and passes credentials from the environment:

```yaml
services:
  claude-mcp:
    build: .
    image: claude-mcp:local
    environment:
      HOST: 0.0.0.0
      PORT: 8877
      CLAUDE_MCP_WORKSPACE: /workspace
      ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL:-}
      ANTHROPIC_AUTH_TOKEN: ${ANTHROPIC_AUTH_TOKEN:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      CLAUDE_MCP_MODELS: ${CLAUDE_MCP_MODELS:-sonnet,opus,haiku}
    ports:
      - '127.0.0.1:${CLAUDE_MCP_PORT:-8877}:8877'
    volumes:
      - type: bind
        source: ${CLAUDE_MCP_HOST_WORKSPACE:-.}
        target: /workspace
        bind:
          create_host_path: false
    restart: unless-stopped
```

Set `CLAUDE_MCP_HOST_WORKSPACE` to an existing directory on the Docker host. Relative paths resolve from the Compose project directory. The container sees that directory at `/workspace`, so `cwd` and paths in prompts must use container paths. The included configuration publishes only a loopback port; set `CLAUDE_MCP_PORT` to another available port if needed.

To preserve an absolute host path inside the container, mount it at the same absolute destination and set `CLAUDE_MCP_WORKSPACE` to that destination. Configure additional bind mounts and `CLAUDE_MCP_MOUNTED_ROOTS` when exposing multiple directories. File permissions must allow the container's non-root user to access the mounted files.

Gateway credentials are read at startup. After changing them, recreate the service with `docker compose up -d --force-recreate claude-mcp`. Do not commit `.env` or place credentials in the Docker build context.

## Connect an MCP client

For Streamable HTTP, configure the client with:

```text
http://127.0.0.1:8877/mcp
```

A native STDIO client configuration can use an absolute path to the entrypoint:

```json
{
  "mcpServers": {
    "claude-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/claude-mcp/src/main.mjs", "--transport", "stdio"],
      "env": {
        "CLAUDE_MCP_WORKSPACE": "/absolute/path/to/project"
      }
    }
  }
}
```

The client must supply the provider environment to that process. For Docker STDIO, use `docker compose exec -T claude-mcp node src/main.mjs --transport stdio` with the Compose project directory configured as the command's working directory, or pass an absolute `-f` Compose file path. STDIO stdout is reserved for MCP; diagnostics use stderr.

## Workspace and permissions

For ordinary questions, omit `cwd`:

```json
{"prompt": "What is 1 + 1?", "model": "sonnet"}
```

The default native workspace is the server process's current directory. Docker defaults to `/workspace`. Relative `cwd` resolves from `CLAUDE_MCP_WORKSPACE`; absolute `cwd` is checked against `CLAUDE_MCP_MOUNTED_ROOTS`. All paths refer to the **MCP server's filesystem**, which may differ from the client's filesystem. Do not automatically copy the client's current directory into `cwd`.

Call `models` to inspect `execution_context.default_cwd` and `execution_context.mounted_roots`. Missing, inaccessible, non-directory or out-of-scope cwd values fail before Claude starts. `invalid_cwd` reports the reason, requested/resolved paths, available roots and `execution_started: false`; the server never silently switches a file task to another workspace.

By default, `acceptEdits` permits file edits and `Read,Grep,Glob` are explicitly allowed. Other tools requiring approval are denied because no interactive permission prompt is available. Configure `CLAUDE_MCP_ALLOWED_TOOLS` or `CLAUDE_MCP_PERMISSION_MODE` for your workflow. A `permission_denials` result is reported as an error even when Claude also produced an answer.

Such errors use code `permission_denied` with `details` containing the unique denied `tool_names`, `permission_mode`, `allowed_tools`, `cwd` and `execution_started: true` (tools may already have run). Terminal errors omit tool inputs and clear retained partial answers once the denial is observed; earlier live progress cannot be withdrawn. Configured secrets are redacted. `models` reports `execution_context.permission_mode` and `allowed_tools` so callers can see in advance which tools (e.g. `Bash`) are not permitted.

Every configured mounted root is canonicalised and passed to Claude as `--add-dir`, so sibling repositories under the advertised roots are available from the selected `cwd` for reading and, under the configured permissions, writing. `cwd` is not a write boundary. Only configured roots are added; a missing or inaccessible root fails the call before Claude starts (`mounted_root_unavailable`). This does not bypass permissions.

Allowing `Bash` enables native command execution with the child process environment and read-write mounted workspaces. Only enable it for trusted delegated work; command output redaction matches configured secret strings and is not a sandbox or protection against encoded output. Use command-specific Bash allow rules when a deployment only needs inspection commands. Global defaults remain `Read,Grep,Glob`.

MCP authentication is optional: set `CLAUDE_MCP_TOKEN` to require a bearer token on `/mcp`. Host and browser Origin checks protect the local endpoint. External hosting requires its own access controls and frontend configuration.

Only `cancel_job`, an explicitly supplied `execution_timeout_ms`, or server shutdown terminates generation. Request deadlines and transport disconnects only stop waiting. Shutdown cleans up owned process groups and persists active jobs as `failed` with `interrupted` and execution uncertainty; restart never reruns them. Same-group descendants are cleaned up on normal exit.

Each state directory must have one server process owner. Do not launch another HTTP or STDIO server against the same directory while the first is running; STDIO processes may share a configured directory because each uses its own run subdirectory (see below).

Snapshots retain redacted assistant text and final results, never prompts, hidden thinking, tool inputs or tool results. Atomic snapshots use private directory/file permissions (0700/0600). Native HTTP state defaults to `~/.local/state/claude-mcp/jobs`; each standalone STDIO process uses its own unique run subdirectory `<state dir>/stdio/<uuid>`, even with a configured state directory. STDIO jobs and results are only available within the owning process: after exit the run snapshots stay on disk but are not reloaded automatically, and those run directories need manual cleanup (they are never deleted automatically, since they may hold useful records). HTTP state is stable and recoverable across reconnects and restarts. An `ask` whose job is cancelled while waiting returns an MCP error (`cancelled`, with `details.job_id`); `get_job` still returns the cancelled snapshot normally. Docker uses `/var/lib/claude-mcp/jobs` on the included `claude-mcp-state` named volume. Retention is seven days and capacity 128 retained jobs / 4 concurrent jobs by default. Expired terminal files are removed on subsequent operations. Retained terminal jobs count toward capacity and are never evicted automatically: a full store rejects new work (`capacity`; `cancel_job` does not free history, and a cancelled job keeps its concurrency slot until its process has exited) until you `delete_job` finished jobs or they pass retention. Deleting frees capacity and the idempotency key immediately and survives restart. Job tools are single-tenant: any authenticated caller can list, read, cancel and delete all jobs.

## Resumable review conversations (opt-in)

`ask`/`start_job` accept `resumable`, `resume_job_id`, `review` and `max_budget_usd` (finite, >0, <=100, passed as `--max-budget-usd`). Default calls keep no native conversation transcript (`--no-session-persistence`); job receipts and results retain their existing policy.

- `review:true` enforces, on every launch, `--bare --restricted --tools Read,Grep,Glob --disallowedTools 'mcp__*' --strict-mcp-config` with an empty MCP config, no extra `--add-dir` roots and no Bash/Edit/Write/hooks/plugins, plus an appended instruction to read applicable AGENTS/CLAUDE files and stick to the supplied scope.
- `resumable:true` (requires explicit `model` and `review:true`) allocates a native session UUID server-side (`--session-id`). Transcripts, including prompts and answers, are kept under `CLAUDE_MCP_SESSION_DIR` (0700/0600) until expiry (job retention), cleaned up on later session operations (best effort; per-directory failures are logged and quarantined). Claimed or unreadable/rootless state is quarantined for explicit operator inspection, never deleted on an age/PID guess.
- `resume_job_id` (exclusive with `resumable`) continues from the conversation's **current successful head** (`--resume`). Model, cwd and review are inherited; explicit mismatches are rejected (`session_mismatch`). Once reserved, every attempt becomes the head before launch (even a later setup/shutdown/persistence failure): a failed, cancelled or interrupted turn blocks the conversation (`chain_blocked`), an older job is `stale_ancestor`, and a second concurrent turn (any connection or process) gets `chain_busy`. There is no automatic recovery, reset or fork: start a new chain. A claim is never overridden by age or numeric PID: an unconfirmed owner remains quarantined.
- Results and snapshots carry `session: {id, cli_session_id, resume_available}`; `result.usage` holds per-invocation `invocation` tokens, conversation-cumulative `conversationModelUsage`/`conversationCostUSD`, and `invocationCostDeltaUSD` (null when unknown, e.g. a cost decrease after a reset). A missing cost invalidates the next delta; a reported cost reset establishes a new baseline. Valid accounting from failed CLI results is also retained in `error.details.usage`. These are CLI estimates, not billing records; session reuse does not guarantee provider cache hits or lower total usage. Nothing is guessed and no savings percentage is claimed.
- `delete_job` deletes only the receipt/result and idempotency record. It does **not** erase the independent native transcript or root: the current successful head can still be resumed until conversation expiry. To erase a conversation early, an operator must first confirm it has no active owner, then remove only its UUID directory under `CLAUDE_MCP_SESSION_DIR`. Never remove a claimed/active conversation.
- A successful result can briefly have `session.resume_available:false` while persistence settles. Poll `get_job` with a bounded wait before resuming or starting a replacement; the successful answer alone does not confirm readiness.
- Completion keeps final text only in `result.answer`; `partial_answer` is live progress and becomes empty. All calls gain additive normalized usage fields, including stateless calls.
- Scope: single-owner local MCP boundary; the file claim excludes concurrent processes sharing the state volume, it is not a multitenant ACL.

Review workflow: the caller builds a source-fingerprinted diff manifest with native git (revision, ranges, fingerprint) and sends or references it in the first request; each resume sends only the delta and the new fingerprint. The server computes no diffs and caches no review results, and a follow-up must re-inspect the changed source rather than reuse a stale approval.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | Claude CLI default | Anthropic-compatible gateway URL |
| `ANTHROPIC_AUTH_TOKEN` | unset | Bearer-token authentication |
| `ANTHROPIC_API_KEY` | unset | x-api-key authentication |
| `ANTHROPIC_CUSTOM_HEADERS` | unset | Newline-separated gateway headers |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | unset | Optional Cloudflare Access headers |
| `CLAUDE_MCP_WORKSPACE` | Process cwd; Docker `/workspace` | Default working directory |
| `CLAUDE_MCP_MOUNTED_ROOTS` | Workspace | Comma-separated accessible workspace roots |
| `CLAUDE_MCP_MODELS` | empty | Explicit fallback model IDs or Claude aliases |
| `CLAUDE_MCP_COMMAND` | `claude` | CLI executable |
| `CLAUDE_MCP_WAIT_MS` | `10000` | Default bounded ask wait, capped at 30000 ms |
| `CLAUDE_MCP_JOB_DIR` | Native state directory | Private durable snapshot directory |
| `CLAUDE_MCP_SESSION_DIR` | `sessions` beside the job dir | Private per-conversation state (root record, claim, native CLI config/transcripts) for resumable chains; keep it on the same persistent volume |
| `CLAUDE_MCP_MAX_JOBS` | `128` | Maximum retained jobs |
| `CLAUDE_MCP_MAX_CONCURRENT_JOBS` | `4` | Maximum running jobs |
| `CLAUDE_MCP_JOB_RETENTION_MS` | `604800000` | Terminal result retention |
| `CLAUDE_MCP_SESSION_IDLE_MS` | `300000` | Idle HTTP session expiry (1000–86400000) |
| `CLAUDE_MCP_MAX_SESSIONS` | `64` | Maximum HTTP protocol sessions (1–1024) |
| `CLAUDE_MCP_MAX_OUTPUT_BYTES` | `1048576` | Combined CLI output and per-page model response limit |
| `CLAUDE_MCP_MODELS_TIMEOUT_MS` | `10000` | Model-discovery deadline |
| `CLAUDE_MCP_PERMISSION_MODE` | `acceptEdits` | CLI permission mode |
| `CLAUDE_MCP_ALLOWED_TOOLS` | `Read,Grep,Glob` | Tools allowed without prompting |
| `CLAUDE_MCP_TOKEN` | unset | Optional MCP authentication |
| `HOST`, `PORT` | `127.0.0.1`, `8877` | Native HTTP bind |
| `CLAUDE_MCP_HOST_WORKSPACE` | `.` | Compose-only host bind source |
| `CLAUDE_MCP_PORT` | `8877` | Compose-only published host port |

**Breaking change:** `ask.timeout_ms` no longer bounds execution; it is a deprecated wait alias, clamped to 30 seconds; it no longer kills generation. The legacy `CLAUDE_MCP_TIMEOUT_MS` environment setting is likewise a wait alias if `CLAUDE_MCP_WAIT_MS` is absent. Use `execution_timeout_ms` only when an actual execution deadline is intended. Polling waits should stay below the client request deadline. Model discovery queries `/v1/models` (or `/models` for a base ending in `/v1`), supports bounded pagination and rejects redirects. If unavailable, only the explicit `CLAUDE_MCP_MODELS` list is returned with `source: configured` and a reason. `ask.model` accepts any model identifier supported by your gateway.

HTTP initialization returns an MCP session ID used for later requests. Cancellation notifications stop request waiting only; use `cancel_job` to stop generation. Sessions are bounded by `CLAUDE_MCP_MAX_SESSIONS` (default 64) and expire after `CLAUDE_MCP_SESSION_IDLE_MS` (default 5 minutes) of idleness, measured from the end of the last response; in-flight calls are never expired or evicted, and job completion never closes a session. Job results, `get_job` and idempotency live in the job store, not the session, so they remain available after a session expires. Reinitialize an expired session (404). JSON-RPC batches are rejected before execution.

## Development and verification

```sh
npm test
npm audit --omit=dev
# Smoke tests requiring a working provider connection:
node scripts/verify.mjs http
node scripts/verify.mjs stdio
node scripts/verify.mjs docker-stdio
```

Use `CLAUDE_MCP_URL`, `CLAUDE_MCP_TOKEN`, `CLAUDE_MCP_VERIFY_MODEL` and `CLAUDE_MCP_COMPOSE_DIR` to select the endpoint or runtime. An optional real file check reads a JSON package file and validates its name:

```sh
CLAUDE_MCP_VERIFY_FILE=/workspace/package.json \
CLAUDE_MCP_VERIFY_EXPECTED=claude-mcp \
node scripts/verify.mjs http
```

Tests use isolated temporary workspaces and fake CLI processes for failure paths. No account credentials are required for the test suite. Live smoke tests call the provider once per probe and do not automatically retry failures.

The Dockerfile uses BuildKit bind mounts for dependency manifests and cache mounts for package downloads. These build-time mounts are separate from the runtime workspace bind mount configured in Compose.

## Publishing the image

Pushes to `master` that pass the Test workflow run the Publish workflow, which publishes `ghcr.io/qtmleap/claude-mcp` for `linux/amd64` and `linux/arm64` as `<version>` and `sha-<commit>`, then moves `latest` to that verified digest. It publishes only when `package.json`'s `version` differs from the merged commit's first parent; otherwise the run ends with a skip note in its summary. To release, raise `version` in `package.json`, `package-lock.json` (the root and `packages[""]` entries) and `src/server.mjs` in a pull request, and merge it as a merge or squash commit. An existing version tag is never overwritten: if it already exists, the workflow fails.

If a multi-commit push changed the version before the tip, or master advances before publication starts, that version is skipped. If verification or promotion fails after pushing a version tag, the immutable version remains published and `latest` may be unchanged. These cases deliberately fail closed: do not replay or overwrite the old tag; recover by merging a pull request with a new patch version.

## Container design

The multi-stage Dockerfile installs packages in a Debian builder and copies production dependencies into a Distroless Node.js runtime. Dependency manifests are read using BuildKit bind mounts, download caches stay in cache mounts, and independent runtime layers use `COPY --link`. The final image has no npm, apt or build cache.

Claude Code can invoke shell commands, so the Distroless-based runtime includes Bash, standard command-line utilities, Git, ripgrep and the OpenSSH client with their required libraries. A shell-free runtime would break those workflows. The container runs as UID/GID 1000 with a writable home and workspace, and tini handles child-process reaping. Project-specific runtimes and compilers must be supplied separately when needed.

BuildKit is required. The builder and runtime use Debian 13 to keep shared-library compatibility. `CLAUDE_CODE_VERSION` is a build argument for the pinned native CLI release. Do not pass runtime provider credentials as build arguments; they are supplied only when the container starts.
