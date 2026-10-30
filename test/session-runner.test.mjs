import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { runAsk } from "../src/runner.mjs";

const U = "11111111-2222-4333-8444-555555555555";
// Fake CLI echoing argv/config dir as the answer; session_id echoes the id it was given unless overridden.
async function fixture(t, o = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "claude-sr-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "claude");
	await writeFile(
		file,
		`#!/usr/bin/env node
let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
 const a=process.argv.slice(2);const f=a.find(x=>/^--(session-id|resume)=/.test(x));
 const base={type:'result',subtype:'success',is_error:false,session_id:${JSON.stringify(o.sid ?? null)} ?? (f?f.split('=')[1]:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),total_cost_usd:0.75,
  usage:{input_tokens:3,output_tokens:4,cache_read_input_tokens:0,cache_creation_input_tokens:0},modelUsage:{'m1':{inputTokens:9,costUSD:0.75}},
  result:JSON.stringify({args:a,cfg:process.env.CLAUDE_CONFIG_DIR||null})};
 ${o.noSession ? "delete base.session_id;" : ""}${o.noUsage ? "delete base.usage;delete base.modelUsage;delete base.total_cost_usd;" : ""}
 ${o.stream ? "console.log(JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text:'par'}}}));" : ""}
 console.log(JSON.stringify(base));});`,
		{ mode: 0o755 },
	);
	return {
		root,
		config: {
			root,
			command: file,
			timeoutMs: 2000,
			maxOutput: 10000,
			permissionMode: "acceptEdits",
			allowedTools: ["Bash", "Edit"],
			env: { ...process.env },
			mountedRoots: [root],
		},
	};
}
const info = (r) => JSON.parse(r.answer);
const session = (mode, extra = {}) => ({
	mode,
	uuid: U,
	configDir: "/tmp/none",
	previousCost: 0,
	...extra,
});

test("stateless default argv is unchanged (no bare/session flags, persistence off)", async (t) => {
	const { config } = await fixture(t);
	const { args, cfg } = info(await runAsk({ prompt: "x" }, config));
	assert.ok(args.includes("--no-session-persistence"));
	for (const bad of [
		"--bare",
		"--restricted",
		"--session-id",
		"--resume",
		"--max-turns",
		"--max-budget",
	])
		assert.ok(!args.some((a) => a.startsWith(bad)), bad);
	assert.equal(cfg, process.env.CLAUDE_CONFIG_DIR ?? null);
});

test("review profile is enforced on every launch: locked tools, no MCP, mounted roots added, instruction appended", async (t) => {
	const { root, config } = await fixture(t);
	await mkdir(join(root, "sub"));
	config.mountedRoots = [root, join(root, "sub")];
	const { args } = info(
		await runAsk({ prompt: "x", review: true, max_budget_usd: 1.5 }, config),
	);
	for (const flag of [
		"--bare",
		"--restricted",
		"--tools=Read,Grep,Glob",
		"--disallowedTools=mcp__*",
		"--strict-mcp-config",
		"--max-budget-usd=1.5",
		'--mcp-config={"mcpServers":{}}',
	])
		assert.ok(args.includes(flag), flag);
	assert.deepEqual(
		args.filter((a) => a.startsWith("--add-dir=")),
		[`--add-dir=${join(root, "sub")}`],
	);
	assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Grep,Glob");
	assert.ok(
		!args.some(
			(a) => /\b(Bash|Edit|Write)\b/.test(a) && !a.startsWith("--append"),
		),
	);
	assert.ok(
		args.some(
			(a) =>
				a.startsWith("--append-system-prompt=") &&
				/AGENTS/.test(a) &&
				/CLAUDE/.test(a),
		),
	);
	assert.ok(args.includes("--no-session-persistence")); // stateless review stays non-persistent
});

test("session args: --session-id for new, --resume for continuation, private config dir, persistence enabled", async (t) => {
	const { config } = await fixture(t);
	const n = info(
		await runAsk(
			{
				prompt: "x",
				review: true,
				session: session("new", { configDir: "/tmp/cc" }),
			},
			config,
		),
	);
	assert.ok(n.args.includes(`--session-id=${U}`));
	assert.ok(!n.args.includes("--no-session-persistence"));
	assert.equal(n.cfg, "/tmp/cc");
	const r = info(
		await runAsk(
			{
				prompt: "x",
				review: true,
				session: session("resume", { previousCost: 0.25 }),
			},
			config,
		),
	);
	assert.ok(r.args.includes(`--resume=${U}`));
	assert.ok(!r.args.includes(`--session-id=${U}`));
});

test("usage: per-invocation vs cumulative, delta from previousCost, session id surfaced; works streaming", async (t) => {
	for (const stream of [false, true]) {
		const { config } = await fixture(t, { stream });
		const res = await runAsk(
			{ prompt: "x", session: session("resume", { previousCost: 0.25 }) },
			config,
			undefined,
			stream ? { stream: true } : {},
		);
		assert.equal(res.usage.invocation.inputTokens, 3);
		assert.equal(res.usage.conversationCostUSD, 0.75);
		assert.equal(res.usage.invocationCostDeltaUSD, 0.5);
		assert.equal(res.usage.conversationModelUsage.m1.inputTokens, 9);
		assert.equal(res.cli_session_id, U);
	}
	const { config } = await fixture(t);
	const stateless = await runAsk({ prompt: "x" }, config);
	assert.equal(stateless.usage.invocationCostDeltaUSD, 0.75);
	assert.equal("cli_session_id" in stateless, false);
});

test("cost decrease on resume gives unknown delta; missing usage is never guessed", async (t) => {
	const { config } = await fixture(t);
	assert.equal(
		(
			await runAsk(
				{ prompt: "x", session: session("resume", { previousCost: 5 }) },
				config,
			)
		).usage.invocationCostDeltaUSD,
		null,
	);
	assert.equal(
		(
			await runAsk(
				{ prompt: "x", session: session("resume", { previousCost: null }) },
				config,
			)
		).usage.invocationCostDeltaUSD,
		null,
	);
	const m = await fixture(t, { noUsage: true });
	const none = await runAsk({ prompt: "x" }, m.config);
	assert.deepEqual(none.usage.invocation, {});
	assert.equal(none.usage.conversationCostUSD, null);
	assert.equal(none.usage.invocationCostDeltaUSD, null);
});

test("CLI session uuid mismatch or absence on a chain fails the run", async (t) => {
	for (const o of [
		{ sid: "ffffffff-2222-4333-8444-555555555555" },
		{ noSession: true },
	]) {
		const { config } = await fixture(t, o);
		await assert.rejects(
			runAsk({ prompt: "x", session: session("new") }, config),
			(e) => e.code === "session_mismatch",
		);
	}
});

test("invalid budget is rejected before spawn", async (t) => {
	const { config } = await fixture(t);
	for (const b of [0, -1, 101, NaN, "3"])
		await assert.rejects(
			runAsk({ prompt: "x", max_budget_usd: b }, config),
			(e) => e.code === "invalid_request",
		);
});

test("config derives a session dir beside the job dir, overridable", () => {
	assert.equal(
		loadConfig({ CLAUDE_MCP_JOB_DIR: "/var/lib/claude-mcp/jobs" }).sessionDir,
		"/var/lib/claude-mcp/sessions",
	);
	assert.equal(
		loadConfig({
			CLAUDE_MCP_JOB_DIR: "/a/jobs",
			CLAUDE_MCP_SESSION_DIR: "/b/s",
		}).sessionDir,
		"/b/s",
	);
});
