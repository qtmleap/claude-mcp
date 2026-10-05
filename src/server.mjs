import express from 'express';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {JobStore} from './jobs.mjs';
import {redact} from './runner.mjs';
import {listModels} from './models.mjs';

const success=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
function redactValue(value,env){
 if(typeof value==='string')return redact(value,env);
 if(Array.isArray(value))return value.map(v=>redactValue(v,env));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redactValue(v,env)]));
 return value;
}
function failed(error,config){
 const data={error:{code:error.code||'operation_failed',message:redact(error.message||'Operation failed',config.env),...(error.details?{details:redactValue(error.details,config.env)}:{})}};
 return {isError:true,...success(data)};
}
export function createMcp(config, lifecycleSignal, requestSignals, sharedJobs) {
 const jobs=sharedJobs??new JobStore(config);
 if(!sharedJobs&&lifecycleSignal)lifecycleSignal.addEventListener('abort',()=>void jobs.close(),{once:true});
 const server=new McpServer({name:'claude-mcp',version:'0.1.0'},{instructions:`Call models for model identifiers and execution_context (source:configured means explicit fallback). Use start_job then get_job for long work. ask waits briefly then returns a recoverable job_id. Request cancellation/disconnect only stops waiting, never generation. Use cancel_job explicitly. Never resubmit an unconfirmed request; inspect list_jobs first. Omit cwd for questions, planning and reviews that do not need host files. Never automatically copy the caller current directory into cwd: the caller may be on another host or in an unmounted worktree. For file tasks, cwd must name a directory on this MCP host within ${config.mountedRoots.join(', ')}. Omitted cwd uses ${config.root}; relative paths resolve there. Invalid cwd errors include requested path, default cwd, mounted roots and execution_started:false. Do not silently change directories for file tasks. Other errors/disconnects/timeouts can follow file operations; never automatically resubmit them.`});
 const signal=extra=>AbortSignal.any([extra.signal,...(lifecycleSignal?[lifecycleSignal]:[]),...(requestSignals?.has(extra.requestId)?[requestSignals.get(extra.requestId).signal]:[])]);
 server.registerTool('models',{description:'List gateway models. Uses a configured list if the gateway does not expose a models API.',inputSchema:{},annotations:{readOnlyHint:true,openWorldHint:true}},async(_,extra)=>{
  try{return success({...await listModels(config,signal(extra)),execution_context:{default_cwd:config.root,mounted_roots:config.mountedRoots,cwd_optional:true,cwd_is_on:'mcp_host'}});}catch(e){return failed(e,config);}
 });
 const askSchema={
  prompt:z.string().min(1).max(262144),model:z.string().min(1).max(256).optional(),cwd:z.string().min(1).max(4096).describe(`Directory on MCP host, omit for questions. Allowed roots: ${config.mountedRoots.join(', ')}.`).optional(),
  wait_ms:z.number().int().min(0).max(30000).optional(),timeout_ms:z.number().int().min(0).max(1800000).describe('Deprecated bounded wait alias; never terminates generation.').optional(),
  execution_timeout_ms:z.number().int().min(50).max(2147483647).describe('Explicit opt-in execution deadline; omission permits unlimited generation time.').optional(),
  idempotency_key:z.string().min(1).max(128).optional()
 };
 const annotations={readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true};
 server.registerTool('ask',{description:'Start independent Claude job. Quick answers preserve legacy answer shape; long work returns job_id. Disconnect and wait deadlines never kill work. Never blindly retry.',inputSchema:askSchema,annotations},async(args)=>{
  try{const job=await jobs.start(args);const result=await jobs.get(job.job_id,Math.min(args.wait_ms??args.timeout_ms??config.waitMs??10000,30000));
   if(result.status==='completed')return success(result.result);
   if(result.status==='failed')return failed(Object.assign(new Error(result.error?.message||'Claude failed'),result.error),config);
   return success(result);
  }catch(e){return failed(e,config);}
 });
 server.registerTool('start_job',{description:'Start recoverable Claude job; returns job_id immediately. Use idempotency_key for safe retry.',inputSchema:askSchema,annotations},async(args)=>{try{return success(await jobs.start(args));}catch(e){return failed(e,config);}});
 server.registerTool('get_job',{description:'Get safe progress or final result; bounded wait never cancels generation.',inputSchema:{job_id:z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/),wait_ms:z.number().int().min(0).max(30000).optional()},annotations:{readOnlyHint:true}},async(args)=>{try{return success(await jobs.get(args.job_id,args.wait_ms??0));}catch(e){return failed(e,config);}});
 server.registerTool('list_jobs',{description:'List retained jobs, including unconfirmed requests. Does not expose prompts.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>{try{return success({jobs:await jobs.list()});}catch(e){return failed(e,config);}});
 server.registerTool('cancel_job',{description:'Explicitly cancel owned Claude process group. Idempotent; terminal jobs stay terminal.',inputSchema:{job_id:z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/)},annotations},async(args)=>{try{return success(await jobs.cancel(args.job_id));}catch(e){return failed(e,config);}});
 return server;
}
function authorized(req,token){
 const provided=Buffer.from(req.headers.authorization||'');const expected=Buffer.from('Bearer '+token);
 return provided.length===expected.length&&timingSafeEqual(provided,expected);
}
export async function startHttp(config, lifecycleSignal){
 const shutdown=new AbortController();const signal=AbortSignal.any([shutdown.signal,...(lifecycleSignal?[lifecycleSignal]:[])]);
 const app=express();const sessions=new Map();const jobs=new JobStore(config);await jobs.ready();
 app.get('/healthz',(_,res)=>res.json({status:'ok'}));
 app.use('/mcp',(req,res,next)=>{
  const host=req.headers.host?.toLowerCase();
  if(!host||host.includes('@')||host.includes('/')||!['127.0.0.1','localhost','[::1]','claude-mcp'].some(h=>host===h||host.startsWith(h+':'))) {res.status(403).end();return;}
  if(req.headers.origin && req.headers.origin!==`http://${host}`){res.status(403).end();return;}
  if(config.token&&!authorized(req,config.token)){res.status(401).end();return;}next();
 });
 app.use(express.json({limit:'512kb'}));
 app.all('/mcp',async(req,res)=>{
  if(req.method==='POST'&&Array.isArray(req.body)){res.status(400).json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Batch requests are unsupported'}});return;}
  const id=req.headers['mcp-session-id'];
  let entry=typeof id==='string'?sessions.get(id):undefined;
  if(!entry){
   if(id){res.status(404).end();return;}
   if(req.method!=='POST'||req.body?.method!=='initialize'){res.status(400).json({jsonrpc:'2.0',id:req.body?.id??null,error:{code:-32000,message:'Initialize an MCP session before calling tools'}});return;}
   if(sessions.size>=64){
    const idle=[...sessions.values()].filter(s=>!s.requestSignals.size).sort((a,b)=>a.lastUsed-b.lastUsed)[0];
    if(!idle){res.status(503).end();return;}
    sessions.delete(idle.id);idle.abort.abort();await idle.server.close().catch(()=>{});
   }
   const abort=new AbortController();const requestSignals=new Map();
   const server=createMcp(config,AbortSignal.any([signal,abort.signal]),requestSignals,jobs);
   entry={server,abort,requestSignals,lastUsed:Date.now(),id:null};
   const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),
    onsessioninitialized:sessionId=>{entry.id=sessionId;sessions.set(sessionId,entry);}});
   entry.transport=transport;
   await server.connect(transport);
   server.server.onclose=()=>{if(entry.id)sessions.delete(entry.id);abort.abort();};
  }
  entry.lastUsed=Date.now();
  const aborted=new AbortController();
  const requestId=req.body?.id;
  if(req.method==='POST'&&req.body?.method==='tools/call'&&requestId!=null)entry.requestSignals.set(requestId,aborted);
  res.on('close',()=>{
   if(!res.writableFinished)aborted.abort();
   if(entry.requestSignals.get(requestId)===aborted)entry.requestSignals.delete(requestId);
  });
  try{await entry.transport.handleRequest(req,res,req.body);if(!entry.id)await entry.server.close();}catch{
   if(!entry.id)await entry.server.close().catch(()=>{});
   if(!res.headersSent)res.status(500).json({jsonrpc:'2.0',id:req.body?.id??null,error:{code:-32603,message:'MCP request failed'}});
  }
 });
 // Bound idle protocol sessions; never expire an in-flight tool call.
 const sweep=setInterval(()=>{
  for(const entry of sessions.values())if(!entry.requestSignals.size&&Date.now()-entry.lastUsed>3600000){
   entry.abort.abort();sessions.delete(entry.id);void entry.server.close().catch(()=>{});
  }
 },60000);sweep.unref();
 const http=await new Promise((resolve,reject)=>{const s=app.listen(config.port,config.host,()=>resolve(s));s.on('error',reject);});
 // Tool deadlines are explicit. Do not let an HTTP socket timeout impersonate a Claude timeout.
 http.timeout=0;
 return {port:http.address().port,close:async()=>{
  clearInterval(sweep);shutdown.abort();await jobs.close();
  for(const entry of sessions.values()){entry.abort.abort();await entry.transport.close().catch(()=>{});await entry.server.close().catch(()=>{});}
  http.closeAllConnections();await new Promise(r=>http.close(r));
 }};
}
