import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { temporary } from './helpers.mjs';
import { fileURLToPath } from 'node:url';

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
