import { RunnerError, redact } from "./errors.mjs";
import { terminalDiagnostic, validTerminalResult } from "./terminal-result.mjs";
import { normalizeUsage } from "./usage.mjs";

// Turns a parsed CLI result into the success payload; throws the RunnerError to reject with otherwise.
export function evaluateResult({
	result,
	failure,
	exitCode,
	err,
	env,
	session,
	config,
	args,
	cwd,
}) {
	const usage = normalizeUsage(
		result,
		session
			? result?.session_id === session.uuid
				? session.previousCost
				: undefined
			: 0,
	);
	const accounting =
		result?.type === "result" &&
		(Object.keys(usage.invocation).length ||
			Object.keys(usage.conversationModelUsage).length ||
			usage.conversationCostUSD !== null)
			? { usage }
			: undefined;
	if (failure) {
		const denied =
			validTerminalResult(result, session) && result.permission_denials?.length;
		if (validTerminalResult(result, session) && (accounting || denied))
			failure.details = {
				...failure.details,
				...accounting,
				...(denied ? { permission_denied: true } : {}),
			};
		throw failure;
	}
	if (exitCode !== 0) {
		const diagnostic = terminalDiagnostic(result, env);
		const detail = [err, diagnostic?.text].filter(Boolean).join("; ");
		const details =
			accounting || diagnostic
				? {
						...accounting,
						...(diagnostic ? { cli_diagnostic: diagnostic } : {}),
					}
				: undefined;
		throw new RunnerError(
			"claude_exit",
			`Claude exited with code ${exitCode}${detail ? ": " + detail : ""}`,
			details,
		);
	}
	if (result?.result != null && typeof result.result !== "string")
		throw new RunnerError(
			"invalid_json",
			"Claude result field has an unexpected JSON shape",
		);
	if (
		result?.errors != null &&
		(!Array.isArray(result.errors) ||
			!result.errors.every((x) => typeof x === "string"))
	)
		throw new RunnerError(
			"invalid_json",
			"Claude errors field has an unexpected JSON shape",
		);
	if (
		result?.permission_denials != null &&
		!Array.isArray(result.permission_denials)
	)
		throw new RunnerError(
			"invalid_json",
			"Claude permission_denials field has an unexpected JSON shape",
		);
	if (
		!result ||
		result.type !== "result" ||
		result.is_error === true ||
		result.subtype !== "success"
	) {
		const detail = redact(
			(result?.errors ?? []).join("; ") ||
				result?.result ||
				"Claude reported an unsuccessful result",
			env,
		).slice(0, 2000);
		throw new RunnerError("claude_error", detail, accounting);
	}
	if (result.permission_denials?.length) {
		// Only tool names are surfaced: never tool inputs or any partial answer.
		const toolNames = [
			...new Set(
				result.permission_denials
					.map((d) => d?.tool_name)
					.filter((n) => typeof n === "string" && n),
			),
		].map((n) => redact(n, env));
		throw new RunnerError(
			"permission_denied",
			"Claude reported tool permission denials; configure allowed tools or permission mode explicitly",
			{
				tool_names: toolNames,
				permission_mode: config.permissionMode,
				allowed_tools: (config.allowedTools ?? []).map((t) => redact(t, env)),
				cwd,
				execution_started: true,
				...accounting,
			},
		);
	}
	if (typeof result.result !== "string")
		throw new RunnerError(
			"invalid_json",
			"Claude result is missing its answer",
		);
	if (session && result.session_id !== session.uuid)
		throw new RunnerError(
			"session_mismatch",
			"Claude returned a different or missing session id; the conversation is no longer trusted",
			accounting,
		);
	return {
		answer: redact(result.result, env).slice(0, config.maxOutput),
		...(result.result.length > config.maxOutput ? { truncated: true } : {}),
		model: args.model ?? null,
		cwd,
		...(typeof result.duration_ms === "number"
			? { duration_ms: result.duration_ms }
			: {}),
		...(typeof result.num_turns === "number"
			? { num_turns: result.num_turns }
			: {}),
		...(session ? { cli_session_id: session.uuid } : {}),
		usage,
	};
}
