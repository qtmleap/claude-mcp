import {spawn} from 'node:child_process';
import {RunnerError,redact} from './errors.mjs';
export function capture(command,args,{env,input='',timeoutMs=2500,maxBytes=65536,signal}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new RunnerError('cancelled','Context probe cancelled',{execution_started:false}));return;}
  const child=spawn(command,args,{env,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});let output='',error='',bytes=0,failure;
  const stop=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();};
  const fail=(code,message)=>{failure??=new RunnerError(code,message,{execution_started:false});stop();};
  const timer=setTimeout(()=>fail('context_timeout','Execution context command exceeded its bounded deadline'),timeoutMs);
  const abort=()=>fail('cancelled','Context probe cancelled');signal?.addEventListener('abort',abort,{once:true});
  for(const [stream,isError] of [[child.stdout,false],[child.stderr,true]])stream.on('data',c=>{bytes+=c.length;if(bytes>maxBytes){fail('context_output_limit','Execution context command exceeded its output limit');return;}if(isError)error+=c;else output+=c;});
  child.on('error',()=>fail('context_unavailable','Cannot start configured execution context command'));
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failure)reject(failure);else if(code!==0)reject(new RunnerError('context_unavailable',`Execution context command failed (${code})${error?': '+redact(error,env).slice(0,500):''}`,{execution_started:false}));else resolve(output);});
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
