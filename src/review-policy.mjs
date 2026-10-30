// Review profile: read-only, no MCP/hooks/plugins, cwd-confined. Enforced as flags on every launch, not by prompt.
export const REVIEW_TOOLS = "Read,Grep,Glob";
const REVIEW_INSTRUCTION =
	"You are a code reviewer. Read the applicable AGENTS.md and CLAUDE.md files inside the repository. Focus only on the diff, paths, line ranges or findings the caller specifies; use the supplied manifest. Do not rescan unrelated parts of the repository and do not repeat earlier reports. Re-inspect the current source of anything you comment on: never approve based on stale content.";
export const REVIEW_POLICY = Object.freeze([
	"--bare",
	"--restricted",
	`--tools=${REVIEW_TOOLS}`,
	"--disallowedTools=mcp__*",
	"--strict-mcp-config",
	'--mcp-config={"mcpServers":{}}',
	`--append-system-prompt=${REVIEW_INSTRUCTION}`,
]);
export const validBudget = (v) =>
	v === undefined ||
	(typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100);
