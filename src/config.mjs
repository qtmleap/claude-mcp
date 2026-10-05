import { homedir } from 'node:os';
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
    timeoutMs:undefined,
    waitMs:Math.min(integer(env,'CLAUDE_MCP_WAIT_MS',env.CLAUDE_MCP_TIMEOUT_MS??10000,0,1800000),30000),
    stateDir:resolve(env.CLAUDE_MCP_JOB_DIR||resolve(homedir(),'.local/state/claude-mcp/jobs')),
    maxJobs:integer(env,'CLAUDE_MCP_MAX_JOBS',128,1,10000),
    maxConcurrentJobs:integer(env,'CLAUDE_MCP_MAX_CONCURRENT_JOBS',4,1,64),
    jobRetentionMs:integer(env,'CLAUDE_MCP_JOB_RETENTION_MS',604800000,1000,31536000000),
    maxOutput:integer(env,'CLAUDE_MCP_MAX_OUTPUT_BYTES',1048576,1024,16777216),
    modelsTimeoutMs:integer(env,'CLAUDE_MCP_MODELS_TIMEOUT_MS',10000,50,60000),
    port:integer(env,'PORT',8877,0,65535),host:env.HOST||'127.0.0.1',
    models:(env.CLAUDE_MCP_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean),
    permissionMode,allowedTools:(env.CLAUDE_MCP_ALLOWED_TOOLS||'Read,Grep,Glob').split(',').map(s=>s.trim()).filter(Boolean),
    token:env.CLAUDE_MCP_TOKEN||null};
}
