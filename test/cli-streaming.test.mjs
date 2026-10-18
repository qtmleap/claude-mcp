import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAsk } from '../src/runner.mjs';

const command=process.env.CLAUDE_MCP_TEST_CLI;
const model='claude-sonnet-5-5';
const message={id:'msg_synthetic',type:'message',role:'assistant',model,content:[{type:'text',text:'Synthetic success.'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:4}};

async function fixture(context, healthy=false){
  const root=await realpath(await mkdtemp(join(tmpdir(),'claude-wire-')));
  context.after(()=>rm(root,{recursive:true,force:true}));
  const requests=[];
  const server=createServer(async(request,response)=>{
    const chunks=[];
    for await(const chunk of request)chunks.push(chunk);
    if(!request.url.startsWith('/v1/messages')){response.writeHead(404).end();return;}
    const body=JSON.parse(Buffer.concat(chunks).toString());
    requests.push({stream:body.stream,max_tokens:body.max_tokens});
    if(!body.stream){response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(message));return;}
    response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    const emit=value=>response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    emit({type:'message_start',message:{...message,content:[],stop_reason:null}});
    emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
    if(healthy){
      emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Synthetic success.'}});
      emit({type:'content_block_stop',index:0});
      emit({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:4}});
      emit({type:'message_stop'});
    }
    response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  context.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const env={PATH:process.env.PATH,HOME:root,CLAUDE_CONFIG_DIR:root,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_AUTH_TOKEN:'synthetic-only',CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_RETRY_WATCHDOG:'0',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
  return {requests,root,env,config:{root,command,env,maxOutput:32000,timeoutMs:10000,permissionMode:'acceptEdits',allowedTools:[],streamDiagnostics:true}};
}

test('installed CLI does not replay a broken stream as a non-streaming request',{skip:!command,timeout:30000},async context=>{
  assert.match(execFileSync(command,['--version'],{encoding:'utf8',timeout:3000}),/^2\.1\.289 /);
  await context.test('control reproduces the hidden fallback with retries zero',async childContext=>{
    const {root,env,requests}=await fixture(childContext);
    const child=spawn(command,['-p','--bare','--model',model,'--output-format','json','--no-session-persistence','--no-chrome','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools',''],{cwd:root,env,detached:process.platform!=='win32',stdio:['pipe','ignore','ignore']});
    const stop=()=>{try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(stop,10000);
    childContext.after(()=>{clearTimeout(timer);stop();});
    child.stdin.on('error',()=>{});
    child.stdin.end('Reply with one short sentence. Synthetic protocol test only.');
    const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    assert.equal(exit,0);
    assert.deepEqual(requests.map(request=>request.stream),[true,false]);
  });
  await context.test('wrapper fails once and preserves the original stream error',async childContext=>{
    const {config,requests}=await fixture(childContext);
    await assert.rejects(runAsk({prompt:'Synthetic protocol test only.',model},config,undefined,{stream:true}),error=>{
      assert.equal(error.code,'claude_exit');
      assert.match(error.details.cli_diagnostic.text,/^API Error: Connection to the API was lost \(StreamTruncated\)/);
      assert.equal(error.details.cli_diagnostic.http_status,undefined);
      assert.equal(error.details.stream_diagnostic.first_error,'StreamTruncated');
      return true;
    });
    assert.deepEqual(requests.map(request=>request.stream),[true]);
    assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(config.root+'/debug').catch(()=>[])),[]);
  });
  await context.test('healthy streaming remains successful',async childContext=>{
    const {config,requests}=await fixture(childContext,true);
    const result=await runAsk({prompt:'Synthetic protocol test only.',model},config,undefined,{stream:true});
    assert.equal(result.answer,'Synthetic success.');
    assert.deepEqual(requests.map(request=>request.stream),[true]);
  });
});

const processStartTicks = pid => readFile(`/proc/${pid}/stat`, 'utf8').then(text => text.slice(text.lastIndexOf(')') + 2).split(' ')[19], () => undefined);

const timerScript = `const fs = require('fs');
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
fs.writeFileSync(process.argv[2] + '.tmp', JSON.stringify({ pid: process.pid, startTicks }));
fs.renameSync(process.argv[2] + '.tmp', process.argv[2]);
setTimeout(() => {}, 12000);
`;

async function backgroundBashFixture(context) {
  const owned = { pid: undefined, startTicks: undefined };
  let record, script;
  const stopOwned = async () => {
    if (!record) return;
    const recorded = JSON.parse(await readFile(record, 'utf8').catch(() => 'null'));
    if (!recorded) return;
    Object.assign(owned, recorded);
    if (await processStartTicks(recorded.pid) !== recorded.startTicks) return;
    const commandLine = await readFile(`/proc/${recorded.pid}/cmdline`, 'utf8').catch(() => '');
    assert.ok(commandLine.split('\0').includes(script), 'owned timer identity must match before cleanup');
    try { process.kill(recorded.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await processStartTicks(recorded.pid) !== recorded.startTicks) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('owned timer did not exit after cleanup');
  };
  context.after(stopOwned);
  const base = await fixture(context);
  const unique = randomUUID();
  script = join(base.root, `background-timer-${unique}.cjs`);
  record = join(base.root, `background-timer-${unique}.json`);
  await writeFile(script, timerScript);
  const bashCommand = `exec ${process.execPath} ${script} ${record}`;
  const streams = [];
  const sse = (response, events) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const value of events) response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    response.end();
  };
  const turn = (block, delta, stopReason) => [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' }
  ];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (!request.url.startsWith('/v1/messages')) { response.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message)); return; }
    const toolResult = body.messages.some(entry => Array.isArray(entry.content) && entry.content.some(block => block.type === 'tool_result'));
    streams.push({ toolResult, tools: (body.tools ?? []).map(tool => tool.name) });
    if (!toolResult) {
      sse(response, turn({ type: 'tool_use', id: 'toolu_synthetic', name: 'Bash', input: {} },
        { type: 'input_json_delta', partial_json: JSON.stringify({ command: bashCommand, description: 'Synthetic background timer', run_in_background: true }) }, 'tool_use'));
      return;
    }
    sse(response, turn({ type: 'text', text: '' }, { type: 'text_delta', text: 'Synthetic success.' }, 'end_turn'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { ...base.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  return { config: { ...base.config, env, allowedTools: ['Bash'] }, streams, record, owned, stopOwned };
}

test('native background Bash shutdown completes as a natural zero exit',
  { skip: !command ? 'CLAUDE_MCP_TEST_CLI is not set' : process.platform !== 'linux' ? 'requires Linux /proc' : false, timeout: 60000 },
  async context => {
    const { config, streams, record, owned, stopOwned } = await backgroundBashFixture(context);
    const result = await runAsk({ prompt: 'Synthetic protocol test only.', model, timeout_ms: 20000 }, config, undefined, { stream: true });
    assert.equal(result.answer, 'Synthetic success.');
    assert.deepEqual(streams.map(stream => stream.toolResult), [false, true]);
    assert.ok(streams[0].tools.includes('Bash'));
    const recorded = JSON.parse(await readFile(record, 'utf8'));
    assert.match(String(recorded.pid), /^\d+$/);
    assert.match(recorded.startTicks, /^\d+$/);
    await stopOwned();
    assert.equal(owned.pid, recorded.pid);
    assert.notEqual(await processStartTicks(recorded.pid), recorded.startTicks);
  });
