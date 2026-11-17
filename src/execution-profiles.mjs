import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {z} from 'zod';
import {RunnerError} from './errors.mjs';

const path=z.string().min(1).max(4096).refine(p=>p.startsWith('/')&&!/[\0\r\n]/.test(p));
const name=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const profile=z.object({
 backend:z.literal('docker'),container:name,user:z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/),
 root:path,roots:z.array(path).min(1).max(16),node:path,cli:path,
 expected_mounts:z.array(z.object({type:z.literal('bind'),source:path,target:path}).strict()).min(1).max(16),
 expected_labels:z.record(z.string().min(1).max(256),z.string().max(1024)).default({}),
 tools:z.array(z.object({name,command:path,args:z.array(z.string().max(256).refine(x=>!/[\0\r\n]/.test(x))).max(16)}).strict()).max(8).default([]),
 env:z.object({PATH:z.string().max(8192).optional(),LANG:z.string().max(128).optional(),LC_ALL:z.string().max(128).optional(),TZ:z.string().max(128).optional(),VIRTUAL_ENV:path.optional()}).strict().default({})
}).strict();
export function loadProfiles(file){
 if(!file)return {};
 try{
  const raw=readFileSync(file,'utf8');if(Buffer.byteLength(raw)>65536)throw new Error();
  const parsed=z.object({profiles:z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),profile)}).strict().parse(JSON.parse(raw));
  if(Object.hasOwn(parsed.profiles,'local')||Object.keys(parsed.profiles).length>32)throw new Error();
  for(const p of Object.values(parsed.profiles))if(!p.roots.some(r=>inside(posix.resolve(r),posix.resolve(p.root))))throw new Error();
  return parsed.profiles;
 }catch{throw new Error('Invalid execution profiles file (expected a bounded, secret-free operator registry)');}
}
export const inside=(root,path)=>{const r=posix.relative(root,path);return r===''||(r!=='..'&&!r.startsWith('../')&&!posix.isAbsolute(r));};
export function selectProfile(id,config){
 if(id===undefined||id==='local')return null;
 const p=config.executionProfiles?.[id];
 if(!p)throw new RunnerError('invalid_profile','Unknown execution_profile; call models for configured profile IDs',{execution_started:false});
 return p;
}
export function profilePolicy(id,p,config){return createHash('sha256').update(JSON.stringify(['docker-v1',id,p,config.permissionMode,config.allowedTools??[]])).digest('hex');}
export const targetCwd=(cwd,p)=>posix.resolve(p.root,cwd??p.root);
export const PROVIDER_KEYS=Object.freeze(['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_CUSTOM_HEADERS','CF_ACCESS_CLIENT_ID','CF_ACCESS_CLIENT_SECRET']);
export function dockerEnvironment(config,provider=false){
 const keys=['PATH','HOME','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH',...(provider?PROVIDER_KEYS:[])];
 return Object.fromEntries(keys.filter(k=>typeof config.env[k]==='string').map(k=>[k,config.env[k]]));
}
