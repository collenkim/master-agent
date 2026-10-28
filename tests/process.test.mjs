import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';
import { execFileTree } from '../packages/runner/process.mjs';

test('process capture preserves UTF-8 output and nonzero exit status', async () => {
  assert.deepEqual(await execFileTree(process.execPath, ['-e', "process.stdout.write('한글');process.stderr.write('경고')"]),
    { stdout: '한글', stderr: '경고' });
  await assert.rejects(execFileTree(process.execPath, ['-e', "console.log('output');console.error('failure');process.exitCode=7"]),
    { code: 7, signal: null, stdout: 'output\n', stderr: 'failure\n' });
});

test('process start failures keep their error code and empty output', async t => {
  await assert.rejects(execFileTree(join(temporary(t), 'missing-executable'), []), { code: 'ENOENT', stdout: '', stderr: '' });
});

test('output overflow stops the process and bounds retained bytes', async () => {
  await assert.rejects(execFileTree(process.execPath, ['-e', "setInterval(()=>process.stdout.write('x'.repeat(4096)),10)"],
    { maxBuffer: 128, timeout: 5000 }), error => {
    assert.equal(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.equal(error.killed, true); assert.equal(Buffer.byteLength(error.stdout), 128);
    return true;
  });
});

test('spawn recording failures terminate the process and preserve the original error', async () => {
  const failure = new Error('record failed');
  await assert.rejects(execFileTree(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { timeout: 5000, onSpawn() { throw failure; } }), error => error === failure);
});
