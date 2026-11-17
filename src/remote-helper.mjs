// Sent as fixed, trusted source to the registered Node executable. No daemon or
// installed helper is required. Inputs, provider values and prompts are never logged.
import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import {promises as fsp} from 'node:fs';
import {posix as path} from 'node:path';

const provider=['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_CUSTOM_HEADERS','CF_ACCESS_CLIENT_ID','CF_ACCESS_CLIENT_SECRET'];
const safe=['PATH','LANG','LC_ALL','TZ','VIRTUAL_ENV'];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
function environment(overrides={},auth=false){const result={};for(const k of [...safe,...(auth?provider:[])])if(process.env[k]!==undefined)result[k]=process.env[k];return {...result,...overrides};}
function proc(pid){
 try{const s=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),a=s.slice(s.lastIndexOf(')')+2).split(' ');return {pid:Number(pid),state:a[0],ppid:Number(a[1]),group:Number(a[2]),start:a[19]};}catch{return null;}
}
const alive=p=>{const now=proc(p?.pid);return !!now&&now.start===p.start&&now.state!=='Z';};
function ownedDir(dir){const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw new Error('unsafe_state_directory');}
function write(dir,name,data){const tmp=path.join(dir,name+'.tmp');fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600});fs.renameSync(tmp,path.join(dir,name));}
function read(dir,name){try{ownedDir(dir);return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch{return null;}}
async function workspace(p){
 const invalid=reason=>{throw Object.assign(new Error(reason),{reason});};
 let cwd,roots;
 try{cwd=await fsp.realpath(path.resolve(p.root,p.cwd??p.root));if(!(await fsp.stat(cwd)).isDirectory())invalid('not_a_directory');roots=await Promise.all(p.roots.map(async r=>{const c=await fsp.realpath(r);if(!(await fsp.stat(c)).isDirectory())invalid('mounted_root_unavailable');return c;}));}catch(e){invalid(e.reason??(e.code==='ENOENT'?'path_not_found':'path_not_accessible'));}
 if(!roots.some(r=>{const rel=path.relative(r,cwd);return !rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../'));}))invalid('outside_mounted_roots');
 return {cwd,roots:[...new Set(roots)]};
}
async function version(command,args,env){
 return new Promise(resolve=>{
  let out='',bytes=0,done=false;const child=spawn(command,args,{env,detached:true,stdio:['ignore','pipe','pipe'],shell:false});
  const finish=(ok,reason)=>{if(done)return;done=true;clearTimeout(timer);try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}child.stdout.destroy();child.stderr.destroy();resolve({ok,output:out.trim().slice(0,1024),...(reason?{reason}:{})});};
  const timer=setTimeout(()=>finish(false,'timeout'),1000);
  for(const stream of [child.stdout,child.stderr])stream.on('data',c=>{bytes+=c.length;if(bytes>4096){finish(false,'output_limit');return;}out+=c;});
  child.on('error',()=>finish(false,'not_executable'));child.on('close',code=>finish(code===0,code===0?undefined:'nonzero_exit'));
 });
}
async function probe(p){
 const ws=await workspace(p),env=environment(p.env);
 const [cli,...tools]=await Promise.all([version(p.cli,['--bare','--setting-sources','','--strict-mcp-config','--mcp-config={"mcpServers":{}}','--version'],env),...(p.tools??[]).map(async tool=>({name:tool.name,...await version(tool.command,tool.args,env)}))]);
 return {...ws,platform:process.platform,uid:process.getuid(),gid:process.getgid(),cli,tools};
}
async function cancel(dir,nonce){
 try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 ownedDir(dir);fs.writeFileSync(path.join(dir,'cancel'),nonce,{mode:0o600});
 const until=Date.now()+1000;
 do{
  const outcome=read(dir,'outcome.json');if(outcome?.nonce===nonce)return outcome;
  const state=read(dir,'state.json');
  if(state?.nonce===nonce&&alive(state.helper)){try{process.kill(state.helper.pid,'SIGTERM');}catch{}}
  else if(state?.nonce===nonce&&state.helper){return {nonce,cleanup:{status:'uncertain',reason:'helper_owner_unavailable'}};}
  await delay(25);
 }while(Date.now()<until);
 return {nonce,cleanup:{status:'uncertain',reason:'cleanup_not_confirmed'}};
}
async function release(dir,nonce){
 const outcome=read(dir,'outcome.json'),state=read(dir,'state.json');
 if(outcome?.nonce!==nonce||outcome.cleanup?.status!=='confirmed')return {released:false};
 for(let n=0;n<20&&alive(state?.helper);n++)await delay(20);
 if(alive(state?.helper))return {released:false};
 await fsp.rm(dir,{recursive:true});return {released:true};
}
async function run(p,dir){
 let created=false;
 try{fs.mkdirSync(dir,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
 ownedDir(dir);
 if(!created){
  if(fs.existsSync(path.join(dir,'cancel'))&&!read(dir,'state.json')){
   const outcome={type:'claude_mcp',event:'finished',nonce:p.nonce,cleanup:{status:'confirmed'},exit_code:1,execution_started:false};write(dir,'outcome.json',outcome);emit(outcome);process.exitCode=1;return;
  }
  throw new Error('resource_already_exists');
 }
 const helper=proc(process.pid);if(!helper)throw new Error('linux_proc_required');
 const state={nonce:p.nonce,helper,child:null,tracked:[]};write(dir,'state.json',state);
 let cancelled=false,child,childExit,scanTimer,cleaning;
 const tracked=new Map();
 const scan=()=>{
  const all=[];try{for(const id of fs.readdirSync('/proc'))if(/^\d+$/.test(id)){const item=proc(id);if(item)all.push(item);}}catch{}
  let changed=true;while(changed){changed=false;for(const item of all){
   if(item.pid===process.pid||tracked.has(item.pid))continue;
   // A nonce inherited in the child environment survives reparenting/setsid.
   // Match it only in same-UID processes, then pin Linux start time before signals.
   let tagged=false;try{if(fs.statSync('/proc/'+item.pid).uid===process.getuid())tagged=fs.readFileSync('/proc/'+item.pid+'/environ').includes(Buffer.from('CLAUDE_MCP_EXECUTION_NONCE='+p.nonce+'\0'));}catch{}
   if(tagged||(state.child&&alive(state.child)&&item.ppid===state.child.pid)||[...tracked.values()].some(x=>x.pid===item.ppid&&alive(x))){tracked.set(item.pid,item);changed=true;}
  }}
  state.tracked=[...tracked.values()];write(dir,'state.json',state);
 };
 const signalOwned=signal=>{
  if(state.child&&alive(state.child)){try{process.kill(-state.child.pid,signal);}catch{}}
  for(const item of tracked.values())if(alive(item)){try{process.kill(item.pid,signal);}catch{}}
 };
 const cleanup=()=>cleaning??=(async()=>{
  clearInterval(scanTimer);scan();signalOwned('SIGTERM');await delay(150);scan();signalOwned('SIGKILL');await delay(100);
  const remaining=[state.child,...tracked.values()].filter(x=>x&&alive(x)).map(x=>({pid:x.pid,start:x.start}));
  let files=true;try{await fsp.rm(path.join(dir,'home'),{recursive:true,force:true});await fsp.rm(path.join(dir,'claude'),{recursive:true,force:true});}catch{files=false;}
  return {status:remaining.length||!files?'uncertain':'confirmed',boundary:'process_group_and_tagged_or_observed_descendants',...(remaining.length?{remaining}:{}),...(!files?{reason:'private_state_cleanup_failed'}:{})};
 })();
 const stop=()=>{cancelled=true;if(child)signalOwned('SIGTERM');};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 process.stdout.on('error',stop);process.stderr.on('error',stop);
 let exitCode=1,executionStarted=false,cleanupResult;
 try{
  const ws=await workspace(p);
  if(ws.cwd!==p.cwd||JSON.stringify(ws.roots)!==JSON.stringify(p.canonical_roots)||process.getuid()!==p.uid||process.getgid()!==p.gid)throw new Error('context_changed');
  if(fs.existsSync(path.join(dir,'cancel')))cancelled=true;
  if(!cancelled){
   await fsp.mkdir(path.join(dir,'home'),{mode:0o700});await fsp.mkdir(path.join(dir,'claude'),{mode:0o700});
   const env={...environment(p.env,true),HOME:path.join(dir,'home'),CLAUDE_CONFIG_DIR:path.join(dir,'claude'),CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_RETRY_WATCHDOG:'0',CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_MCP_EXECUTION_NONCE:p.nonce};
   if(fs.existsSync(path.join(dir,'cancel')))cancelled=true;
   if(!cancelled){
    child=spawn(p.cli,p.argv,{cwd:ws.cwd,env,detached:true,stdio:['pipe','pipe','pipe'],shell:false});
    childExit=new Promise(resolve=>{child.on('exit',code=>resolve(code??1));child.on('error',()=>resolve(1));});
    state.child=proc(child.pid);if(state.child)tracked.set(child.pid,state.child);write(dir,'state.json',state);
    executionStarted=true;emit({type:'claude_mcp',event:'started',nonce:p.nonce,helper_pid:helper.pid,helper_start:helper.start,child_pid:child.pid,child_start:state.child?.start});
    scanTimer=setInterval(scan,25);
    child.stdout.pipe(process.stdout,{end:false});child.stderr.pipe(process.stderr,{end:false});child.stdin.on('error',()=>{});child.stdin.end(p.prompt);
    if(cancelled)signalOwned('SIGTERM');
    exitCode=await childExit;
   }
  }
 }catch(e){emit({type:'claude_mcp',event:'setup_error',nonce:p.nonce,reason:e.reason??'target_setup_failed',execution_started:executionStarted});}
 finally{
  cleanupResult=await cleanup();
  if(child){await Promise.race([new Promise(r=>child.on('close',r)),delay(300)]);child.stdout.destroy();child.stderr.destroy();}
  const outcome={type:'claude_mcp',event:'finished',nonce:p.nonce,cleanup:cleanupResult,exit_code:exitCode,execution_started:executionStarted};write(dir,'outcome.json',outcome);process.stdout.write('\n');emit(outcome);
  process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);process.exitCode=cleanupResult.status==='confirmed'?exitCode:125;
 }
}
try{
 let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>1048576)throw new Error('input_limit');}
 const p=JSON.parse(raw);
 if(p.mode==='probe')emit(await probe(p));
 else{
  if(process.platform!=='linux'||!/^[a-f0-9]{32}$/.test(p.nonce))throw new Error('invalid_resource');
  const dir=`/tmp/claude-mcp-${p.nonce}`;
  if(p.mode==='run')await run(p,dir);
  else if(p.mode==='cancel')emit(await cancel(dir,p.nonce));
  else if(p.mode==='release')emit(await release(dir,p.nonce));
  else throw new Error('invalid_mode');
 }
}catch(e){emit({error:{code:'target_context_failed',reason:e.reason??e.code??'invalid_target_context',execution_started:false}});process.exitCode=1;}
