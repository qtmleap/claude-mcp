import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {assertVersionAvailable} from '../scripts/guard-ghcr-version.mjs';

const TOKEN='ghs_secret_token_value';
const REGISTRY_BODY='registry-body-secret';
const base={repository:'qtmleap/claude-mcp',version:'0.1.1',actor:'octo-bot',token:TOKEN};
const basic='Basic '+Buffer.from(`octo-bot:${TOKEN}`).toString('base64');

// Minimal GHCR fixture: the token endpoint and the manifest HEAD endpoint return configured statuses.
function registry({tokenStatus=200,tokenBody={token:'pull-token'},manifestStatus=404,throwOn}={}){
 const calls=[];
 const fetchImpl=async(url,init={})=>{
  const u=new URL(url);const headers=new Headers(init.headers);
  calls.push({url:u,method:init.method??'GET',authorization:headers.get('authorization')});
  if(throwOn===u.pathname)throw new Error(`network down ${TOKEN}`);
  if(u.pathname==='/token')return new Response(tokenStatus===200?JSON.stringify(tokenBody):REGISTRY_BODY,{status:tokenStatus});
  if(u.pathname==='/v2/qtmleap/claude-mcp/manifests/0.1.1')return new Response(manifestStatus===200?null:REGISTRY_BODY,{status:manifestStatus});
  return new Response(REGISTRY_BODY,{status:500});
 };
 return {fetchImpl,calls};
}
const rejectsSafely=async(promise,pattern)=>{
 await assert.rejects(promise,error=>{
  assert.match(error.message,pattern);
  assert.ok(!error.message.includes(TOKEN)&&!error.message.includes('pull-token')&&!error.message.includes(REGISTRY_BODY),'error must not leak credentials or response bodies');
  return true;
 });
};

test('a 404 for the version tag allows the first publish, using only HTTPS ghcr.io with Basic then Bearer auth',async()=>{
 const {fetchImpl,calls}=registry();
 await assertVersionAvailable({...base,fetchImpl});
 assert.ok(calls.length>=2);
 for(const c of calls){assert.equal(c.url.protocol,'https:');assert.equal(c.url.host,'ghcr.io');}
 const token=calls.find(c=>c.url.pathname==='/token');
 assert.equal(token.authorization,basic);
 assert.equal(token.url.searchParams.get('scope'),'repository:qtmleap/claude-mcp:pull');
 const manifest=calls.find(c=>c.url.pathname.includes('/manifests/'));
 assert.equal(manifest.method,'HEAD');
 assert.equal(manifest.authorization,'Bearer pull-token');
});

test('an existing version tag (200) is rejected, never overwritten',async()=>{
 const {fetchImpl}=registry({manifestStatus:200});
 await rejectsSafely(assertVersionAvailable({...base,fetchImpl}),/already exists/i);
});

for(const status of [401,403,429,500,503]){
 test(`manifest status ${status} fails closed instead of being read as absence`,async()=>{
  const {fetchImpl}=registry({manifestStatus:status});
  await rejectsSafely(assertVersionAvailable({...base,fetchImpl}),new RegExp(String(status)));
 });
 test(`token endpoint status ${status} fails closed before any manifest lookup`,async()=>{
  const {fetchImpl,calls}=registry({tokenStatus:status});
  await rejectsSafely(assertVersionAvailable({...base,fetchImpl}),new RegExp(String(status)));
  assert.ok(!calls.some(c=>c.url.pathname.includes('/manifests/')));
 });
}

test('a token response without a token fails closed',async()=>{
 for(const tokenBody of [{},{token:''},{token:5},'not-object']){
  const {fetchImpl,calls}=registry({tokenBody});
  await rejectsSafely(assertVersionAvailable({...base,fetchImpl}),/token/i);
  assert.ok(!calls.some(c=>c.url.pathname.includes('/manifests/')));
 }
});

test('network errors fail closed without leaking the credential',async()=>{
 for(const throwOn of ['/token','/v2/qtmleap/claude-mcp/manifests/0.1.1']){
  const {fetchImpl}=registry({throwOn});
  await rejectsSafely(assertVersionAvailable({...base,fetchImpl}),/.+/);
 }
});

test('a missing or blank token or actor is rejected before any network request',async()=>{
 for(const patch of [{token:undefined},{token:''},{token:'  '},{actor:undefined},{actor:''}]){
  const {fetchImpl,calls}=registry();
  await rejectsSafely(assertVersionAvailable({...base,...patch,fetchImpl}),/token|actor/i);
  assert.equal(calls.length,0);
 }
});

test('invalid versions and repositories are rejected before credentials reach the network',async()=>{
 const versions=['latest','0.1','v0.1.1','0.1.1+build','01.1.1','0.1.1/../../x','0.1.1 ','','0.1.1\n'];
 const repositories=['QtmLeap/claude-mcp','qtmleap','qtmleap/claude-mcp/extra','../claude-mcp','qtmleap/claude mcp','ghcr.io/qtmleap/claude-mcp','qtmleap/claude-mcp?x=1',''];
 for(const version of versions){
  const {fetchImpl,calls}=registry();
  await rejectsSafely(assertVersionAvailable({...base,version,fetchImpl}),/version/i);
  assert.equal(calls.length,0,`version ${JSON.stringify(version)}`);
 }
 for(const repository of repositories){
  const {fetchImpl,calls}=registry();
  await rejectsSafely(assertVersionAvailable({...base,repository,fetchImpl}),/repository/i);
  assert.equal(calls.length,0,`repository ${JSON.stringify(repository)}`);
 }
});

test('accepts prerelease semver versions',async()=>{
 const calls=[];
 const fetchImpl=async(url,init={})=>{calls.push(url);return new Response(null,{status:new URL(url).pathname==='/token'?200:404});};
 // Token endpoint needs a body; wrap it.
 await assertVersionAvailable({...base,version:'1.2.3-rc.1',fetchImpl:async(url,init)=>new URL(url).pathname==='/token'?new Response(JSON.stringify({token:'t'})):fetchImpl(url,init)});
 assert.ok(calls.some(u=>String(u).endsWith('/manifests/1.2.3-rc.1')));
});

test('the command entrypoint exits nonzero without a token and prints no secrets',()=>{
 const env={PATH:process.env.PATH,GITHUB_REPOSITORY:'qtmleap/claude-mcp',VERSION:'0.1.1',GITHUB_ACTOR:'octo-bot'};
 const result=spawnSync(process.execPath,['scripts/guard-ghcr-version.mjs'],{env,encoding:'utf8',cwd:new URL('..',import.meta.url)});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/token/i);
});

test('the command entrypoint rejects an invalid version before any network use',()=>{
 const env={PATH:process.env.PATH,GITHUB_REPOSITORY:'qtmleap/claude-mcp',VERSION:'latest',GITHUB_ACTOR:'octo-bot',GITHUB_TOKEN:TOKEN};
 const result=spawnSync(process.execPath,['scripts/guard-ghcr-version.mjs'],{env,encoding:'utf8',cwd:new URL('..',import.meta.url)});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/version/i);
 assert.ok(!result.stdout.includes(TOKEN)&&!result.stderr.includes(TOKEN));
});
