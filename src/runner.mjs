import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { stat, realpath } from 'node:fs/promises';
import { resolve, isAbsolute, relative } from 'node:path';

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
  const result = { ...env, CLAUDE_CODE_MAX_RETRIES:'0', CLAUDE_CODE_RETRY_WATCHDOG:'0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1' };
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
export async function resolveCwd(cwd, root, mountedRoots = [root]) {
  const path = cwd ? (isAbsolute(cwd) ? cwd : resolve(root, cwd)) : root;
  const invalid = reason => new RunnerError('invalid_cwd',
    `The requested cwd is not available on the MCP host (${reason}). Omit cwd for questions that do not access files; file tasks must select an existing mounted directory.`,
    {reason,requested_cwd:cwd??null,resolved_path:path,default_cwd:root,mounted_roots:mountedRoots,execution_started:false});
  let info,canonical,roots;
  try { info=await stat(path); }
  catch(error) { throw invalid(error.code==='ENOENT'?'path_not_found':'path_not_accessible'); }
  if(!info.isDirectory())throw invalid('not_a_directory');
  try { canonical=await realpath(path); } catch { throw invalid('path_not_accessible'); }
  try { roots=await Promise.all(mountedRoots.map(p=>realpath(p))); }
  catch { throw invalid('mounted_root_unavailable'); }
  if(!roots.some(r=>{const rel=relative(r,canonical);return rel===''||(rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel));}))throw invalid('outside_mounted_roots');
  return canonical;
}
function killGroup(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
}
export async function runAsk(args, config, signal, options = {}) {
  if (signal?.aborted) throw new RunnerError('cancelled','Request cancelled before execution');
  const cwd = await resolveCwd(args.cwd, config.root, config.mountedRoots);
  if (signal?.aborted) throw new RunnerError('cancelled','Request cancelled before execution');
  const argv = ['-p','--output-format',options.stream ? 'stream-json' : 'json','--no-session-persistence','--no-chrome',
    '--permission-prompts','none','--permission-mode',config.permissionMode];
  if (options.stream) argv.push('--verbose','--include-partial-messages');
  if (args.model) argv.push(`--model=${args.model}`);
  if (config.allowedTools?.length) argv.push('--allowedTools',config.allowedTools.join(','));
  const env = childEnvironment(config.env);
  return new Promise((resolveResult, reject) => {
    let failure, timer, killTimer, bytes = 0;
    const stdout = [], stderr = [];
    const decoder=new StringDecoder('utf8');
    let pendingLine = '', finalResult, assistantText = '', stderrBytes = 0, stderrTruncated = false;
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
      if(event?.type==='result'){finalResult=event;return;}
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
            const remaining=Math.max(0,stderrCaptureBytes-stderrBytes);
            if(chunk.length>remaining)stderrTruncated=true;
            if(remaining){const kept=chunk.subarray(0,remaining);buffer.push(kept);stderrBytes+=kept.length;}
            return;
          }
          pendingLine+=decoder.write(chunk);
          let index;while((index=pendingLine.indexOf('\n'))!==-1){const next=pendingLine.slice(0,index);pendingLine=pendingLine.slice(index+1);line(next);}
          if(Buffer.byteLength(pendingLine)>Math.max(config.maxOutput*4,1048576))fail('output_limit','Claude stream frame exceeded configured limit; not retried');
        }else{
          bytes += chunk.length;
          if (bytes > config.maxOutput) fail('output_limit','Claude output exceeded configured limit; not retried');
          else buffer.push(chunk);
        }
      });
    }
    child.stdin.on('error',()=>{}); // Early exit can close stdin before the prompt flushes.
    child.on('error',()=>fail('spawn_failed','Cannot start Claude Code executable'));
    child.on('exit',()=>killGroup(child,'SIGKILL')); // Print is finite; clean up any same-group background descendants.
    child.on('close',(exitCode)=>{
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort',abort);
      if (failure) { killGroup(child,'SIGKILL'); reject(failure); return; }
      const out = Buffer.concat(stdout).toString('utf8').trim();
      let rawError=Buffer.concat(stderr).toString('utf8');
      if(stderrTruncated)rawError=hideTrailingSecretPrefix(rawError.replace(/\uFFFD+$/u,''));
      const err = redact(rawError,env).slice(0,2000);
      if (exitCode !== 0) { reject(new RunnerError('claude_exit',`Claude exited with code ${exitCode}${err ? ': '+err : ''}`)); return; }
      let result;
      try { if(options.stream){pendingLine+=decoder.end();if(pendingLine.trim())line(pendingLine);result=finalResult;if(!result)throw new Error('missing result');}else result = JSON.parse(out); } catch { reject(new RunnerError('invalid_json','Claude did not return a valid JSON result')); return; }
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
        reject(new RunnerError('claude_error',detail)); return;
      }
      if (result.permission_denials?.length) {
        reject(new RunnerError('permission_denied','Claude reported tool permission denials; configure allowed tools or permission mode explicitly')); return;
      }
      if (typeof result.result !== 'string') { reject(new RunnerError('invalid_json','Claude result is missing its answer')); return; }
      resolveResult({answer:redact(result.result,env).slice(0,config.maxOutput),...(result.result.length>config.maxOutput?{truncated:true}:{}),model:args.model ?? null,cwd,
        ...(typeof result.duration_ms === 'number' ? {duration_ms:result.duration_ms} : {}),
        ...(typeof result.num_turns === 'number' ? {num_turns:result.num_turns} : {})});
    });
    child.stdin.end(args.prompt);
  });
}
