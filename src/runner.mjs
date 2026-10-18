import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { stat, realpath } from 'node:fs/promises';
import { resolve, isAbsolute, relative } from 'node:path';
import { normalizeUsage } from './usage.mjs';
import { StreamDiagnostics } from './stream-diagnostics.mjs';

export class RunnerError extends Error {
  constructor(code, message, details) { super(message); this.code = code; if(details)this.details = details; }
}
export function redact(text, env = process.env) {
  let value = String(text);
  for (const key of ['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','CF_ACCESS_CLIENT_SECRET','CF_ACCESS_CLIENT_ID']) {
    if (env[key]) value = value.split(env[key]).join('[redacted]');
  }
  return value;
}
export function childEnvironment(env) {
  const result = { ...env, CLAUDE_CODE_MAX_RETRIES:'0', CLAUDE_CODE_RETRY_WATCHDOG:'0', CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:'1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1' };
  // CLI supports gateway custom headers; these also let models use the same Access identity.
  const headers = env.ANTHROPIC_CUSTOM_HEADERS ? [env.ANTHROPIC_CUSTOM_HEADERS] : [];
  for (const [key, name] of [['CF_ACCESS_CLIENT_ID','CF-Access-Client-Id'],['CF_ACCESS_CLIENT_SECRET','CF-Access-Client-Secret']]) {
    if (env[key] && !headers.join('\n').toLowerCase().includes(name.toLowerCase()+':')) headers.push(`${name}: ${env[key]}`);
  }
  if (headers.length) result.ANTHROPIC_CUSTOM_HEADERS = headers.join('\n');
  // A wrapper launched inside a Claude session must create an independent print process.
  delete result.CLAUDECODE;
  return result;
}
async function resolveWorkspace(cwd, root, mountedRoots = [root]) {
  const path = cwd ? (isAbsolute(cwd) ? cwd : resolve(root, cwd)) : root;
  const invalid = reason => new RunnerError('invalid_cwd',
    `The requested cwd is not available on the MCP host (${reason}). Omit cwd for questions that do not access files; file tasks must select an existing mounted directory.`,
    {reason,requested_cwd:cwd??null,resolved_path:path,default_cwd:root,mounted_roots:mountedRoots,execution_started:false});
  let info,canonical,roots;
  try { info=await stat(path); }
  catch(error) { throw invalid(error.code==='ENOENT'?'path_not_found':'path_not_accessible'); }
  if(!info.isDirectory())throw invalid('not_a_directory');
  try { canonical=await realpath(path); } catch { throw invalid('path_not_accessible'); }
  try { roots=await Promise.all(mountedRoots.map(async p=>{
    const canonicalRoot=await realpath(p);
    if(!(await stat(canonicalRoot)).isDirectory())throw new Error("mounted root is not a directory");
    return canonicalRoot;
  })); }
  catch { throw invalid('mounted_root_unavailable'); }
  if(!roots.some(r=>{const rel=relative(r,canonical);return rel===''||(rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel));}))throw invalid('outside_mounted_roots');
  return {cwd:canonical,roots:[...new Set(roots)]};
}
export async function resolveCwd(cwd, root, mountedRoots = [root]) {
  return (await resolveWorkspace(cwd,root,mountedRoots)).cwd;
}
// Review profile: read-only, no MCP/hooks/plugins, cwd-confined. Enforced as flags on every launch, not by prompt.
const REVIEW_TOOLS = 'Read,Grep,Glob';
const REVIEW_INSTRUCTION = 'You are a code reviewer. Read the applicable AGENTS.md and CLAUDE.md files inside the repository. Focus only on the diff, paths, line ranges or findings the caller specifies; use the supplied manifest. Do not rescan unrelated parts of the repository and do not repeat earlier reports. Re-inspect the current source of anything you comment on: never approve based on stale content.';
export const REVIEW_POLICY = Object.freeze(['--bare','--restricted',`--tools=${REVIEW_TOOLS}`,'--disallowedTools=mcp__*','--strict-mcp-config','--mcp-config={"mcpServers":{}}',`--append-system-prompt=${REVIEW_INSTRUCTION}`]);
export const validBudget = v => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100);
function killGroup(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
}
function terminalDiagnostic(result, env) {
  if (result?.type !== 'result' || (result.subtype != null && typeof result.subtype !== 'string')) return;
  if (!(result.is_error === true || /^error(?:_|$)/.test(result.subtype ?? ''))) return;
  if (result.result != null && typeof result.result !== 'string') return;
  if (result.errors != null && (!Array.isArray(result.errors) || !result.errors.every(value => typeof value === 'string'))) return;
  if (result.permission_denials != null && (!Array.isArray(result.permission_denials) || result.permission_denials.length)) return;
  let text = redact((result.errors ?? []).filter(value => value.trim()).join('; ') || result.result || '', env);
  for (const header of (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const value = header.slice(header.indexOf(':') + 1).trim();
    if (header.includes(':') && value) {
      text = text.split(value).join('[redacted]');
      const bearer = /^Bearer\s+(.+)$/i.exec(value);
      if (bearer) text = text.split(bearer[1]).join('[redacted]');
    }
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, value => {
    try { return new URL(value).origin; } catch { return '[url]'; }
  }).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  if (!text) return;
  const status = /^API Error:\s*([45]\d{2})(?=\s|$)/.exec(text);
  return { source: 'result', text: text.slice(0, 1000), ...(status ? { http_status: Number(status[1]) } : {}),
    ...(text.length > 1000 ? { truncated: true } : {}) };
}
function validTerminalResult(event, session) {
  return event?.type === 'result' && typeof event.subtype === 'string' && typeof event.is_error === 'boolean'
    && (event.result == null || typeof event.result === 'string')
    && (event.errors == null || (Array.isArray(event.errors) && event.errors.every(value=>typeof value==='string')))
    && (event.permission_denials == null || Array.isArray(event.permission_denials))
    && (event.subtype !== 'success' || event.is_error || typeof event.result === 'string')
    && (!session || event.session_id === session.uuid);
}
export async function runAsk(args, config, signal, options = {}) {
  if (signal?.aborted) throw new RunnerError('cancelled','Request cancelled before execution');
  const mountedRoots = config.mountedRoots ?? [config.root];
  const {cwd,roots} = await resolveWorkspace(args.cwd, config.root, mountedRoots);
  const addDirs = roots.filter(p=>p!==cwd);
  if (signal?.aborted) throw new RunnerError('cancelled','Request cancelled before execution');
  if (!validBudget(args.max_budget_usd)) throw new RunnerError('invalid_request','max_budget_usd must be a finite number in (0, 100]');
  const session = args.session;
  const argv = ['-p','--output-format',options.stream ? 'stream-json' : 'json',...(session ? [`--${session.mode === 'new' ? 'session-id' : 'resume'}=${session.uuid}`] : ['--no-session-persistence']),'--no-chrome',
    '--permission-prompts','none','--permission-mode',config.permissionMode];
  if (args.review) argv.push(...REVIEW_POLICY);
  if (args.max_budget_usd !== undefined) argv.push(`--max-budget-usd=${args.max_budget_usd}`);
  if (options.stream) argv.push('--verbose','--include-partial-messages');
  const diagnostics = config.streamDiagnostics ? new StreamDiagnostics() : null;
  if (diagnostics) argv.push('--debug-to-stderr');
  if (!args.review) for (const dir of addDirs) argv.push(`--add-dir=${dir}`);
  if (args.model) argv.push(`--model=${args.model}`);
  const allowed = args.review ? [REVIEW_TOOLS] : config.allowedTools;
  if (allowed?.length) argv.push('--allowedTools',allowed.join(','));
  const env = childEnvironment(config.env);
  if (session) env.CLAUDE_CONFIG_DIR = session.configDir;
  return new Promise((resolveResult, reject) => {
    let failure, timer, killTimer, resultTimer, exitTimer, bytes = 0, exited = false;
    const stdout = [], stderr = [];
    const decoder=new StringDecoder('utf8');
    let pendingLine = '', finalResult, assistantText = '', stderrBytes = 0, stderrTruncated = false;
    let jsonDepth = 0, jsonString = false, jsonEscape = false, jsonStarted = false, jsonFinished = false;
    const secrets = ['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','CF_ACCESS_CLIENT_SECRET','CF_ACCESS_CLIENT_ID'].map(k=>env[k]).filter(Boolean);
    const longestSecret=Math.max(0,...secrets.map(s=>s.length));
    const rawLimit=config.maxOutput+longestSecret;
    // Capture enough UTF-8 bytes for 2000 characters plus a complete secret crossing
    // the visible boundary; redact the complete capture before shortening the message.
    const stderrCaptureBytes=(2000+longestSecret)*4;
    const retainRaw = text => {
      let cut=Math.max(0,text.length-rawLimit);
      // Never cut inside a full configured secret: its remaining suffix must not leak.
      for(const secret of secrets){
        const near=Math.max(0,cut-secret.length+1);let at=text.indexOf(secret,near);
        while(at>=0&&at<cut){if(at+secret.length>cut)cut=at+secret.length;at=text.indexOf(secret,at+1);}
      }
      return text.slice(cut);
    };
    const hideTrailingSecretPrefix = text => {
      let hold = 0;
      for (const secret of secrets) for(let n=1;n<secret.length;n++) if(text.endsWith(secret.slice(0,n)))hold=Math.max(hold,n);
      if(hold)text=text.slice(0,-hold);
      return text;
    };
    const safeProgress = () => {
      // Hold possible trailing secret prefixes until future chunks disambiguate them.
      const text = hideTrailingSecretPrefix(assistantText);
      options.onProgress?.({partial_answer:redact(text,env).slice(-config.maxOutput)});
    };
    const line = text => {
      let event; try { event=JSON.parse(text); } catch { return; }
      diagnostics?.event(event);
      if(event?.type==='result'){
        if(finalResult) return;
        finalResult=event;
        const valid = validTerminalResult(event,session);
        if(!exited && !resultTimer) resultTimer=setTimeout(()=>fail(valid?'cli_shutdown_timeout':session && event.session_id!==session.uuid?'session_mismatch':'invalid_json','Claude emitted a terminal result but did not exit; execution stopped and was not retried.'),5000);
        return;
      }
      const delta=event?.type==='stream_event' ? event.event?.delta : null;
      if(delta?.type==='text_delta'&&typeof delta.text==='string'){
        assistantText=retainRaw(assistantText+delta.text);safeProgress();
      } else if(event?.type==='assistant'&&Array.isArray(event.message?.content)){
        const texts=event.message.content.filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join('');
        if(texts){assistantText=retainRaw(texts);safeProgress();}
      }
    };
    const child = spawn(config.command, argv, { cwd, env, shell:false,
      detached:process.platform !== 'win32', stdio:['pipe','pipe','pipe'] });
    const fail = (code, message) => {
      if (failure) return;
      failure = new RunnerError(code,message);
      if(exited) return;
      killGroup(child,'SIGTERM');
      killTimer = setTimeout(()=>killGroup(child,'SIGKILL'),300);
      killTimer.unref();
    };
    const abort = ()=>fail('cancelled','Request cancelled; execution may have started. Not retried.');
    signal?.addEventListener('abort',abort,{once:true});
    const deadline=args.timeout_ms ?? config.timeoutMs;
    if(deadline>0)timer = setTimeout(()=>fail('timeout','Claude timed out; execution may have started. Not retried.'),deadline);
    for (const [stream, buffer] of [[child.stdout,stdout],[child.stderr,stderr]]) {
      stream.on('data',chunk=>{
        if(options.stream){
          if(stream===child.stderr){
            if(diagnostics){diagnostics.stderr(chunk);return;}
            const remaining=Math.max(0,stderrCaptureBytes-stderrBytes);
            if(chunk.length>remaining)stderrTruncated=true;
            if(remaining){const kept=chunk.subarray(0,remaining);buffer.push(kept);stderrBytes+=kept.length;}
            return;
          }
          pendingLine+=decoder.write(chunk);
          let index;while((index=pendingLine.indexOf('\n'))!==-1){const next=pendingLine.slice(0,index);pendingLine=pendingLine.slice(index+1);line(next);}
          if(Buffer.byteLength(pendingLine)>Math.max(config.maxOutput*4,1048576))fail('output_limit','Claude stream frame exceeded configured limit; not retried');
        }else{
          if(stream===child.stderr && diagnostics){diagnostics.stderr(chunk);return;}
          bytes += chunk.length;
          if (bytes > config.maxOutput) fail('output_limit','Claude output exceeded configured limit; not retried');
          else {
            buffer.push(chunk);
            if(stream===child.stdout && !jsonFinished) for(const byte of chunk){
              if(jsonString){
                if(jsonEscape) jsonEscape=false;
                else if(byte===92) jsonEscape=true;
                else if(byte===34) jsonString=false;
              }else if(byte===34) jsonString=true;
              else if(byte===123 || byte===91){jsonStarted=true;jsonDepth++;}
              else if(jsonStarted && (byte===125 || byte===93) && --jsonDepth===0){
                jsonFinished=true;line(Buffer.concat(stdout).toString('utf8'));break;
              }
            }
          }
        }
      });
    }
    child.stdin.on('error',()=>{}); // Early exit can close stdin before the prompt flushes.
    child.on('error',()=>fail('spawn_failed','Cannot start Claude Code executable'));
    child.on('exit',()=>{
      exited=true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(resultTimer);
      killGroup(child,'SIGKILL');
      exitTimer=setTimeout(()=>{
        child.stdout.destroy();
        child.stderr.destroy();
      },500);
    });
    child.on('close',(exitCode)=>{
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(resultTimer); clearTimeout(exitTimer);
      signal?.removeEventListener('abort',abort);
      diagnostics?.end();
      const out = Buffer.concat(stdout).toString('utf8').trim();
      let rawError=Buffer.concat(stderr).toString('utf8');
      if(stderrTruncated)rawError=hideTrailingSecretPrefix(rawError.replace(/\uFFFD+$/u,''));
      const err = redact(rawError,env).slice(0,2000);
      let result;
      try { if(options.stream){pendingLine+=decoder.end();if(pendingLine.trim())line(pendingLine);result=finalResult;if(!result)throw new Error('missing result');}else result = JSON.parse(out); } catch {
        if(failure){reject(failure);return;}
        reject(exitCode !== 0 ? new RunnerError('claude_exit',`Claude exited with code ${exitCode}${err ? ': '+err : ''}`) : new RunnerError('invalid_json','Claude did not return a valid JSON result')); return;
      }
      const usage = normalizeUsage(result, session ? (result?.session_id === session.uuid ? session.previousCost : undefined) : 0);
      const accounting = result?.type === 'result' && (Object.keys(usage.invocation).length || Object.keys(usage.conversationModelUsage).length || usage.conversationCostUSD !== null) ? {usage} : undefined;
      if(failure){
        const denied = validTerminalResult(result,session) && result.permission_denials?.length;
        if(validTerminalResult(result,session) && (accounting || denied)) failure.details={...failure.details,...accounting,...(denied?{permission_denied:true}:{})};
        reject(failure);return;
      }
      if (exitCode !== 0) {
        const diagnostic = terminalDiagnostic(result, env);
        const detail = [err, diagnostic?.text].filter(Boolean).join('; ');
        const details = accounting || diagnostic ? { ...accounting, ...(diagnostic ? { cli_diagnostic: diagnostic } : {}) } : undefined;
        reject(new RunnerError('claude_exit',`Claude exited with code ${exitCode}${detail ? ': '+detail : ''}`,details)); return;
      }
      if (result?.result != null && typeof result.result !== 'string') {
        reject(new RunnerError('invalid_json','Claude result field has an unexpected JSON shape'));return;
      }
      if (result?.errors != null && (!Array.isArray(result.errors) || !result.errors.every(x=>typeof x==='string'))) {
        reject(new RunnerError('invalid_json','Claude errors field has an unexpected JSON shape'));return;
      }
      if (result?.permission_denials != null && !Array.isArray(result.permission_denials)) {
        reject(new RunnerError('invalid_json','Claude permission_denials field has an unexpected JSON shape'));return;
      }
      if (!result || result.type !== 'result' || result.is_error === true || result.subtype !== 'success') {
        const detail = redact((result?.errors ?? []).join('; ') || result?.result || 'Claude reported an unsuccessful result',env).slice(0,2000);
        reject(new RunnerError('claude_error',detail,accounting)); return;
      }
      if (result.permission_denials?.length) {
        // Only tool names are surfaced: never tool inputs or any partial answer.
        const toolNames = [...new Set(result.permission_denials.map(d=>d?.tool_name).filter(n=>typeof n==='string'&&n))].map(n=>redact(n,env));
        reject(new RunnerError('permission_denied','Claude reported tool permission denials; configure allowed tools or permission mode explicitly',
          {tool_names:toolNames,permission_mode:config.permissionMode,allowed_tools:(config.allowedTools??[]).map(t=>redact(t,env)),cwd,execution_started:true,...accounting})); return;
      }
      if (typeof result.result !== 'string') { reject(new RunnerError('invalid_json','Claude result is missing its answer')); return; }
      if (session && result.session_id !== session.uuid) { reject(new RunnerError('session_mismatch','Claude returned a different or missing session id; the conversation is no longer trusted',accounting)); return; }
      resolveResult({answer:redact(result.result,env).slice(0,config.maxOutput),...(result.result.length>config.maxOutput?{truncated:true}:{}),model:args.model ?? null,cwd,
        ...(typeof result.duration_ms === 'number' ? {duration_ms:result.duration_ms} : {}),
        ...(typeof result.num_turns === 'number' ? {num_turns:result.num_turns} : {}),
        ...(session ? {cli_session_id:session.uuid} : {}),usage});
    });
    child.stdin.end(args.prompt);
  }).catch(error=>{
    if(diagnostics && error instanceof RunnerError) error.details={...error.details,stream_diagnostic:diagnostics.snapshot()};
    throw error;
  });
}
