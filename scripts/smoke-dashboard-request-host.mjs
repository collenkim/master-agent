// Real browser and dashboard API; isolated catalog, synthetic code-agent hello, no request runner or model calls.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setup } from '../tests/helpers.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { controlProbe } from '../packages/code-agent-adapter/pairing.mjs';
import { openBrowser } from './browser.mjs';

mkdirSync(resolve('.master-agent'), { recursive: true });
const artifacts = mkdtempSync(resolve('.master-agent/request-host-browser-')), cleanup = [];
const f = setup({ after(fn) { cleanup.push(fn); } });
const [both, single, legacy] = f.fixture.projects;
const ready = { ready: true, problems: [] };
const managed = patch => ({ selected: 'claude', source: 'default', installedHosts: ['claude', 'codex'], execution: { mode: 'auto' }, ready: true, problems: [],
  runSelection: { supported: true, modes: ['claude', 'codex', 'both'] }, hosts: { claude: ready, codex: ready }, ...patch });
const hello = managedHost => ({ project: { enabled: false }, pairing: { supported: true, version: 1, trustedControllers: ['dashboard'] }, managedHost });
const source = (project, managedHost) => f.store.put('interaction-source', { id: project.id, control: controlProbe(hello(managedHost)), error: null, checkedAt: new Date().toISOString() });
source(both, managed({ selected: 'codex', source: 'execution-main', execution: { mode: 'both', main: 'codex' } }));
source(single, managed({ hosts: { claude: ready, codex: { ready: false, problems: [{ code: 'codex-project-untrusted', message: '<b>Codex 프로젝트 신뢰 필요</b>' }] } } }));
const old = managed(); delete old.runSelection; delete old.hosts; source(legacy, old);
const launched = [];
let dashboard, browser;
try {
  dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false, launch: async (store, id) => { launched.push(id); return store.need('target-request', id); } });
  browser = await openBrowser(dashboard.url, artifacts);
  const { send, evaluate, waitFor, errors } = browser;
  const value = id => evaluate(`document.getElementById(${JSON.stringify(id)}).value`);
  const text = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const hidden = id => evaluate(`document.getElementById(${JSON.stringify(id)}).hidden`);
  const select = (id, v) => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(v)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change'))`);
  const screenshot = async name => (await evaluate(`document.querySelector(".host-choice").scrollIntoView({block:"start"})`), writeFileSync(join(artifacts, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64')));
  await waitFor(`document.querySelectorAll('.project-request').length === 3`);
  assert.equal(await evaluate('Boolean(document.getElementById("request-provider"))'), false, '계획·판단 담당 선택은 없다');
  const cards = await evaluate(`document.getElementById('projects').textContent`);
  assert.equal(cards.split('요청별 host 선택: claude · codex · both').length - 1, 2, cards);
  assert.match(cards, /요청별 host 선택: 지원하지 않음/);

  // Group request: one choice for all projects; mixed project settings start from Claude alone.
  await evaluate(`document.getElementById('new-request').click()`);
  assert.equal(await value('request-type'), 'group');
  assert.equal(await value('request-host'), 'claude'); assert.equal(await hidden('request-main-field'), true);
  assert.match(await text('request-host-help'), /Claude가 혼자 맡습니다/);
  const groupRows = await text('request-host-projects');
  for (const p of [both, single, legacy]) assert.ok(groupRows.includes(p.name), groupRows);
  assert.match(groupRows, /요청별 host 선택 미지원/);
  await select('request-host', 'both');
  assert.equal(await hidden('request-main-field'), false);
  assert.match(await text('request-host-help'), /Claude가 개발과 master 계획·판단을 맡고 Codex가 계획·코드 리뷰와 판단을 교차 검증/);
  await select('request-main', 'codex');
  assert.match(await text('request-host-help'), /Codex가 개발과 master 계획·판단을 맡고 Claude가/);
  assert.match(await text('request-host-projects'), /Codex 준비 안 됨: <b>Codex 프로젝트 신뢰 필요<\/b>/, '문제 문구는 글자로만 보인다');
  assert.equal(await evaluate(`Boolean(document.querySelector('#request-host-projects b'))`), false);
  await screenshot('group-both-codex.png');

  // Project request: the project's own execution choice is the starting value.
  await select('request-type', 'project');
  await select('request-target', both.id);
  assert.equal(await value('request-host'), 'both'); assert.equal(await value('request-main'), 'codex'); assert.equal(await hidden('request-main-field'), false);
  assert.match(await text('request-host-projects'), /선택 가능/);
  await select('request-target', single.id);
  assert.equal(await value('request-host'), 'claude'); assert.equal(await hidden('request-main-field'), true);
  assert.match(await text('request-host-projects'), /선택 가능/);
  await select('request-host', 'codex');
  assert.match(await text('request-host-projects'), /Codex 준비 안 됨/);

  // Submit Claude-main cross verification and see it on the request card.
  await select('request-target', both.id); await select('request-host', 'both'); await select('request-main', 'claude');
  await evaluate(`document.getElementById('request-goal').value='host 선택 확인'; document.getElementById('request-criteria').value='선택 기록'`);
  for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 800 });
    assert.equal(await evaluate(`document.getElementById('request-dialog').scrollWidth <= document.getElementById('request-dialog').clientWidth`), true, `dialog fits ${width}`);
    await screenshot(`request-host-${width}.png`);
  }
  await evaluate(`document.getElementById('request-form').requestSubmit(document.querySelector('#request-form button[type=submit]'))`);
  await waitFor(`!document.getElementById('request-dialog').open && document.getElementById('requests').textContent.includes('host 선택 확인')`);
  const saved = f.store.list('target-request').find(r => r.goal === 'host 선택 확인');
  assert.deepEqual(saved.execution, { mode: 'both', main: 'claude' }); assert.equal(saved.provider, 'claude'); assert.deepEqual(launched, [saved.id]);
  assert.match(await text('requests'), /host: Claude 주 · Codex 교차 검증/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, artifacts, checks: ['no-provider-select', 'card-run-selection', 'group-default-mixed', 'main-toggle', 'help-text', 'per-project-status', 'unsupported-code-agent',
    'problem-text-escaped', 'project-default-from-setting', 'submit-records-host', 'request-card-host', 'dialog-1440-390-320'] }));
} finally {
  await browser?.close();
  await dashboard?.close();
  for (const fn of cleanup.reverse()) fn();
}
