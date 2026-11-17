export class RunnerError extends Error {
	constructor(code, message, details) {
		super(message);
		this.code = code;
		if (details) this.details = details;
	}
}
export function secretValues(env = process.env) {
 const values=['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','CF_ACCESS_CLIENT_SECRET','CF_ACCESS_CLIENT_ID'].map(k=>env[k]).filter(Boolean);
 for(const line of (env.ANTHROPIC_CUSTOM_HEADERS??'').split('\n')){
  const i=line.indexOf(':');if(i<1)continue;const v=line.slice(i+1).trim();if(v){values.push(v);const bearer=/^Bearer\s+(.+)$/i.exec(v);if(bearer)values.push(bearer[1]);}
 }
 return [...new Set(values)].sort((a,b)=>b.length-a.length);
}
export function redact(text, env = process.env) {
 let value=String(text);for(const secret of secretValues(env))value=value.split(secret).join('[redacted]');return value;
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
