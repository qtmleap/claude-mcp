import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {loadConfig} from '../src/config.mjs';
test('native default workspace follows the process working directory',()=>{
 const config=loadConfig({});assert.equal(config.root,process.cwd());assert.deepEqual(config.mountedRoots,[process.cwd()]);
});
test('explicit workspace remains configurable independently of platform',()=>{
 const config=loadConfig({CLAUDE_MCP_WORKSPACE:'project'});assert.equal(config.root,resolve('project'));
});
