import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAsk, resolveCwd, childEnvironment, RunnerError } from '../src/runner.mjs';

async function fixture(t, code) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-mcp-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'claude');
  await writeFile(file, '#!/usr/bin/env node\n'+code, {mode:0o755});
  return {root, config:{root, command:file, timeoutMs:1000, maxOutput:10000, permissionMode:'acceptEdits', allowedTools:[], env:{...process.env,ANTHROPIC_AUTH_TOKEN:'private-test-token'}}};
}

test('stdin prompt and arbitrary model/cwd reach CLI without shell interpretation', async t => {
  const {root,config}=await fixture(t, `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({stdin:s,args:process.argv.slice(2),cwd:process.cwd(),token:!!process.env.ANTHROPIC_AUTH_TOKEN,retries:process.env.CLAUDE_CODE_MAX_RETRIES})})));`);
  const answer=JSON.parse((await runAsk({prompt:'echo $(danger); newline\ntext',model:'gateway/custom-model'},config)).answer);
  assert.equal(answer.stdin,'echo $(danger); newline\ntext');
  assert.equal(answer.cwd,root);assert.equal(answer.token,true);assert.equal(answer.retries,'0');
  assert.ok(answer.args.includes('--model=gateway/custom-model'));
  assert.ok(answer.args.includes('--permission-prompts'));assert.ok(answer.args.includes('--no-session-persistence'));
});
test('relative cwd resolves from Developer root and missing paths fail',async t=>{
  const {root}=await fixture(t,'');
  assert.equal(await resolveCwd('.',root),root);
  assert.equal(await resolveCwd(root,root),root);
  await assert.rejects(resolveCwd('missing',root),e=>e.code==='invalid_cwd');
  await assert.rejects(resolveCwd(tmpdir(),root),e=>e.code==='invalid_cwd');
});
test('CLI JSON error and permission denial never become success', async t => {
  for(const json of [{type:'result',subtype:'error_during_execution',is_error:true,errors:['private-test-token denied']},{type:'result',subtype:'success',is_error:false,result:'ok',permission_denials:[{tool_name:'Bash'}]}]){
    const {config}=await fixture(t,`console.log(${JSON.stringify(JSON.stringify(json))})`);
    await assert.rejects(runAsk({prompt:'test'},config),e=>e instanceof RunnerError && !e.message.includes('private-test-token'));
  }
});
test('permission_denied reports unique redacted tool names and context, never inputs or partial answer',async t=>{
  const json={type:'result',subtype:'success',is_error:false,result:'PARTIAL-ANSWER',permission_denials:[
    {tool_name:'Bash',tool_input:{command:'hostname SECRET-INPUT'}},{tool_name:'Bash',tool_input:{command:'git status'}},{tool_name:'private-test-token',tool_input:{}}]};
  const {root,config}=await fixture(t,`console.log(${JSON.stringify(JSON.stringify(json))})`);
  config.allowedTools=['Read','private-test-token'];
  await assert.rejects(runAsk({prompt:'test'},config),e=>{
    assert.equal(e.code,'permission_denied');
    assert.deepEqual(e.details,{tool_names:['Bash','[redacted]'],permission_mode:'acceptEdits',allowed_tools:['Read','[redacted]'],cwd:root,execution_started:true});
    const text=JSON.stringify(e.details)+e.message;
    for(const s of ['SECRET-INPUT','git status','PARTIAL-ANSWER','private-test-token'])assert.ok(!text.includes(s),s);
    return true;
  });
});
test('canonical mounted roots are passed as --add-dir, including spaces and symlinks',async t=>{
  const {root,config}=await fixture(t,`console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify(process.argv.slice(2))}))`);
  const {mkdir,symlink}=await import('node:fs/promises');
  const spaced=join(root,'with space');await mkdir(spaced);
  const link=join(root,'link');await symlink(spaced,link);
  config.mountedRoots=[root,link,spaced];
  const args=JSON.parse((await runAsk({prompt:'x'},config)).answer);
  assert.deepEqual(args.filter(a=>a.startsWith('--add-dir=')),[`--add-dir=${spaced}`]);
});
test('missing configured mounted root fails before spawn',async t=>{
  const {root,config}=await fixture(t,`require('fs').writeFileSync('spawned','1')`);
  config.mountedRoots=[root,join(root,'missing-root')];
  await assert.rejects(runAsk({prompt:'x'},config),e=>e.code==='invalid_cwd'&&e.details.reason==='mounted_root_unavailable'&&e.details.execution_started===false);
  await assert.rejects(readFile(join(root,'spawned')),e=>e.code==='ENOENT');
});
test('invalid JSON, output limit and nonzero exit fail',async t=>{
  for(const code of ['console.log("not JSON")','process.stdout.write("x".repeat(20000))','console.log(JSON.stringify({result:"looks okay",is_error:false,type:"result",subtype:"success"}));process.exitCode=3']){
    const {config}=await fixture(t,code);await assert.rejects(runAsk({prompt:'test'},config));
  }
});
test('timeout and cancellation terminate process groups, do not retry',async t=>{
  const {root,config}=await fixture(t,`const fs=require('fs');fs.appendFileSync('runs','x');setInterval(()=>{},1000);`);
  await assert.rejects(runAsk({prompt:'test',timeout_ms:80},config),e=>e.code==='timeout');
  assert.equal(await readFile(join(root,'runs'),'utf8'),'x');
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),80);
  await assert.rejects(runAsk({prompt:'test'},config,controller.signal),e=>e.code==='cancelled');clearTimeout(timer);
  assert.equal(await readFile(join(root,'runs'),'utf8'),'xx');
});
test('gateway environment supports bearer, API key and Cloudflare headers',()=>{
  const env=childEnvironment({ANTHROPIC_API_KEY:'key',ANTHROPIC_AUTH_TOKEN:'token',CF_ACCESS_CLIENT_ID:'id',CF_ACCESS_CLIENT_SECRET:'secret',CLAUDE_CODE_RETRY_WATCHDOG:'1'});
  assert.equal(env.ANTHROPIC_API_KEY,'key');assert.equal(env.ANTHROPIC_AUTH_TOKEN,'token');
  assert.match(env.ANTHROPIC_CUSTOM_HEADERS,/CF-Access-Client-Secret: secret/);
  assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG,'0');
});

test('hidden non-streaming fallback is disabled even when the parent enables it',()=>{
  for(const value of [undefined, '', '0', 'false']){
    const env=childEnvironment({CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:value,CLAUDECODE:'parent'});
    assert.equal(env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK,'1');
    assert.equal(env.CLAUDECODE,undefined);
  }
});

test('fallback policy reaches the CLI without changing conversation arguments',async context=>{
  const {config}=await fixture(context,`console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({fallback:process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK,args:process.argv.slice(2)})}));`);
  const answer=JSON.parse((await runAsk({prompt:'synthetic'},config)).answer);
  assert.equal(answer.fallback,'1');
  assert.ok(answer.args.includes('--no-session-persistence'));
  assert.ok(!answer.args.some(value=>/resume|compact|session-id/.test(value)));
});

test('completed parent cannot leave same-group background processes alive',async t=>{
 const {root,config}=await fixture(t, `const fs=require('fs'),cp=require('child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('background-pid',String(c.pid));c.unref();console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));`);
 await runAsk({prompt:'test'},config);const pid=Number(await readFile(join(root,'background-pid'),'utf8'));
 t.after(()=>{try{process.kill(pid,'SIGKILL')}catch{}});
 await new Promise(r=>setTimeout(r,50));
 assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('malformed CLI errors JSON is handled without crashing MCP process',async t=>{
 const {config}=await fixture(t,'console.log(JSON.stringify({type:"result",subtype:"error_during_execution",is_error:true,errors:"unexpected-string"}));');
 const {spawnSync}=await import('node:child_process');
 const safe={...config,env:{PATH:process.env.PATH}};
 const program=`import {runAsk} from ${JSON.stringify(new URL('../src/runner.mjs',import.meta.url).href)};runAsk({prompt:'test'},${JSON.stringify(safe)}).then(()=>process.exit(3),e=>{if(e.code!=='invalid_json')process.exit(4);console.log('handled')});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:2000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/handled/);
});

test('non-string error result cannot crash result formatting',async t=>{
 const {config}=await fixture(t,'console.log(JSON.stringify({type:"result",subtype:"error",is_error:true,result:{toString:1}}));');
 const {spawnSync}=await import('node:child_process');const safe={...config,env:{PATH:process.env.PATH}};
 const program=`import {runAsk} from ${JSON.stringify(new URL('../src/runner.mjs',import.meta.url).href)};runAsk({prompt:'test'},${JSON.stringify(safe)}).then(()=>process.exit(3),e=>{if(e.code!=='invalid_json')process.exit(4);console.log('handled')});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:2000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/handled/);
});

 test('configured mounted root that is a file fails before spawn',async t=>{
  const {root,config}=await fixture(t,`require('fs').writeFileSync('spawned','1')`);
  const file=join(root,'not-a-directory');await writeFile(file,'text');
  config.mountedRoots=[root,file];
  await assert.rejects(runAsk({prompt:'x'},config),e=>e.code==='invalid_cwd'&&e.details.reason==='mounted_root_unavailable'&&e.details.execution_started===false);
  await assert.rejects(readFile(join(root,'spawned')),e=>e.code==='ENOENT');
 });
