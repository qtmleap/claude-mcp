# Verification — 2026-10-05

## Host environment deployment update — 14:35 JST

The host Compose override now passes ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
ANTHROPIC_API_KEY, ANTHROPIC_CUSTOM_HEADERS, CF_ACCESS_CLIENT_ID,
CF_ACCESS_CLIENT_SECRET and CLAUDE_MCP_MODELS through `environment` interpolation.
The previous runtime.env is no longer read. Secret values remain outside Compose
source and this record. Container values were compared with host values without
printing them; all seven matched. URL, bearer token and Cloudflare credentials
were configured in the invoking shell.

`docker compose config --quiet` succeeded. Only claude-mcp was targeted by
`docker compose up -d --no-deps --force-recreate --wait claude-mcp`, and it became
healthy on 127.0.0.1:8877. The LocalGPT, LocalMCP and tailnet proxy container IDs
remained unchanged. A concurrently managed asc-mcp container changed separately;
this command did not target it or remove orphan containers.

Both verification scripts succeeded again using claude-sonnet-5-5:
- HTTP initialization/tools list/models API returned exactly models and ask.
- HTTP real ask returned CLAUDE_MCP_HTTP_OK.
- Read of /Users/devonly/Developer/claude-mcp/package.json returned claude-mcp.
- Nonexistent cwd was rejected before execution.
- STDIO initialization/tools list/models API succeeded; real ask returned CLAUDE_MCP_STDIO_OK.

The initial deployment record below describes the earlier env_file setup.

Host: studio.local (Mac Studio). Container: localgpt-claude-mcp-1, UID1000, Claude Code2.1.289, imageclaude-mcp-host:0.1.0. Endpoint http://127.0.0.1:8877/mcp; loopback publish only.

Compose: /Users/devonly/Developer/local-gpt/compose.yaml + compose.override.yaml. Only claude-mcp rebuilt/recreated; existing LocalGPT/LocalMCP/tailnet proxy remained healthy with unchanged uptime.

- npm test: 22 passed, 0 failed. Covers HTTP/STDIO initialization and tools, credential headers/model pagination/fallback/redirects, CLI JSON errors/permissions/malformed shapes, cwd, output limits, timeout, cancellation, HTTP socket disconnect, shutdown, process-group cleanup, SDK deadline cancellation, Origin/Host/auth, 66 reconnect cycles, rejection of batches before execution, and advertised cwd context with actionable pre-execution errors.
- npm audit --omit=dev: 0 vulnerabilities (Express4.22.3).
- Docker build and Compose health succeeded. node --check for src/scripts and git diff --check succeeded.
- Runtime env file permissions verified600, outside Developer and Git. No secret values recorded.
- Read-only code review clean after all reproduced findings were fixed with regression tests.

## Real MCP/Claude evidence

Verification script used exact model claude-sonnet-5-5 with no automatic retries. HTTP and STDIO both initialized and listed exactly models/ask. The real gateway models API worked from the deployed container; configured fallback was not used. The HTTP Read used the actual host file, mounted at the same absolute path.

```text
{"transport":"http","tools":["models","ask"],"models_source":"api","models":["claude-fable-5-1","claude-haiku-4-5","claude-opus-5-5","claude-sonnet-5-5","gpt-5.6-luna","gpt-5.6-sol","gpt-5.6-terra","gpt-6.1-sol","gpt-6-astra","gpt-6-luna","gpt-6-sol"]}
{"transport":"http","ask":"CLAUDE_MCP_HTTP_OK","cwd":"/Users/devonly/Developer"}
{"absolute_file":"/Users/devonly/Developer/claude-mcp/package.json","answer":"claude-mcp","cwd":"/Users/devonly/Developer/claude-mcp"}
PASS: invalid cwd rejected before execution
{"transport":"stdio","tools":["models","ask"],"models_source":"api","models":["claude-fable-5-1","claude-haiku-4-5","claude-opus-5-5","claude-sonnet-5-5","gpt-5.6-luna","gpt-5.6-sol","gpt-5.6-terra","gpt-6.1-sol","gpt-6-astra","gpt-6-luna","gpt-6-sol"]}
{"transport":"stdio","ask":"CLAUDE_MCP_STDIO_OK","cwd":"/Users/devonly/Developer"}
```

## Limitations / remaining work

LocalGPT GPT6Pro plan review job462172d5-490d-4866-88e5-cf0f245942a1 failed browser_timeout. Worker-side LocalMCP access unverified; no Computer Use or automatic resend. A direct review and tests were used instead. The new repository is not mounted in the existing LocalMCP service; this setup issue was reported and native Codex file operations were used for the new repository. No automatic Codex MCP registration, Git commit/push or image-registry publication was performed.

## cwd interface follow-up

Initialization and the cwd parameter now explicitly say to omit cwd for ordinary questions and never automatically copy the caller directory. models.execution_context reports /Users/devonly/Developer and its mounted roots. A foreign nonexistent cwd returns path_not_found, exact requested/resolved paths, and execution_started:false. The deployed image answered the plain question 1+1 with 2 when cwd was omitted. No silent workspace fallback was introduced. The read-only delta review and all22tests passed.
