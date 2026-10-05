# claude-mcp

An MCP server that runs [Claude Code](https://code.claude.com/docs/en/overview) in non-interactive mode. Connect an MCP client over STDIO or Streamable HTTP to discover models and ask Claude to answer questions or work with a configured filesystem workspace.

## Tools

| Tool | Inputs | Output |
| --- | --- | --- |
| `models` | None | Model identifiers, discovery source and the server's workspace context |
| `ask` | `prompt`; optional `model`, `cwd`, `timeout_ms` | Claude's completed answer, resolved cwd and available execution metadata |

`ask` starts one `claude -p --output-format json` process and waits for its final result. Each call is independent; sessions are not resumed. CLI errors and permission denials are returned as MCP tool errors.

## Install and run

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

MCP authentication is optional: set `CLAUDE_MCP_TOKEN` to require a bearer token on `/mcp`. Host and browser Origin checks protect the local endpoint. External hosting requires its own access controls and frontend configuration.

Cancellation, disconnect, shutdown and timeout terminate the Claude process group; same-group descendants are also cleaned up after normal exit. A failed or unconfirmed response can follow a file operation, so do not automatically retry it. The server does not provide a background-service API.

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
| `CLAUDE_MCP_TIMEOUT_MS` | `300000` | Default ask timeout |
| `CLAUDE_MCP_MAX_OUTPUT_BYTES` | `1048576` | Combined CLI output and per-page model response limit |
| `CLAUDE_MCP_MODELS_TIMEOUT_MS` | `10000` | Model-discovery deadline |
| `CLAUDE_MCP_PERMISSION_MODE` | `acceptEdits` | CLI permission mode |
| `CLAUDE_MCP_ALLOWED_TOOLS` | `Read,Grep,Glob` | Tools allowed without prompting |
| `CLAUDE_MCP_TOKEN` | unset | Optional MCP authentication |
| `HOST`, `PORT` | `127.0.0.1`, `8877` | Native HTTP bind |
| `CLAUDE_MCP_HOST_WORKSPACE` | `.` | Compose-only host bind source |
| `CLAUDE_MCP_PORT` | `8877` | Compose-only published host port |

`ask.timeout_ms` can override the timeout up to 30 minutes. Model discovery queries `/v1/models` (or `/models` for a base ending in `/v1`), supports bounded pagination and rejects redirects. If unavailable, only the explicit `CLAUDE_MCP_MODELS` list is returned with `source: configured` and a reason. `ask.model` accepts any model identifier supported by your gateway.

HTTP initialization returns an MCP session ID used for later requests and cancellation notifications. Sessions are bounded to 64 with idle expiry/eviction; in-flight calls are never evicted. Reinitialize an expired idle session. JSON-RPC batches are rejected before execution.

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

## Container design

The multi-stage Dockerfile installs packages in a Debian builder and copies production dependencies into a Distroless Node.js runtime. Dependency manifests are read using BuildKit bind mounts, download caches stay in cache mounts, and independent runtime layers use `COPY --link`. The final image has no npm, apt or build cache.

Claude Code can invoke shell commands, so the Distroless-based runtime includes Bash, standard command-line utilities, Git, ripgrep and the OpenSSH client with their required libraries. A shell-free runtime would break those workflows. The container runs as UID/GID 1000 with a writable home and workspace, and tini handles child-process reaping. Project-specific runtimes and compilers must be supplied separately when needed.

BuildKit is required. The builder and runtime use Debian 13 to keep shared-library compatibility. `CLAUDE_CODE_VERSION` is a build argument for the pinned native CLI release. Do not pass runtime provider credentials as build arguments; they are supplied only when the container starts.
