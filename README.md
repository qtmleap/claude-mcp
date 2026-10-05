# claude-mcp

A thin MCP wrapper around **Claude Code**. It exposes exactly two tools, over STDIO or Streamable HTTP, and waits for the CLI's final JSON result. No Agent SDK, background job API or automatic request retries.

| Tool | Arguments | Result |
| --- | --- | --- |
| `models` | none | Gateway model IDs, `source: api` or explicit fallback, and host `execution_context` |
| `ask` | `prompt`, optional `model`, `cwd`, `timeout_ms` | Completed `answer`, requested model, resolved cwd and available duration/turn metadata |

`ask` may read/edit files or use allowed Claude tools. A failed response, timeout or disconnect can happen after a file operation has run: do not automatically resubmit it.

## Mac Studio deployment

The service runs alongside the existing LocalGPT stack:

- Compose: `/Users/devonly/Developer/local-gpt/compose.yaml` plus `compose.override.yaml`.
- Service/container: `claude-mcp` / `localgpt-claude-mcp-1`.
- HTTP endpoint: `http://127.0.0.1:8877/mcp`.
- Health endpoint: `http://127.0.0.1:8877/healthz`.
- Default workspace: `/Users/devonly/Developer`, mounted at the **same absolute path** inside the container.
- Gateway environment: the host shell's `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, and optional Cloudflare Access/custom headers are passed through Compose `environment` at startup. Secret values are not written into Compose. The previous `runtime.env` file is no longer used.

```sh
cd /Users/devonly/Developer/local-gpt
docker compose build claude-mcp
docker compose up -d --no-deps --wait claude-mcp
```

MCP authentication is off by default. The published port is loopback-only; the existing Tailscale proxy does not expose this service. Host and browser Origin checks reject foreign-origin calls. HTTP initialization returns a session ID; subsequent calls/notifications use that same MCP session so cancellation reaches the original request. At most 64 sessions are retained, with one-hour idle expiry and least-recently-used idle eviction at capacity; in-flight calls are never evicted. Reinitialize if an idle session expires. JSON-RPC batches are rejected before execution. Set `CLAUDE_MCP_TOKEN` for optional bearer authentication. Keep this service local unless you explicitly add authentication and a suitable frontend.

The image runs as UID 1000, includes Claude Code 2.1.289, and uses tini for process reaping. Changing gateway credentials requires recreating this service. The other LocalGPT services need no restart.

## STDIO

Run in the existing container with its mounted files and inherited environment:

```sh
cd /Users/devonly/Developer/local-gpt
docker compose exec -T claude-mcp node src/main.mjs --transport stdio
```

For an MCP client configuration:

```json
{
  "mcpServers": {
    "claude-mcp": {
      "command": "docker",
      "args": ["compose", "-f", "/Users/devonly/Developer/local-gpt/compose.yaml", "-f", "/Users/devonly/Developer/local-gpt/compose.override.yaml", "exec", "-T", "claude-mcp", "node", "src/main.mjs", "--transport", "stdio"]
    }
  }
}
```

Or run directly with Node and a locally installed Claude CLI:

```sh
npm ci
node src/main.mjs --transport stdio
# HTTP directly on loopback:
node src/main.mjs --transport http
```

STDIO stdout contains MCP protocol messages only; startup/fatal messages use stderr. Claude stdout/stderr are captured in memory with a byte limit; credentials are redacted from tool errors/results and are not logged by this wrapper.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | Claude CLI default | Existing Anthropic-compatible gateway |
| `ANTHROPIC_AUTH_TOKEN` | unset | Bearer authentication, inherited by Claude |
| `ANTHROPIC_API_KEY` | unset | x-api-key authentication alternative |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | unset | Existing Cloudflare Access identity, added to gateway headers |
| `ANTHROPIC_CUSTOM_HEADERS` | unset | Optional newline-separated custom gateway headers |
| `CLAUDE_MCP_MODELS` | empty | Comma-separated IDs or Claude aliases for explicit fallback |
| `CLAUDE_MCP_WORKSPACE` | `/Users/devonly/Developer` | Default cwd and relative-path base |
| `CLAUDE_MCP_MOUNTED_ROOTS` | workspace | Comma-separated roots available for cwd; mount each separately if needed |
| `CLAUDE_MCP_COMMAND` | `claude` | Claude executable |
| `CLAUDE_MCP_TIMEOUT_MS` | `300000` | Default ask timeout; request override up to 30 minutes |
| `CLAUDE_MCP_MAX_OUTPUT_BYTES` | `1048576` | Combined CLI stdout/stderr and per-page model response bound |
| `CLAUDE_MCP_MODELS_TIMEOUT_MS` | `10000` | Entire model-discovery deadline |
| `CLAUDE_MCP_PERMISSION_MODE` | `acceptEdits` | Explicit Claude permission mode |
| `CLAUDE_MCP_ALLOWED_TOOLS` | `Read,Grep,Glob` | Tools allowed without permission prompts |
| `CLAUDE_MCP_TOKEN` | unset | Optional MCP bearer authentication |
| `HOST`, `PORT` | `127.0.0.1`, `8877` | Direct HTTP bind; Docker internally uses `0.0.0.0` with loopback publish |

The MCP initialization instructions and the `cwd` parameter description explicitly tell callers to omit `cwd` for ordinary questions, planning or reviews without file access. Do not automatically copy the Codex/chat working directory: it may belong to another host or to an unmounted worktree. `models.execution_context` reports the actual `default_cwd` and `mounted_roots` on the MCP host.

For example, a plain question needs no directory:

```json
{"prompt": "What is 1 + 1?", "model": "claude-sonnet-5-5"}
```

`cwd` omitted uses Developer. Relative `cwd` resolves from Developer. An absolute `cwd` is used as the requested filesystem location, then canonicalized and checked against the configured mounted roots; missing/non-directory/unmounted paths fail before spawning Claude. `invalid_cwd` includes a precise reason, requested/resolved paths, the default directory, mounted roots and `execution_started: false`. An explicitly invalid directory is never silently redirected to another workspace. Example: `ask(prompt="Review the package", cwd="claude-mcp", model="claude-sonnet-5-5")`.

The default permission mode allows file edits; read tools are explicitly allowed. Other tools that require approval are denied, because no interactive user can answer a CLI permission prompt. `permission_denials` returns a tool error even if Claude produced text. Configure extra allowed tools/mode when your workflow requires them.

The prompt is written to stdin, never a shell command. Model selection uses one argv value. Each ask creates one independent print process with session persistence disabled and retry count zero. Cancellation, HTTP disconnect, service shutdown or timeout terminates its process group; same-group background children are also cleaned up after normal exit. Commands deliberately creating another process group are not a background-service API; container shutdown terminates remaining container processes.

Model discovery uses `/v1/models` (or `/models` for a base ending in `/v1`), follows bounded pagination, and never redirects credentials. If discovery fails, only `CLAUDE_MCP_MODELS` is returned with `source: configured` and a reason. It does not claim those IDs were observed from the gateway. `ask.model` may use any model accepted by your Claude gateway and is not restricted to this list.

## Verification

```sh
npm test
npm audit --omit=dev
node scripts/verify.mjs http
node scripts/verify.mjs stdio
```

The unit/transport tests use a fake CLI for errors, permissions, timeout/cancellation, process cleanup, cwd validation, credential handling, models pagination/fallback/redirects, HTTP/STDIO and browser Origin. The verification script calls the **real deployed Claude** and checks an absolute host-file Read. `CLAUDE_MCP_VERIFY_MODEL` can specify an exact gateway ID; no failed request is automatically retried.

LocalGPT GPT 6 Pro planning review was attempted but returned `browser_timeout`; worker-side LocalMCP access remains unverified. Implementation and runtime verification do not depend on that browser session. This repository does not add LocalGPT worker mediation or register the service automatically in Codex settings.

Deployment and real call evidence are recorded in [docs/verification.md](docs/verification.md).
