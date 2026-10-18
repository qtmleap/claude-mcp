import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamDiagnostics } from '../src/stream-diagnostics.mjs';

test('code delimiters and line boundaries are independent of stderr chunking',()=>{
  for(const code of ['StreamTruncated','StreamTruncatedOther']){
    const line=`2026-10-18T20:28:42.031Z [ERROR] Connection error details: code=${code}, message=PRIVATE\n`;
    for(let index=0;index<=line.length;index++){
      const diagnostics=new StreamDiagnostics();
      diagnostics.stderr(line.slice(0,index));diagnostics.stderr(line.slice(index));
      assert.equal(diagnostics.snapshot().first_error,code==='StreamTruncated'?'StreamTruncated':null,`split ${index}: ${code}`);
    }
  }
  const diagnostics=new StreamDiagnostics();
  diagnostics.stderr('x'.repeat(256)+'2026-10-18T20:28:42.031Z [ERROR] Connection error details: code=StreamTruncated');
  diagnostics.stderr(', message=PRIVATE\n');
  assert.equal(diagnostics.snapshot().first_error,null);
});

test('stream diagnostics keep the first classified native failure across split chunks', () => {
  const diagnostics = new StreamDiagnostics();
  diagnostics.stderr('2026-10-18T20:28:42.031Z [ERROR] Connection error details: code=StreamTr');
  diagnostics.stderr('uncated, message=PRIVATE MESSAGE\n');
  diagnostics.stderr('2026-10-18T20:28:43.031Z [ERROR] Connection error details: code=ECONNRESET, message=PRIVATE\n');
  assert.equal(diagnostics.snapshot().first_error, 'StreamTruncated');
  assert.equal(typeof diagnostics.snapshot().first_error_elapsed_ms, 'number');
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE|message|20:28/);
});

test('diagnostics reject unknown error codes and content masquerading as debug fields', () => {
  const diagnostics = new StreamDiagnostics();
  diagnostics.stderr('PRIVATE StreamTruncated\n2026-10-18T20:28:42.031Z [ERROR] Connection error details: code=PRIVATE, message=ECONNRESET\n');
  diagnostics.event({ type: 'PRIVATE', event: { type: 'PRIVATE', delta: { type: 'PRIVATE' } } });
  diagnostics.event({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'PRIVATE THINKING' }, input: 'PRIVATE INPUT' } });
  const result = diagnostics.snapshot();
  assert.equal(result.first_error, null);
  assert.equal(result.last_event, 'thinking_delta');
  assert.deepEqual(result.event_counts, { thinking_delta: 1 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('oversized raw lines cannot make diagnostic memory or output grow unbounded', () => {
  const diagnostics = new StreamDiagnostics();
  diagnostics.stderr('PRIVATE'.repeat(1000000));
  diagnostics.stderr('\n2026-10-18T20:28:42.031Z [ERROR] Connection error details: code=StreamSuspended, message=PRIVATE\n');
  for (let index = 0; index < 10000; index++) diagnostics.event({ type: 'stream_event', event: { type: 'message_stop', extra: 'PRIVATE' } });
  const result = diagnostics.snapshot();
  assert.equal(result.first_error, 'StreamSuspended');
  assert.deepEqual(result.event_counts, { message_stop: 10000 });
  assert.ok(JSON.stringify(result).length < 1000);
});
