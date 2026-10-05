import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {loadConfig} from './config.mjs';
import {createMcp,startHttp} from './server.mjs';
import {redact} from './runner.mjs';

const argv=process.argv.slice(2);
const transport=argv[0]==='--transport'?argv[1]:'stdio';
if((argv.length&&!(argv.length===2&&argv[0]==='--transport'))||!['stdio','http'].includes(transport)){
 console.error('Usage: node src/main.mjs --transport stdio|http');process.exit(1);
}
const shutdown=new AbortController();let runtime;let closing=false;
async function close(){
 if(closing)return;closing=true;shutdown.abort();
 const force=setTimeout(()=>process.exit(1),5000);force.unref();
 await runtime?.close();clearTimeout(force);
}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
try{
 const config=loadConfig();
 if(transport==='stdio'){
  runtime=createMcp(config,shutdown.signal);await runtime.connect(new StdioServerTransport());
  process.stdin.on('end',()=>void close());
 }else{
  runtime=await startHttp(config,shutdown.signal);console.error(`claude-mcp listening on ${config.host}:${runtime.port}/mcp`);
 }
}catch(error){console.error(redact(error.message));await close();process.exitCode=1;}
