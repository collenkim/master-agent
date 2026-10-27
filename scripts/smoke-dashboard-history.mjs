// Real browser/API with an isolated catalog and synthetic status/event data; no development models.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setup } from '../tests/helpers.mjs';
import { recordObservation, createHistory } from '../packages/dashboard/history.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { openBrowser } from './browser.mjs';

const artifactRoot = resolve(process.env.MASTER_AGENT_SMOKE_ROOT ?? '.master-agent');
mkdirSync(artifactRoot, { recursive: true });
const artifacts = mkdtempSync(join(artifactRoot, 'stage-history-browser-')), cleanup = [];
const f = setup({ after(fn) { cleanup.push(fn); } });
const project = f.fixture.projects[0];
const unsafe = '<img src=x onerror="window.injected=true">';
const state = { observedAt: new Date().toISOString(), repo: { branch: 'fix/TASK-1' },
  work: { id: 'TASK-1', phase: 'implement', stage: 'test', task: 'module-a' }, attempt: { id: 'try-2', kind: 'test' },
  planning: { attempts: [{ task: unsafe, role: 'tester', phase: 'test', dispatchId: 'dispatch-1', status: 'completed' }] },
  verification: { rounds: 2, bound: { valid: true, problems: [] }, phases: { test: { round: 2, runs: 3, passed: true } } },
  review: { rounds: 1 }, resume: { code: 'ready', reasons: [] }, questions: { unanswered: [], unverified: [] }, consents: { open: [] }, unknown: [] };
for (let i = 0; i < 53; i++) f.store.transaction(() => recordObservation(f.store, project.id, { status: 'observed', recordedAt: state.observedAt,
  state: { ...state, attempt: { id: `try-${i}`, kind: 'test' } } }));
f.store.put('observation', { id: project.id, status: 'observed', state, recordedAt: state.observedAt });
f.store.put('control-binding', { id: project.id, controller: 'fixture', tokenFile: 'SECRET-NOT-FOR-UI' });
await createHistory(f.store, { clientFor: () => ({ async result() { return { logId: 'test-ledger', firstSeq: 1, latestSeq: 1, gap: false,
  events: [{ seq: 1, type: 'phase.changed', at: state.observedAt, data: { workId: 'OTHER-TASK', from: 'plan', to: 'implement' } }] }; } }) }).refreshProject(project);
let dashboard, browser;
try {
  dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false });
  browser = await openBrowser(dashboard.url, artifacts);
  const { send, evaluate, waitFor, errors } = browser;
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const submitTask = task => evaluate(`document.getElementById('history-task').value=${JSON.stringify(task)}; document.getElementById('history-filter').requestSubmit()`);
  await waitFor('document.getElementById("connection").textContent.includes("연결됨")');
  assert.equal(await evaluate('document.getElementById("history-archive").open'), false);
  assert.equal(await evaluate('document.querySelectorAll(".history-entry").length'), 0);
  await click('#history-archive > summary');
  await waitFor('document.querySelectorAll(".history-entry").length === 50');
  assert.ok((await evaluate('document.getElementById("projects").textContent')).includes('implement / test / module-a'));
  await click(`#projects details[data-id="${project.id}"] summary`);
  assert.ok((await evaluate('document.getElementById("projects").textContent')).includes('통과'));
  await click('.history-entry summary');
  assert.ok((await evaluate('document.querySelector(".history-entry").textContent')).includes('plan → implement'));
  await click('#history-older');
  await waitFor('document.querySelectorAll(".history-entry").length === 4');
  assert.equal(await evaluate('document.getElementById("history-older").disabled'), true);
  await evaluate("window.historyOption = document.getElementById('history-project').options[0]");
  await click('#refresh');
  await waitFor('!document.getElementById("refresh").disabled');
  assert.equal(await evaluate('document.querySelectorAll(".history-entry").length'), 4);
  assert.equal(await evaluate("window.historyOption === document.getElementById('history-project').options[0]"), true);
  await click('#history-archive > summary');
  await click('#history-archive > summary');
  await waitFor('document.querySelectorAll(".history-entry").length === 4');
  await click('#history-latest');
  await waitFor('document.querySelectorAll(".history-entry").length === 50');
  await submitTask('OTHER-TASK');
  await waitFor('document.querySelectorAll(".history-entry").length === 1');
  await submitTask('TASK-1');
  await waitFor('document.querySelectorAll(".history-entry").length === 50');
  await click('.history-entry summary');
  const choose = (id, value) => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change'))`);
  await choose('history-project', f.fixture.projects[1].id);
  await waitFor('document.querySelectorAll(".history-entry").length === 0');
  await choose('history-project', project.id);
  await waitFor('document.querySelectorAll(".history-entry").length === 50');
  await choose('history-group', f.fixture.group.id);
  await waitFor('document.querySelectorAll(".history-entry").length === 50 && !document.getElementById("history-status").textContent.includes("조회하고")');
  await click('.history-entry summary');
  for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 800 });
    await evaluate('document.getElementById("history-filter").scrollIntoView({block:"start"})');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `overflow at ${width}`);
    assert.equal(await evaluate('Boolean(window.injected || document.querySelector("#history-list img") || document.querySelector("#projects img"))'), false);
    writeFileSync(join(artifacts, `timeline-${width}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  await send('Page.reload');
  await waitFor('document.getElementById("connection").textContent.includes("연결됨")');
  assert.equal(await evaluate('document.getElementById("history-archive").open'), false);
  await click('#history-archive > summary');
  await waitFor('document.querySelectorAll(".history-entry").length === 50');
  f.store.event(project.id, 'stage-history', { projectId: project.id, groupIds: [f.fixture.group.id], source: 'future-source',
    type: 'future.event', workId: 'FUTURE', occurredAt: new Date().toISOString(), detail: { reasons: [], phases: [] } });
  await click('#history-latest');
  await waitFor("document.getElementById('history-list').textContent.includes('FUTURE')");
  assert.ok((await evaluate("document.querySelector('.history-entry').textContent")).includes('기타'));
  assert.deepEqual(errors, []);
  const result = { passed: true, artifacts, checks: ['stage-task-verification', 'stable-filter-options', 'unknown-source-label', 'event-transition', 'pagination', 'older-page-preserved', 'archive-collapsed', 'archive-reopen', 'project-group-task-filters', 'reload', '1440-390-320', 'XSS'] };
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close(); await dashboard?.close();
  for (const fn of cleanup.reverse()) fn();
}
