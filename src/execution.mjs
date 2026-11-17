import {platform} from 'node:os';
import {resolveWorkspace} from './workspace.mjs';
import {capture} from './command-capture.mjs';
import {selectProfile,dockerEnvironment} from './execution-profiles.mjs';
import {probeDocker,runDocker} from './docker-execution.mjs';
import {runAsk} from './runner.mjs';
export async function executionContext(args,config,signal){
 const p=selectProfile(args.execution_profile,config);
 if(p)return probeDocker(args.execution_profile,p,config,args.cwd,signal);
 const ws=await resolveWorkspace(args.cwd,config.root,config.mountedRoots??[config.root]);let cli;
 try{cli={ok:true,output:(await capture(config.command,['--version'],{env:dockerEnvironment(config),signal,maxBytes:8192})).trim().slice(0,1024)};}catch(e){if(e.code==='cancelled')throw e;cli={ok:false,reason:e.code??'not_executable'};}
 return {profile:'local',backend:'local',status:'probed',platform:platform(),cwd:ws.cwd,roots:ws.roots,cli,tools:[]};
}
export async function runExecution(args,config,signal,options){
 if(args.execution)return runDocker(args,config,signal,options);
 const result=await runAsk(args,config,signal,{...options,localContext:true});
 return {...result,execution_context:{profile:'local',backend:'local',status:'configured',platform:platform(),cwd:result.cwd,roots:config.mountedRoots??[config.root],tools:[]}};
}
