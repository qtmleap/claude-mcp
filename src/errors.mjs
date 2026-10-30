export class RunnerError extends Error {
	constructor(code, message, details) {
		super(message);
		this.code = code;
		if (details) this.details = details;
	}
}
export function redact(text, env = process.env) {
	let value = String(text);
	for (const key of [
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"CF_ACCESS_CLIENT_SECRET",
		"CF_ACCESS_CLIENT_ID",
	]) {
		if (env[key]) value = value.split(env[key]).join("[redacted]");
	}
	return value;
}
export function childEnvironment(env) {
	const result = {
		...env,
		CLAUDE_CODE_MAX_RETRIES: "0",
		CLAUDE_CODE_RETRY_WATCHDOG: "0",
		CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	};
	// CLI supports gateway custom headers; these also let models use the same Access identity.
	const headers = env.ANTHROPIC_CUSTOM_HEADERS
		? [env.ANTHROPIC_CUSTOM_HEADERS]
		: [];
	for (const [key, name] of [
		["CF_ACCESS_CLIENT_ID", "CF-Access-Client-Id"],
		["CF_ACCESS_CLIENT_SECRET", "CF-Access-Client-Secret"],
	]) {
		if (
			env[key] &&
			!headers
				.join("\n")
				.toLowerCase()
				.includes(name.toLowerCase() + ":")
		)
			headers.push(`${name}: ${env[key]}`);
	}
	if (headers.length) result.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n");
	// A wrapper launched inside a Claude session must create an independent print process.
	delete result.CLAUDECODE;
	return result;
}
