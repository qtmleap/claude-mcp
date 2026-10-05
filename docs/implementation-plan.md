# claude-mcp implementation

Implement a thin Claude Code process wrapper with only `models` and `ask` MCP tools. Support STDIO and stateful Streamable HTTP `/mcp`, HTTP container publish 127.0.0.1:8877. Default cwd `/Users/devonly/Developer`; relative cwd resolves there and existing absolute paths retain their meaning. Docker mounts Developer at the same absolute path and runs non-root.

- Test process argument/stdin behavior, inherited auth, JSON errors, permission denials, output limits, abort/timeouts and process-group cleanup before implementing.
- Query gateway `/v1/models` using supplied bearer/x-api-key and existing Cloudflare headers. Never redirect credentials. On unavailable discovery use configured IDs/aliases only and label that source.
- Spawn `claude -p --output-format json` directly, never a shell. Prompt via stdin; no automatic retries. Default acceptEdits with permission prompts disabled; configurable permission mode/allowed tools. Set CLI retry count to zero. Bounded output and timeout; kill process groups on cancellation, disconnect and shutdown. STDIO stdout belongs exclusively to MCP.
- Test HTTP initialization/list/models/ask and STDIO through the real MCP SDK. Add Docker image containing pinned Claude Code and isolated unit test CLI.
- Add only claude-mcp to existing LocalGPT Compose. Existing gateway secrets go in a mode-600 env file outside Developer/Git. Verify real Claude query, absolute path read and STDIO within deployed image. Do not commit/push without user request.

LocalGPT status/capabilities/models checked. GPT 6 Pro session b170cffc-c17f-4509-b4f4-6f5b7d26c0a2 review job 462172d5-490d-4866-88e5-cf0f245942a1 failed browser_timeout; no retry or CUA. Worker-side LocalMCP access unverified; no file delegation attempted. Gateway model listing returns HTTP 403; direct Claude print probe succeeded with CLAUDE_MCP_PROBE.

Review fixes: MCP sessions isolate request IDs and deliver SDK cancellation notifications to the original request; bounded 64-session registry and 1h idle expiry, no active expiry. CLI malformed errors/permission_denials shapes reject without uncaught exceptions. Red/green regression tests added. Existing gateway works from deployed container for both models API and Claude ask.

Completed: models/ask, HTTP/STDIO, mounted cwd, gateway auth, Docker/Compose deployment,22tests,zeroauditfindings,realgatewaymodels and Claude responses plus absolutehost-fileRead. Evidence: verification.md.

User requested English README and a Conventional Commits/CommitLint commit published to qtmleap/claude-mcp. Initial commit subject: feat: add Claude Code MCP server. Commit message validated against @commitlint/config-conventional.
