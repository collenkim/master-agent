// Real code-agent, local Git upstream, npm build, dashboard API and browser; isolated stores and projects.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { runUpdateCli } from '../packages/dashboard/source-update.mjs';
import { openBrowser } from './browser.mjs';
import { createSmokeArtifacts } from './smoke-artifacts.mjs';

const original = resolve(process.env.CODE_AGENT_SOURCE ?? '../code-agent');
assert.ok(readFileSync(join(original, 'dist/agent/sourceUpdate.js'), 'utf8').includes('installOnlyConfirmed'), 'code-agent build must support install-only');
const artifacts = createSmokeArtifacts('updates-browser-');
const source = join(artifacts, 'source'), remote = join(artifacts, 'upstream.git'), publisher = join(artifacts, 'publisher');
mkdirSync(source);
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'template', 'scripts', 'dist']) cpSync(join(original, name), join(source, name), { recursive: true });
writeFileSync(join(source, '.gitignore'), 'node_modules/\ndist/\n');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = cwd => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.name=Update Smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'isolated source snapshot'); };
git(source, 'init', '-q', '-b', 'main'); commit(source);
git(artifacts, 'init', '-q', '--bare', remote); git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-u', 'origin', 'main');
git(artifacts, 'clone', '-q', remote, publisher); git(publisher, 'checkout', '-q', 'main');
writeFileSync(join(publisher, 'smoke-release.txt'), 'isolated upstream revision\n'); commit(publisher); git(publisher, 'push', 'origin', 'main');
const commitId = git(publisher, 'rev-parse', 'HEAD'), initialHead = git(source, 'rev-parse', 'HEAD');
// Environment settings belong only to this disposable test process and its child CLIs.
const agentHome = join(artifacts, 'agent-home'), releases = join(artifacts, 'releases');
Object.assign(process.env, { CODE_AGENT_HOME: agentHome, CODE_AGENT_RELEASE_HOME: releases, CLAUDECODE: '1', CODEX_SANDBOX: '1',
  npm_config_audit: 'false', npm_config_fund: 'false' });
const cliPath = join(source, 'dist/agent/cli.js'), dbPath = join(artifacts, 'master.db'), store = new Store(dbPath);
const catalog = new Engine(store).catalog, projects = [];
for (let index = 0; index < 2; index++) {
  const path = join(artifacts, `project-${index}`); mkdirSync(path); git(path, 'init', '-q');
  writeFileSync(join(path, 'README.md'), 'isolated project\n'); commit(path);
  const init = await runUpdateCli(cliPath, ['init', '--host', 'claude'], path); assert.equal(init.code, 0, init.stderr || init.stdout);
  catalog.register({ id: `update-${index}`, name: `Update project ${index}`, path, domains: ['fixture'], capabilities: ['code-agent:claude'], constraints: [], currentPlans: [], references: ['fixture'] });
  projects.push(path);
}
store.close();
let dashboard, browser;
try {
  dashboard = await startDashboard({ dbPath, port: 0, observe: false, cliPath });
  browser = await openBrowser(dashboard.url, artifacts);
  const { send, evaluate, waitFor, errors } = browser;
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const snapshot = async () => (await (await fetch(dashboard.url + '/api/overview')).json()).updates.batches[0];
  const shots = async dialog => {
    for (const width of [1440, 390, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 800 });
      assert.equal(await evaluate(`document.querySelector('#${dialog}').scrollWidth <= document.querySelector('#${dialog}').clientWidth`), true, `${dialog} fits ${width}`);
      writeFileSync(join(artifacts, `${dialog}-${width}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
  };
  await waitFor(`document.querySelectorAll('#projects article').length === 2`);
  await click('#preview-updates');
  await waitFor(`document.querySelector('#install-preview pre')`);
  assert.equal(await evaluate(`document.querySelector('#install-updates').disabled`), true);
  assert.match(await text('#install-preview'), /sha256:[a-f0-9]{64}/);
  assert.equal(existsSync(join(agentHome, 'update-confirmations.jsonl')), false);
  await shots('install-dialog'); await click('#install-confirm'); await click('#install-updates');
  // Real npm ci/build can take longer than the browser helper's usual 30-second wait.
  for (let n = 0; n < 600; n++) {
    const batch = await snapshot();
    if (batch?.state === 'awaiting-confirmation') break;
    assert.notEqual(batch?.state, 'failed', JSON.stringify(batch));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const installed = await snapshot(); assert.equal(installed.state, 'awaiting-confirmation');
  assert.equal(installed.release.commit, commitId);
  for (const path of projects) {
    const view = await runUpdateCli(cliPath, ['version', '--json'], path);
    assert.notEqual(JSON.parse(view.stdout).project.applied, installed.release.id, 'installation must not apply');
  }
  // Waiting for a human survives server restart and requires a fresh application preview.
  await browser.close(); browser = undefined; await dashboard.close();
  dashboard = await startDashboard({ dbPath, port: 0, observe: false, cliPath });
  mkdirSync(join(artifacts, 'restarted'));
  browser = await openBrowser(dashboard.url, join(artifacts, 'restarted'));
  const b = browser;
  await b.waitFor(`document.querySelector('.preview-apply')`);
  await b.evaluate(`document.querySelector('.preview-apply').click()`);
  await b.waitFor(`document.querySelectorAll('#update-preview section').length === 2`);
  assert.equal(await b.evaluate(`document.querySelector('#apply-updates').disabled`), true);
  const records = new Store(dbPath); const batch = records.get('agent-update', installed.id); records.close();
  assert.equal(batch.state, 'awaiting-confirmation');
  for (const width of [1440, 390, 320]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 800 });
    assert.equal(await b.evaluate(`document.querySelector('#update-dialog').scrollWidth <= document.querySelector('#update-dialog').clientWidth`), true);
    writeFileSync(join(artifacts, `apply-dialog-${width}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  await b.evaluate(`document.querySelector('#update-confirm').click(); document.querySelector('#apply-updates').click()`);
  await b.waitFor(`!document.querySelector('#update-dialog').open`);
  await b.waitFor(`document.querySelector('#updates').textContent.includes('적용 및 버전 확인 완료') || document.querySelector('#updates').textContent.includes('적용 완료 · 출력')`);
  const applied = await snapshot(); assert.ok(['completed', 'needs-attention'].includes(applied.state), JSON.stringify(applied));
  assert.ok(applied.projects.every(p => ['completed', 'needs-attention'].includes(p.state)), JSON.stringify(applied));
  assert.ok(applied.projects.every(p => p.current === installed.release.id));
  const confirmations = readFileSync(join(agentHome, 'update-confirmations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(confirmations.map(c => c.action), ['install', 'release', 'release']);
  assert.ok(confirmations.every(c => c.createdBy.channel === 'dashboard'));
  assert.equal(git(source, 'rev-parse', 'HEAD'), initialHead);
  assert.equal(git(source, 'status', '--porcelain'), '');
  assert.deepEqual(errors, []); assert.deepEqual(b.errors, []);
  const result = { passed: true, artifacts, codeAgent: original, commit: commitId, release: installed.release.id,
    checks: ['real-install-only', 'isolated-git-upstream-npm-build', 'separate-confirmations', 'no-apply-before-confirmation', 'restart-awaiting-confirmation', 'per-project-shown-hash', 'version-release-match', 'host-markers-cleared', 'dialogs-1440-390-320', 'source-preserved'] };
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser?.close(); await dashboard?.close(); }
