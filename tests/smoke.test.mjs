import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { temporary } from './helpers.mjs';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test('B2: smoke 목록은 빈 작업 폴더에서 CLI·브라우저·모델 없이 조회한다', t => {
  const root = temporary(t), runner = fileURLToPath(new URL('../scripts/smoke.mjs', import.meta.url));
  for (const group of ['browser', 'code-agent', 'model']) {
    const names = JSON.parse(execFileSync(process.execPath, [runner, group, '--list'], {
      cwd: root, windowsHide: true, shell: false, encoding: 'utf8',
      env: { ...process.env, CODE_AGENT_CLI: 'missing-cli', CLAUDE_CLI: '', CHROME_PATH: 'missing-browser' },
    }));
    assert.ok(names.length >= 3);
    assert.ok(names.every(name => name.split(' ')[0].endsWith('.mjs')));
    if (group === 'browser') assert.ok(names.every(name => name.startsWith('smoke-dashboard-')));
    if (group === 'code-agent') assert.ok(names.includes('smoke-interactions-live.mjs --support-only'));
    if (group === 'model') assert.ok(names.includes('smoke-full-flow.mjs'));
  }
});

for (const [script, args] of [['smoke-full-flow.mjs', ['setup']], ['smoke-answer-context.mjs', ['--prepare-only']]]) {
  test(`C2: ${script}는 Claude 경로 누락·셸 래퍼를 산출물 생성 전에 거부한다`, t => {
    const root = temporary(t), runner = fileURLToPath(new URL(`../scripts/${script}`, import.meta.url));
    const result = spawnSync(process.execPath, [runner, ...args], {
      cwd: root, windowsHide: true, shell: false, encoding: 'utf8',
      env: { ...process.env, CLAUDE_CLI: '', CODE_AGENT_CLI: 'missing-cli', CODE_AGENT_DIST: 'missing-dist' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLAUDE_CLI.*실제 Claude CLI 경로/);
    assert.deepEqual(readdirSync(root), []);
    const wrapper = join(root, 'claude.cmd');
    writeFileSync(wrapper, '@echo must-not-run');
    const rejected = spawnSync(process.execPath, [runner, ...args], {
      cwd: root, windowsHide: true, shell: false, encoding: 'utf8',
      env: { ...process.env, CLAUDE_CLI: wrapper, CODE_AGENT_CLI: 'missing-cli', CODE_AGENT_DIST: 'missing-dist' },
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /셸 래퍼 대신 실행 파일 또는 JS 진입점/);
    assert.deepEqual(readdirSync(root), ['claude.cmd']);
  });
}


test('C3: support-only는 공개 hello만 조회하고 인증·시험 fixture를 요구하지 않는다', t => {
  const root = temporary(t), cli = join(root, 'hello-only.cjs'), log = join(root, 'calls.jsonl');
  const runner = fileURLToPath(new URL('../scripts/smoke-interactions-live.mjs', import.meta.url));
  writeFileSync(cli, `const fs = require('node:fs');
let input = '';
process.stdin.on('data', value => input += value);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  fs.appendFileSync(process.env.SMOKE_PROBE_LOG, JSON.stringify({ type: request.type, cwd: process.cwd() }) + '\\n');
  if (request.type !== 'hello') throw new Error('Only hello is allowed');
  console.log(JSON.stringify({ protocol: request.protocol, version: request.version, ok: true,
    result: { codeAgent: { version: 'fixture', stateSchema: 7 }, commands: ['hello'], interactions: { schemaVersion: 1 } } }));
});
`);
  const result = JSON.parse(execFileSync(process.execPath, [runner, cli, '--support-only'], {
    cwd: root, windowsHide: true, shell: false, encoding: 'utf8',
    env: { ...process.env, MASTER_AGENT_SMOKE_ROOT: join(root, 'artifacts'), SMOKE_PROBE_LOG: log, CLAUDE_CLI: 'must-not-run' },
  }));
  assert.equal(result.fullLifecycleTested, false);
  assert.deepEqual(result.probes.map(probe => probe.kind), ['empty', 'existing']);
  assert.ok(result.probes.every(probe => probe.ok));
  const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.type), ['hello', 'hello']);
  assert.ok(calls.every(call => call.cwd.startsWith(result.artifacts)));
  assert.ok(existsSync(join(result.artifacts, 'capabilities.json')));
});
