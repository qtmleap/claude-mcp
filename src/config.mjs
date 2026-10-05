import { resolve } from 'node:path';
function integer(env,key,fallback,min,max) {
  const n=Number(env[key]??fallback);
  if(!Number.isInteger(n)||n<min||n>max) throw new Error(`Invalid ${key}`);
  return n;
}
export function loadConfig(env=process.env) {
  const root=resolve(env.CLAUDE_MCP_WORKSPACE||process.cwd());
  const permissionMode=env.CLAUDE_MCP_PERMISSION_MODE||'acceptEdits';
  if(!['manual','default','acceptEdits','dontAsk','plan','auto','bypassPermissions'].includes(permissionMode)) throw new Error('Invalid CLAUDE_MCP_PERMISSION_MODE');
  return {env:{...env},root,command:env.CLAUDE_MCP_COMMAND||'claude',
    mountedRoots:(env.CLAUDE_MCP_MOUNTED_ROOTS||root).split(',').map(p=>resolve(p.trim())),
    timeoutMs:integer(env,'CLAUDE_MCP_TIMEOUT_MS',300000,50,1800000),
    maxOutput:integer(env,'CLAUDE_MCP_MAX_OUTPUT_BYTES',1048576,1024,16777216),
    modelsTimeoutMs:integer(env,'CLAUDE_MCP_MODELS_TIMEOUT_MS',10000,50,60000),
    port:integer(env,'PORT',8877,0,65535),host:env.HOST||'127.0.0.1',
    models:(env.CLAUDE_MCP_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean),
    permissionMode,allowedTools:(env.CLAUDE_MCP_ALLOWED_TOOLS||'Read,Grep,Glob').split(',').map(s=>s.trim()).filter(Boolean),
    token:env.CLAUDE_MCP_TOKEN||null};
}
