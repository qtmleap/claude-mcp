# Shared MCP with explicit project execution contexts

## Intent and accepted direction

The user wants several clients to share the existing authenticated MCP service.
Keep authentication setup central and avoid additional MCP servers. Improve the
current mismatch between a mounted project directory and the actual toolchain:
the central worker lacks Python, while HackerOne's existing Dev Container has
Python, analysis tools, project dependencies, and Claude Code.

The conversation considered direct CLI calls, adding tools to the central image,
and project execution through the shared MCP. The user asked to improve this
repository after explaining the multi-client and credential-management needs.
Use administrator-defined execution profiles, retaining the current local
backend. The coordinator chooses the details below within that direction.

## Baseline and source boundary

Host studio. Primary `/Users/devonly/Developer/claude-mcp` remains on its old
`codex/claude-mcp` branch at `2f913059f1653998114e2feb411007e4946a0652`, with
preexisting dirty work. Its public snapshot is retained under ignored
`.local-records/execution-profiles-20261117/`; private `.env`/state were excluded.
The running image reports revision `60d02b10b8e7525132ce94b343433dd01755f135`.
Live github.com master is newer:
`a5eeb33ee426d9e7ae9e81bb5b0e0b1497df4adc`, confirmed with ls-remote.

Use the CLEAN public-master worktree
`/Users/devonly/Developer/claude-mcp-worktrees/project-contexts`, branch
`feat/project-execution-contexts`, base `a5eeb33`. It includes current async
features, upstream diagnostics, split runner modules, and dependency fixes.
The initial dirty-baseline copy is retained separately for provenance, not used
as the implementation base. Inspect current actual files before modifying them.

Never discard, stage wholesale, or overwrite the preexisting changes. Review and
integration use the new task delta against public master. Do not deploy,
restart the shared runtime, push, expose new ports, or create another MCP/model
server as part of source implementation. Existing production clients keep their
endpoint and credentials.

## Architecture and API

- Keep one shared HTTP service and its JobStore. STDIO still means one process;
  document HTTP as the normal multi-client configuration and its current trusted
  single-tenant job visibility. No new multi-user authorization system.
- Preserve omitted-profile behavior as the existing `local` backend. Add an
  optional `execution_profile` ID to ask/start_job. Callers cannot supply Docker
  commands, containers, users, environment values, mounts, or executable paths.
- Load a trusted operator-owned profile registry from a configured JSON file.
  This registry contains no secrets: fixed existing container name, expected
  project mount/labels, execution user, target roots, absolute CLI/Node paths,
  and bounded fixed tool probes. Unknown/malformed profiles fail closed.
- Add a read-only `execution_context` tool selecting a profile and optional cwd.
  Return configured-versus-probed status, actual OS, canonical target cwd/roots,
  resolved container ID, CLI version and bounded probe outcomes. Do not claim
  tools are installed merely because a profile lists them. `models` reports the
  default context and available profile IDs without silently moving execution.
- `cwd` belongs to the selected execution environment. Docker calls use target
  paths such as `/home/vscode/app`; do not automatically reinterpret Mac paths
  or rewrite prompt text. The tool metadata/instructions must say this clearly.
- Docker preflight inspects the configured existing container, verifies it is
  running and matches expected mount/labels, validates cwd and symlink containment
  inside that target, and pins its exact ID for execution and cleanup. It never
  creates/starts containers or changes mounts. Reject failed preflight before
  Claude starts, with `execution_started:false`.
- Include safe execution-context evidence in new receipts/results and job-list
  metadata. Preserve existing fields and legacy local behavior.
- Supply the worker itself with a concise factual context note: actual execution
  OS/backend, cwd/roots, and observed versus unprobed tools. For Docker jobs use
  the verified preflight evidence. Combine this with existing review instructions
  rather than overwriting them or adding conflicting prompt flags. Context is
  evidence, not a permission grant; never describe the coordinator's tools as
  target tools. Keep local resume policy compatibility and tool restrictions.

## Central credentials and configuration

The user's constraint is avoiding repeated persistent/manual credential setup.
It is not a request for a new token-relay service. Keep existing provider/gateway
settings central. For a trusted project invocation, construct a small allowlist
of required provider/gateway variables in memory and forward only those values
to the CLI process, with no secret values in argv, profile JSON, public metadata,
logs, or checked-in files. Do not forward the server's whole environment, MCP
bearer token, unrelated service credentials, Docker credentials, or human config.
Secrets may exist transiently in the trusted child process environment; document
that boundary accurately. Do not build another authentication proxy.

Use a private per-job CLI config/state directory, cleaned after the stateless
job. Prevent human/project settings from silently replacing provider routing or
authentication for the remote invocation; preserve source instruction discovery
where supported and make any explicit loading rule visible to callers. Maintain
the existing enforced read-only review flags. Test the actual argv/environment
policy, not merely an instruction promising the policy.

An operator who enables Docker execution must provide a Docker client and access
to the intended daemon. Supply an opt-in deployment example; do not mount the
socket or grant control in the default Compose setup. Explain the daemon's
authority. Reuse the existing image/service identity and central credentials.
Do not copy another project's Compose image to start a new container.

For oMLX deployments requiring serialized inference, document the existing
`CLAUDE_MCP_MAX_CONCURRENT_JOBS=1` setting. Keep the generic default unchanged;
do not add another queue/model service or infer model quality from a name.

## Job lifecycle, cancellation, and sessions

Docker exec requires a real backend lifecycle, not just a command prefix. A
nonce-owned helper inside the target runs Claude in its own process group,
tracks the owned resource identity, drains output, and performs bounded cleanup.
Explicit cancel/deadline/shutdown cleans the target group/known descendants and
confirms the outcome; killing the local Docker client alone is insufficient.
Never kill an unrelated process, stop a container, or guess a PID. Detect stale
identity/recreated containers. If cleanup cannot be confirmed, retain safe
resource evidence and report the uncertainty; never report a clean success or
automatically retry the generation. HTTP disconnect/wait cancellation continues
to leave generation running as today.

Keep current local resumable reviews intact. Initial Docker profiles are
stateless: reject `resumable`/`resume_job_id` on them explicitly before generation
or state allocation. A resume of a local chain with a different profile must be
rejected, never silently executed locally. Include profile/policy in new
idempotency fingerprints while keeping omitted local legacy retries compatible.
An identical retry returns its original job even if its container is now gone;
a changed profile or target-policy configuration must not reuse a key to launch
work in another environment. Retained jobs remain inspectable after restart.

## Verification and ownership

Native Codex implementer owns runtime/test code; main coordinates, writes prose
and configuration guidance, and verifies actual results. The prior preferred
Claude worker ended with gateway ECONNRESET, so no Claude review is claimed;
native feasibility inspection is the authorized alternative. LocalGPT performs
one independent plan review before substantive implementation and one final
actual-delta review after tests, with verified studio LocalMCP access.

Use existing Node tests and fake executables for profile validation, stable local
behavior, source-root/context accuracy, symlink escapes, argv/env secrecy,
idempotency and session rejection. Exercise remote helper cleanup with harmless
real process trees. Use the existing HackerOne container only for deterministic
preflight/tool/fixture checks, no model generation or device/app access. An
opt-in disposable fixture container may be built from a task-owned clean image
if necessary; never use another project's Compose image or shared runtime as a
destructive fixture. Register exact resource cleanup before creating anything.

Run the full existing npm test suite and production dependency audit. Inspect
the image workflow; validate changed image inputs with an isolated build where
available. Do not call a model merely to prove plumbing. README/examples must
cover shared clients, local versus target paths, credential ownership, profiles,
tool evidence, cancellation/uncertain outcomes, stateless remote limitations,
and operator-controlled migration without losing jobs/state.

## Non-goals

No new MCP/auth/model server, per-client credential copies, broad host exposure,
automatic container starts, live inference benchmark, blanket bypass permissions,
remote resumable transcript system, arbitrary shell execution API, or unrelated
rewrite of preexisting async/session changes.

## Independent review resolutions

LocalGPT gpt-6-thinking/extended reviewed the actual current worktree through
studio LocalMCP (job `884b3fc5-88d2-470a-89c0-d72466f7f1e7`); native Codex
feasibility review also read the current split runner. Both found v1 implementable.
No additional server, relay, tenant system, or remote resume system is needed.

- Supply an inactive Docker CLI in the server image from a verified official
  image/digest, plus an opt-in daemon/socket/UID configuration example. The
  default Compose service does not receive daemon access. Native mode may use
  an existing administrator-selected Docker executable.
- Use name-only `docker exec --env NAME` forwarding with a restricted local
  client environment. The target helper rebuilds Claude's environment rather
  than inheriting arbitrary container secrets. Redact all forwarded secret
  values, including custom-header values, across progress/errors/results.
- Resolve cwd inside the pinned target under its configured user and recheck
  containment before Claude launch. No local fallback or automatic mounts.
- Remote idempotency replay happens before live Docker preflight; persist a
  versioned normalized request/profile-policy fingerprint. Old omitted-local
  receipts keep their existing compatibility.
- Retain remote cleanup evidence after cancel/shutdown even though a job has
  become terminal. Update JobStore snapshots/summaries/reload, and coordinate
  bounded remote cleanup with current five-second shutdown/close budgets.
- Initial remote resume requests fail before session allocation. Current local
  review mounted-root behavior remains intact; fix the stale 'no extra roots'
  description rather than restoring that old behavior.
- Existing `verify` invokes a model and counts exactly seven tools. Add an
  explicit non-generating metadata/preflight verification mode, update tool
  expectations, and preserve opt-in live integration checks.

Baseline tests: 171 tests, 169 passed, 2 skipped, 0 failed on native Node26.8.2.
Baseline npm production audit reports 2 moderate transitive advisories in
`hono` and `@hono/node-server`, no high/critical. Apply only compatible dependency
resolution fixes needed for the required audit gate; inspect lockfile scope and
rerun affected tests. Never hide this preexisting audit failure as a passing check.
