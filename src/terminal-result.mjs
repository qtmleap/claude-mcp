import { redact } from "./errors.mjs";

export function terminalDiagnostic(result, env) {
	if (
		result?.type !== "result" ||
		(result.subtype != null && typeof result.subtype !== "string")
	)
		return;
	if (!(result.is_error === true || /^error(?:_|$)/.test(result.subtype ?? "")))
		return;
	if (result.result != null && typeof result.result !== "string") return;
	if (
		result.errors != null &&
		(!Array.isArray(result.errors) ||
			!result.errors.every((value) => typeof value === "string"))
	)
		return;
	if (
		result.permission_denials != null &&
		(!Array.isArray(result.permission_denials) ||
			result.permission_denials.length)
	)
		return;
	let text = redact(
		(result.errors ?? []).filter((value) => value.trim()).join("; ") ||
			result.result ||
			"",
		env,
	);
	for (const header of (env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n")) {
		const value = header.slice(header.indexOf(":") + 1).trim();
		if (header.includes(":") && value) {
			text = text.split(value).join("[redacted]");
			const bearer = /^Bearer\s+(.+)$/i.exec(value);
			if (bearer) text = text.split(bearer[1]).join("[redacted]");
		}
	}
	text = text
		.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
			try {
				return new URL(value).origin;
			} catch {
				return "[url]";
			}
		})
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
		.trim();
	if (!text) return;
	const status = /^API Error:\s*([45]\d{2})(?=\s|$)/.exec(text);
	return {
		source: "result",
		text: text.slice(0, 1000),
		...(status ? { http_status: Number(status[1]) } : {}),
		...(text.length > 1000 ? { truncated: true } : {}),
	};
}
export function validTerminalResult(event, session) {
	return (
		event?.type === "result" &&
		typeof event.subtype === "string" &&
		typeof event.is_error === "boolean" &&
		(event.result == null || typeof event.result === "string") &&
		(event.errors == null ||
			(Array.isArray(event.errors) &&
				event.errors.every((value) => typeof value === "string"))) &&
		(event.permission_denials == null ||
			Array.isArray(event.permission_denials)) &&
		(event.subtype !== "success" ||
			event.is_error ||
			typeof event.result === "string") &&
		(!session || event.session_id === session.uuid)
	);
}
