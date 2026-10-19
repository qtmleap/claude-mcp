import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAsk } from '../src/runner.mjs';
import { JobStore } from '../src/jobs.mjs';

const SECRET = 'private-diagnostic-token';
const CUSTOM_SECRET = 'private-custom-header-value';

async function fixture(context, result, { stderr = '', exitCode = 1, newline = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-failure-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, 'cli');
  const stdout = typeof result === 'string' ? result : JSON.stringify(result);
  await writeFile(command, '#!/usr/bin/env node\n' +
    `require('fs').appendFileSync('runs','x');process.stdout.write(${JSON.stringify(stdout + (newline ? '\n' : ''))});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=${exitCode};`, { mode: 0o755 });
  return { root, command, env: { PATH: process.env.PATH, ANTHROPIC_AUTH_TOKEN: SECRET,
    ANTHROPIC_CUSTOM_HEADERS: `X-Private-Key: ${CUSTOM_SECRET}` }, maxOutput: 32000,
    permissionMode: 'acceptEdits', allowedTools: [], stateDir: join(root, 'state') };
}

for (const stream of [false, true]) {
  test(`nonzero ${stream ? 'stream-json' : 'json'} preserves explicit upstream error without retry`, async context => {
    const config = await fixture(context, { type: 'result', subtype: 'error_during_execution', is_error: true,
      errors: [`API Error: 524 origin_response_timeout ${SECRET}`] }, { newline: false });
    await assert.rejects(runAsk({ prompt: 'test' }, config, undefined, { stream }), error => {
      assert.equal(error.code, 'claude_exit');
      assert.match(error.message, /Claude exited with code 1.*API Error: 524/);
      assert.deepEqual(error.details.cli_diagnostic, { source: 'result',
        text: 'API Error: 524 origin_response_timeout [redacted]', http_status: 524 });
      assert.ok(!JSON.stringify(error).includes(SECRET));
      return true;
    });
    assert.equal(await readFile(join(config.root, 'runs'), 'utf8'), 'x');
  });

  test(`nonzero ${stream ? 'stream-json' : 'json'} uses only bounded redacted failure text`, async context => {
    const config = await fixture(context, { type: 'result', subtype: 'error_during_execution', is_error: true,
      errors: [], result: `API Error: 503\n\u001b[31m${SECRET} ${CUSTOM_SECRET} https://user:private-url-password@example.test/private-path?private-query=value#private-fragment ` + 'x'.repeat(900) + SECRET + 'tail'.repeat(1000),
      tool_input: 'PRIVATE TOOL INPUT', permission_denials: [], thinking: 'PRIVATE THINKING' });
    await assert.rejects(runAsk({ prompt: 'test' }, config, undefined, { stream }), error => {
      const diagnostic = error.details.cli_diagnostic;
      assert.equal(diagnostic.http_status, 503);
      assert.equal(diagnostic.text.length, 1000);
      assert.equal(diagnostic.truncated, true);
      assert.match(diagnostic.text, /https:\/\/example.test/);
      assert.doesNotMatch(JSON.stringify(error), /private-|PRIVATE|\u001b|\\n/);
      return true;
    });
  });

  test(`nonzero ${stream ? 'stream-json' : 'json'} retains generic exit on invalid or successful output`, async context => {
    for (const result of ['not JSON', '', { type: 'assistant', is_error: true, result: 'DO NOT COPY' },
      { type: 'result', subtype: 'success', is_error: false, result: 'DO NOT COPY API Error: 524' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: {} },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: 'DO NOT COPY' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['valid', {}] },
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'DO NOT COPY', permission_denials: [{ tool_input: 'DO NOT COPY' }] }]) {
      const config = await fixture(context, result, { stderr: 'stderr failure' });
      await assert.rejects(runAsk({ prompt: 'test' }, config, undefined, { stream }), error => {
        assert.equal(error.code, 'claude_exit');
        assert.equal(error.message, 'Claude exited with code 1: stderr failure');
        assert.equal(error.details, undefined);
        return true;
      });
    }
  });

  test(`successful ${stream ? 'stream-json' : 'json'} mentioning API errors is not classified`, async context => {
    const config = await fixture(context, { type: 'result', subtype: 'success', is_error: false, result: 'API Error: 524 is an example' }, { exitCode: 0 });
    const result = await runAsk({ prompt: 'test' }, config, undefined, { stream });
    assert.equal(result.answer, 'API Error: 524 is an example');
    assert.equal(result.cli_diagnostic, undefined);
  });
}

test('unknown terminal failure has text but no guessed HTTP status', async context => {
  const config = await fixture(context, { type: 'result', subtype: 'error_during_execution', is_error: true,
    errors: ['Permission failed; documentation mentions API Error: 524'] });
  await assert.rejects(runAsk({ prompt: 'test' }, config), error => {
    assert.equal(error.details.cli_diagnostic.http_status, undefined);
    assert.match(error.message, /Permission failed/);
    return true;
  });
});

test('malformed terminal subtype cannot crash the runner callback', async context => {
  const config = await fixture(context, { type: 'result', subtype: { toString: 1 }, is_error: false, result: 'DO NOT COPY' });
  const program = `import {runAsk} from ${JSON.stringify(new URL('../src/runner.mjs', import.meta.url).href)};await runAsk({prompt:'test'},${JSON.stringify(config)}).then(()=>process.exit(3),error=>{if(error.code!=='claude_exit'||error.details)process.exit(4);console.log('handled');});`;
  const processResult = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 2000 });
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.match(processResult.stdout, /handled/);
});

test('redaction precedes the diagnostic length boundary', async context => {
  const config = await fixture(context, { type: 'result', is_error: true,
    result: 'x'.repeat(995) + SECRET });
  await assert.rejects(runAsk({ prompt: 'test' }, config), error => {
    assert.equal(error.details.cli_diagnostic.text, 'x'.repeat(995) + '[reda');
    assert.equal(error.details.cli_diagnostic.truncated, true);
    return true;
  });
});

test('CLI diagnostic survives failed-job polling and restart without execution replay', async context => {
  const config = await fixture(context, { type: 'result', subtype: 'error_during_execution', is_error: true,
    errors: [`API Error: 524 ${SECRET}`], tool_input: 'PRIVATE TOOL INPUT', thinking: 'PRIVATE THINKING' });
  const store = new JobStore(config);
  await store.ready();
  context.after(() => store.close());
  const { job_id } = await store.start({ prompt: 'PROMPT NOT PERSISTED' });
  const failed = await store.get(job_id, 2000);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.details.cli_diagnostic.http_status, 524);
  const persisted = await readFile(join(config.stateDir, `${job_id}.json`), 'utf8');
  assert.doesNotMatch(persisted, /private-diagnostic-token|PRIVATE|PROMPT NOT PERSISTED/);
  await store.close();
  const recovered = new JobStore(config);
  await recovered.ready();
  context.after(() => recovered.close());
  const restored = await recovered.get(job_id);
  assert.equal(restored.status, 'failed');
  assert.deepEqual(restored.error, failed.error);
  assert.equal(await readFile(join(config.root, 'runs'), 'utf8'), 'x');
});
