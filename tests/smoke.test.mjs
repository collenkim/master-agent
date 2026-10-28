import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { temporary } from './helpers.mjs';
import { fileURLToPath } from 'node:url';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('B2: smoke 목록은 빈 작업 폴더에서 CLI·브라우저·모델 없이 조회한다', t => {
  const root = temporary(t), runner = fileURLToPath(new URL('../scripts/smoke.mjs', import.meta.url));
  for (const group of ['browser', 'code-agent', 'model']) {
    const names = JSON.parse(execFileSync(process.execPath, [runner, group, '--list'], {
      cwd: root, windowsHide: true, shell: false, encoding: 'utf8',
      env: { ...process.env, CODE_AGENT_CLI: 'missing-cli', CLAUDE_CLI: '', CHROME_PATH: 'missing-browser' },
    }));
    assert.ok(names.length >= 3);
    assert.ok(names.every(name => name.endsWith('.mjs')));
    if (group === 'browser') assert.ok(names.every(name => name.startsWith('smoke-dashboard-')));
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
