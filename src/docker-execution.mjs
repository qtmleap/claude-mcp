import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {capture} from './command-capture.mjs';
import {RunnerError,childEnvironment} from './errors.mjs';
import {dockerEnvironment,PROVIDER_KEYS,targetCwd} from './execution-profiles.mjs';
import {runAsk} from './runner.mjs';

const helper=readFileSync(new URL('./remote-helper.mjs',import.meta.url),'utf8');
const controlArgs=(p,id)=>['exec','--interactive','--user',p.user,id,p.node,'--input-type=module','--eval',helper];
const parse=text=>{try{return JSON.parse(text);}catch{throw new RunnerError('context_unavailable','Execution context returned invalid bounded JSON',{execution_started:false});}};
export async function probeDocker(id,p,config,cwd,signal){
 const env=dockerEnvironment(config),labels=Object.keys(p.expected_labels).map(k=>`${JSON.stringify(k)}:{{json (index .Config.Labels ${JSON.stringify(k)})}}`).join(',');
 const format=`{"id":{{json .Id}},"running":{{json .State.Running}},"mounts":{{json .Mounts}},"labels":{${labels}}}`;
 const info=parse(await capture(config.dockerCommand,['inspect','--type','container','--format',format,p.container],{env,signal}));
 const invalid=reason=>{throw new RunnerError('invalid_context',`Registered Docker context is unavailable (${reason})`,{profile:id,reason,execution_started:false});};
 if(!/^[a-f0-9]{64}$/.test(info.id)||info.running!==true)invalid('container_not_running');
 for(const mount of p.expected_mounts)if(!info.mounts?.some(m=>m.Type===mount.type&&m.Source===mount.source&&m.Destination===mount.target))invalid('project_mount_mismatch');
 for(const [k,v] of Object.entries(p.expected_labels))if(info.labels?.[k]!==v)invalid('project_label_mismatch');
 const found=parse(await capture(config.dockerCommand,controlArgs(p,info.id),{env,signal,input:JSON.stringify({mode:'probe',...p,cwd:targetCwd(cwd,p)})}));
 if(found.error)invalid(found.error.reason??'target_probe_failed');
 if(found.platform!=='linux'||!Number.isInteger(found.uid)||!Number.isInteger(found.gid)||typeof found.cwd!=='string'||!Array.isArray(found.roots)||!found.roots.every(r=>typeof r==='string'))invalid('invalid_target_evidence');
 if(!found.cli?.ok)invalid('claude_not_executable');
 return {profile:id,backend:'docker',status:'probed',platform:found.platform,cwd:found.cwd,roots:found.roots,container_id:info.id,user:p.user,uid:found.uid,gid:found.gid,cli:found.cli,tools:found.tools??[],instruction_loading:'explicit AGENTS.md/CLAUDE.md; project/user settings, hooks, plugins and MCP disabled'};
}
export function remoteResource(){const nonce=randomBytes(16).toString('hex');return {nonce,path:`/tmp/claude-mcp-${nonce}`,cleanup:{status:'pending',boundary:'process_group_and_tagged_or_observed_descendants'}};}
export async function runDocker(args,config,signal,options={}){
 const {profile:p,context:ctx}=args.execution;const resource=ctx.resource;let child,finished,stopping,controlTail='',setupError;
 const env=childEnvironment(dockerEnvironment(config,true));
 const notify=patch=>{if(patch.resource)patch.resource={...ctx.resource,...patch.resource};Object.assign(ctx,patch);options.onExecution?.(patch);};
 const control=async mode=>parse(await capture(config.dockerCommand,controlArgs(p,ctx.container_id),{env:dockerEnvironment(config),input:JSON.stringify({mode,nonce:resource.nonce}),timeoutMs:1800,maxBytes:16384}));
 const stop=()=>stopping??=(async()=>{
  try{const value=await control('cancel');if(!finished&&value.nonce===resource.nonce)finished=value;}
  catch{if(!finished)finished={cleanup:{status:'uncertain',reason:'target_cleanup_unreachable'}};}
  finally{try{if(child?.pid)process.kill(-child.pid,'SIGKILL');}catch{}}
 })();
 const launch=argv=>{
  const note=`Execution context: backend=Docker; OS=${ctx.platform}; cwd=${JSON.stringify(ctx.cwd)}; roots=${JSON.stringify(ctx.roots)}. CLI observed: ${JSON.stringify(ctx.cli.output)}. Tool probes (only these are observed; other tools are unprobed): ${JSON.stringify(ctx.tools)}. This context does not grant permissions. User/project settings, hooks, plugins and MCP are disabled. Read applicable AGENTS.md and CLAUDE.md files using permitted file tools before work.`;
  const append=argv.find(a=>a.startsWith('--append-system-prompt='));argv=argv.filter(a=>!a.startsWith('--append-system-prompt='));
  argv.push(`--append-system-prompt=${append?append.slice('--append-system-prompt='.length)+'\n':''}${note}`);
  if(!argv.includes('--bare'))argv.push('--bare');
  if(!argv.includes('--strict-mcp-config'))argv.push('--strict-mcp-config','--mcp-config={"mcpServers":{}}');
  argv.push('--setting-sources','');
  const provider=PROVIDER_KEYS.filter(k=>typeof env[k]==='string');
  const dockerArgs=['exec','--interactive','--user',p.user,...provider.flatMap(k=>['--env',k]),ctx.container_id,p.node,'--input-type=module','--eval',helper];
  child=spawn(config.dockerCommand,dockerArgs,{env,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  const end=child.stdin.end.bind(child.stdin);child.stdin.end=prompt=>end(JSON.stringify({mode:'run',nonce:resource.nonce,root:p.root,roots:p.roots,canonical_roots:ctx.roots,cwd:ctx.cwd,uid:ctx.uid,gid:ctx.gid,cli:p.cli,env:p.env,argv,prompt}));
  child.stdout.on('data',chunk=>{
   controlTail+=chunk.toString();let i;while((i=controlTail.indexOf('\n'))>=0){const line=controlTail.slice(0,i);controlTail=controlTail.slice(i+1);let frame;try{frame=JSON.parse(line);}catch{continue;}
    if(frame.type!=='claude_mcp'||frame.nonce!==resource.nonce)continue;
    if(frame.event==='started')notify({resource:{...resource,helper_pid:frame.helper_pid,helper_start:frame.helper_start,child_pid:frame.child_pid,child_start:frame.child_start}});
    else if(frame.event==='finished')finished=frame;
    else if(frame.event==='setup_error')setupError=frame;
   }
   if(Buffer.byteLength(controlTail)>4*1024*1024)controlTail='';
  });return child;
 };
 const settle=async()=>{
  if(stopping)await stopping;
  if(!finished)await stop();
  let cleanup=finished?.cleanup??{status:'uncertain',reason:'missing_target_receipt'};
  if(cleanup.status==='confirmed'){
   try{const value=await control('release');if(!value.released)cleanup={...cleanup,status:'uncertain',reason:'private_state_release_unconfirmed'};}
   catch{cleanup={...cleanup,status:'uncertain',reason:'private_state_release_unreachable'};}
  }
  notify({cleanup,resource:{...resource,cleanup}});
  if(cleanup.status!=='confirmed')throw new RunnerError('cleanup_uncertain','Target cleanup could not be confirmed; execution was not retried',{cleanup,container_id:ctx.container_id,resource:resource.path,execution_started:finished?.execution_started??true});
  if(setupError)throw new RunnerError('invalid_context','Target context changed before launch',{reason:setupError.reason,execution_started:setupError.execution_started});
 };
 return runAsk(args,config,signal,{...options,stream:true,workspace:{cwd:ctx.cwd,roots:ctx.roots},environment:env,launch,terminate:stop,settle}).then(result=>({...result,execution_context:{...ctx,cleanup:finished.cleanup}}));
}
