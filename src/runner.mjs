import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { RunnerError, redact, childEnvironment } from "./errors.mjs";
import { resolveWorkspace, resolveCwd } from "./workspace.mjs";
import { REVIEW_POLICY, REVIEW_TOOLS, validBudget } from "./review-policy.mjs";
import { validTerminalResult } from "./terminal-result.mjs";
import { evaluateResult } from "./result-handling.mjs";
import { StreamDiagnostics } from "./stream-diagnostics.mjs";

export {
	RunnerError,
	redact,
	childEnvironment,
	resolveCwd,
	REVIEW_POLICY,
	validBudget,
};
const VALID_SHUTDOWN_GRACE_MS = 10000;
const INVALID_SHUTDOWN_GRACE_MS = 5000;
function killGroup(child, signal) {
	try {
		if (process.platform === "win32") child.kill(signal);
		else if (child.pid) process.kill(-child.pid, signal);
	} catch (error) {
		if (error.code !== "ESRCH") child.kill(signal);
	}
}
export async function runAsk(args, config, signal, options = {}) {
	if (signal?.aborted)
		throw new RunnerError("cancelled", "Request cancelled before execution");
	const mountedRoots = config.mountedRoots ?? [config.root];
	const { cwd, roots } = await resolveWorkspace(
		args.cwd,
		config.root,
		mountedRoots,
	);
	const addDirs = roots.filter((p) => p !== cwd);
	if (signal?.aborted)
		throw new RunnerError("cancelled", "Request cancelled before execution");
	if (!validBudget(args.max_budget_usd))
		throw new RunnerError(
			"invalid_request",
			"max_budget_usd must be a finite number in (0, 100]",
		);
	const session = args.session;
	const argv = [
		"-p",
		"--output-format",
		options.stream ? "stream-json" : "json",
		...(session
			? [
					`--${session.mode === "new" ? "session-id" : "resume"}=${session.uuid}`,
				]
			: ["--no-session-persistence"]),
		"--no-chrome",
		"--permission-prompts",
		"none",
		"--permission-mode",
		config.permissionMode,
	];
	if (args.review) argv.push(...REVIEW_POLICY);
	if (args.max_budget_usd !== undefined)
		argv.push(`--max-budget-usd=${args.max_budget_usd}`);
	if (options.stream) argv.push("--verbose", "--include-partial-messages");
	const diagnostics = config.streamDiagnostics ? new StreamDiagnostics() : null;
	if (diagnostics) argv.push("--debug-to-stderr");
	for (const dir of addDirs) argv.push(`--add-dir=${dir}`);
	if (args.model) argv.push(`--model=${args.model}`);
	const allowed = args.review ? [REVIEW_TOOLS] : config.allowedTools;
	if (allowed?.length) argv.push("--allowedTools", allowed.join(","));
	const env = childEnvironment(config.env);
	if (session) env.CLAUDE_CONFIG_DIR = session.configDir;
	return new Promise((resolveResult, reject) => {
		let failure,
			timer,
			killTimer,
			resultTimer,
			exitTimer,
			bytes = 0,
			exited = false;
		const stdout = [],
			stderr = [];
		const decoder = new StringDecoder("utf8");
		let pendingLine = "",
			finalResult,
			assistantText = "",
			stderrBytes = 0,
			stderrTruncated = false;
		let jsonDepth = 0,
			jsonString = false,
			jsonEscape = false,
			jsonStarted = false,
			jsonFinished = false;
		const secrets = [
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_API_KEY",
			"CF_ACCESS_CLIENT_SECRET",
			"CF_ACCESS_CLIENT_ID",
		]
			.map((k) => env[k])
			.filter(Boolean);
		const longestSecret = Math.max(0, ...secrets.map((s) => s.length));
		const rawLimit = config.maxOutput + longestSecret;
		// Capture enough UTF-8 bytes for 2000 characters plus a complete secret crossing
		// the visible boundary; redact the complete capture before shortening the message.
		const stderrCaptureBytes = (2000 + longestSecret) * 4;
		const retainRaw = (text) => {
			let cut = Math.max(0, text.length - rawLimit);
			// Never cut inside a full configured secret: its remaining suffix must not leak.
			for (const secret of secrets) {
				const near = Math.max(0, cut - secret.length + 1);
				let at = text.indexOf(secret, near);
				while (at >= 0 && at < cut) {
					if (at + secret.length > cut) cut = at + secret.length;
					at = text.indexOf(secret, at + 1);
				}
			}
			return text.slice(cut);
		};
		const hideTrailingSecretPrefix = (text) => {
			let hold = 0;
			for (const secret of secrets)
				for (let n = 1; n < secret.length; n++)
					if (text.endsWith(secret.slice(0, n))) hold = Math.max(hold, n);
			if (hold) text = text.slice(0, -hold);
			return text;
		};
		const safeProgress = () => {
			// Hold possible trailing secret prefixes until future chunks disambiguate them.
			const text = hideTrailingSecretPrefix(assistantText);
			options.onProgress?.({
				partial_answer: redact(text, env).slice(-config.maxOutput),
			});
		};
		const line = (text) => {
			let event;
			try {
				event = JSON.parse(text);
			} catch {
				return;
			}
			diagnostics?.event(event);
			if (event?.type === "result") {
				if (finalResult) return;
				finalResult = event;
				const valid = validTerminalResult(event, session);
				if (!exited && !resultTimer)
					resultTimer = setTimeout(
						() =>
							fail(
								valid
									? "cli_shutdown_timeout"
									: session && event.session_id !== session.uuid
										? "session_mismatch"
										: "invalid_json",
								"Claude emitted a terminal result but did not exit; execution stopped and was not retried.",
							),
						valid ? VALID_SHUTDOWN_GRACE_MS : INVALID_SHUTDOWN_GRACE_MS,
					);
				return;
			}
			const delta = event?.type === "stream_event" ? event.event?.delta : null;
			if (delta?.type === "text_delta" && typeof delta.text === "string") {
				assistantText = retainRaw(assistantText + delta.text);
				safeProgress();
			} else if (
				event?.type === "assistant" &&
				Array.isArray(event.message?.content)
			) {
				const texts = event.message.content
					.filter((b) => b?.type === "text" && typeof b.text === "string")
					.map((b) => b.text)
					.join("");
				if (texts) {
					assistantText = retainRaw(texts);
					safeProgress();
				}
			}
		};
		const child = spawn(config.command, argv, {
			cwd,
			env,
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		const fail = (code, message) => {
			if (failure) return;
			failure = new RunnerError(code, message);
			if (exited) return;
			killGroup(child, "SIGTERM");
			killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 300);
			killTimer.unref();
		};
		const abort = () =>
			fail(
				"cancelled",
				"Request cancelled; execution may have started. Not retried.",
			);
		signal?.addEventListener("abort", abort, { once: true });
		const deadline = args.timeout_ms ?? config.timeoutMs;
		if (deadline > 0)
			timer = setTimeout(
				() =>
					fail(
						"timeout",
						"Claude timed out; execution may have started. Not retried.",
					),
				deadline,
			);
		for (const [stream, buffer] of [
			[child.stdout, stdout],
			[child.stderr, stderr],
		]) {
			stream.on("data", (chunk) => {
				if (options.stream) {
					if (stream === child.stderr) {
						if (diagnostics) {
							diagnostics.stderr(chunk);
							return;
						}
						const remaining = Math.max(0, stderrCaptureBytes - stderrBytes);
						if (chunk.length > remaining) stderrTruncated = true;
						if (remaining) {
							const kept = chunk.subarray(0, remaining);
							buffer.push(kept);
							stderrBytes += kept.length;
						}
						return;
					}
					pendingLine += decoder.write(chunk);
					let index;
					while ((index = pendingLine.indexOf("\n")) !== -1) {
						const next = pendingLine.slice(0, index);
						pendingLine = pendingLine.slice(index + 1);
						line(next);
					}
					if (
						Buffer.byteLength(pendingLine) >
						Math.max(config.maxOutput * 4, 1048576)
					)
						fail(
							"output_limit",
							"Claude stream frame exceeded configured limit; not retried",
						);
				} else {
					if (stream === child.stderr && diagnostics) {
						diagnostics.stderr(chunk);
						return;
					}
					bytes += chunk.length;
					if (bytes > config.maxOutput)
						fail(
							"output_limit",
							"Claude output exceeded configured limit; not retried",
						);
					else {
						buffer.push(chunk);
						if (stream === child.stdout && !jsonFinished)
							for (const byte of chunk) {
								if (jsonString) {
									if (jsonEscape) jsonEscape = false;
									else if (byte === 92) jsonEscape = true;
									else if (byte === 34) jsonString = false;
								} else if (byte === 34) jsonString = true;
								else if (byte === 123 || byte === 91) {
									jsonStarted = true;
									jsonDepth++;
								} else if (
									jsonStarted &&
									(byte === 125 || byte === 93) &&
									--jsonDepth === 0
								) {
									jsonFinished = true;
									line(Buffer.concat(stdout).toString("utf8"));
									break;
								}
							}
					}
				}
			});
		}
		child.stdin.on("error", () => {}); // Early exit can close stdin before the prompt flushes.
		child.on("error", () =>
			fail("spawn_failed", "Cannot start Claude Code executable"),
		);
		child.on("exit", () => {
			exited = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			clearTimeout(resultTimer);
			killGroup(child, "SIGKILL");
			exitTimer = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
			}, 500);
		});
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			clearTimeout(resultTimer);
			clearTimeout(exitTimer);
			signal?.removeEventListener("abort", abort);
			diagnostics?.end();
			const out = Buffer.concat(stdout).toString("utf8").trim();
			let rawError = Buffer.concat(stderr).toString("utf8");
			if (stderrTruncated)
				rawError = hideTrailingSecretPrefix(rawError.replace(/\uFFFD+$/u, ""));
			const err = redact(rawError, env).slice(0, 2000);
			let result;
			try {
				if (options.stream) {
					pendingLine += decoder.end();
					if (pendingLine.trim()) line(pendingLine);
					result = finalResult;
					if (!result) throw new Error("missing result");
				} else result = JSON.parse(out);
			} catch {
				if (failure) {
					reject(failure);
					return;
				}
				reject(
					exitCode !== 0
						? new RunnerError(
								"claude_exit",
								`Claude exited with code ${exitCode}${err ? ": " + err : ""}`,
							)
						: new RunnerError(
								"invalid_json",
								"Claude did not return a valid JSON result",
							),
				);
				return;
			}
			try {
				resolveResult(
					evaluateResult({
						result,
						failure,
						exitCode,
						err,
						env,
						session,
						config,
						args,
						cwd,
					}),
				);
			} catch (error) {
				reject(error);
			}
			});
		child.stdin.end(args.prompt);
	}).catch((error) => {
		if (diagnostics && error instanceof RunnerError)
			error.details = {
				...error.details,
				stream_diagnostic: diagnostics.snapshot(),
			};
		throw error;
	});
}
