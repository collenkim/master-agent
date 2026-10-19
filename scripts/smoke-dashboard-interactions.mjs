// Windows Chrome UI smoke. Synthetic producers/launcher; never contacts a managed project or model.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { planningSetup, blockedAnswer } from '../tests/planning-fixture.mjs';
import { createInteractions } from '../packages/dashboard/interactions.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';

mkdirSync(resolve('.master-agent'), { recursive: true });
const artifacts = mkdtempSync(resolve('.master-agent/interactions-browser-')), cleanup = [];
const f = planningSetup({ after(fn) { cleanup.push(fn); } });
await f.planner.analyze(f.mission.id, { name: 'fixture', async generate({ context }) {
  const answer = blockedAnswer(context); answer.issues[0].recommendation = answer.issues[0].options[0];
  answer.issues.push({ ...answer.issues[0], id: 'q2', question: '추가 정책 확인' }); return { data: answer };
} }, { expectedRevision: f.mission.revision, maxPasses: 1 });
f.store.put('target-request', { id: f.mission.id, state: 'waiting', targetType: 'group', targetId: f.fixture.group.id,
  projectIds: f.fixture.projects.map(p => p.id), blockers: [], templatesRegistered: true, templates: [], provider: 'claude', createdAt: new Date().toISOString() });
const project = f.fixture.projects[0];
f.store.put('observation', { id: project.id, status: 'observed', state: { stateVersion: 'fixture', repo: { branch: 'fixture' }, work: { id: 'TASK-42', phase: 'review' } } });
const observer = createInteractions(f.store, { readRemote: async () => ({ capability: { version: 'fixture', responseSupported: false },
  questions: { workId: 'TASK-42', questions: [{ id: 'Q1', title: '<img src=x onerror="window.injected=true"> 외부 질문', body: '외부 질문 전문' }] },
  consents: [{ id: 'C1', action: 'deliver', summary: '승인 전문: 문서 변경과 로컬 반영', choices: [{ shown: 'README.md 변경' }] }] }) });
await observer.refreshProject(project);
let launches = 0;
const dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false,
  launch: async (store, id) => { launches++; return store.need('target-request', id); } });
const browser = spawn(process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${join(artifacts, 'browser-profile')}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket, send;
try {
  const activePort = join(artifacts, 'browser-profile', 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(activePort); i++) { if (browser.exitCode !== null) throw new Error('Chrome exited'); await delay(100); }
  const port = readFileSync(activePort, 'utf8').split('\n')[0];
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(dashboard.url)}`, { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
  let sequence = 0; const pending = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); message.error ? callback.reject(message.error) : callback.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`Timed out: ${expression}\n${JSON.stringify({ errors, form: await evaluate('document.getElementById("interaction-form").innerText'), state: await evaluate('document.getElementById("interaction-submit").disabled'), commands: f.store.list('interaction-command').map(c => ({ action: c.action, state: c.state, error: c.error })) })}`);
  };
  await waitFor('document.querySelectorAll("#interaction-items .project").length === 4');
  assert.equal(await evaluate('Boolean(window.injected || document.querySelector("#interaction-items img"))'), false);
  await evaluate(`document.getElementById('interaction-source').value='master'; document.getElementById('interaction-source').dispatchEvent(new Event('input')); document.querySelector('[data-interaction]').click();`);
  assert.equal(await evaluate('document.querySelectorAll("#interaction-options input:checked").length'), 1, JSON.stringify({ errors, form: await evaluate('document.getElementById("interaction-form").innerHTML') }));
  assert.equal(f.store.list('interaction-command').length, 0);
  await evaluate(`document.getElementById('interaction-custom').value='직접 확인한 정책'; document.getElementById('interaction-custom').dispatchEvent(new Event('input')); document.getElementById('refresh').click();`);
  await delay(700);
  assert.equal(await evaluate('document.getElementById("interaction-custom").value'), '직접 확인한 정책');
  assert.equal(await evaluate('document.querySelectorAll("#interaction-options input:checked").length'), 0);
  await evaluate(`document.getElementById('interaction-defer').click()`);
  await waitFor(`document.getElementById('interaction-error').textContent.includes('보류')`);
  await waitFor(`!document.getElementById('interaction-close').disabled`);
  assert.equal(f.store.need('mission', f.mission.id).clarifications, undefined);
  await evaluate(`document.getElementById('interaction-close').click(); document.querySelector('[data-interaction]').click()`);
  assert.equal(await evaluate('document.getElementById("interaction-custom").value'), '직접 확인한 정책');
  await evaluate(`document.getElementById('interaction-form').requestSubmit()`);
  await waitFor(`document.getElementById('interaction-error').textContent.includes('적용')`);
  await waitFor(`!document.getElementById('interaction-close').disabled`);
  assert.equal(f.store.need('mission', f.mission.id).clarifications.length, 1); assert.equal(launches, 0);
  await evaluate(`document.getElementById('interaction-close').click(); document.querySelector('[data-interaction]').click()`);
  const mission = f.store.need('mission', f.mission.id);
  f.store.put('mission', { ...mission, reason: 'External edit to trigger stale view' }, mission.revision);
  await evaluate(`document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('interaction-stale').textContent.includes('변경')`);
  assert.equal(await evaluate('document.getElementById("interaction-submit").disabled'), true);
  await evaluate(`document.getElementById('interaction-close').click(); document.querySelector('[data-interaction]').click(); document.getElementById('interaction-form').requestSubmit()`);
  await waitFor(`document.getElementById('interaction-error').textContent.includes('적용')`);
  await waitFor(`!document.getElementById('interaction-close').disabled`);
  assert.equal(launches, 1); assert.equal(f.store.need('mission', f.mission.id).clarifications.length, 2);
  await evaluate(`document.getElementById('interaction-close').click(); document.getElementById('interaction-source').value='code-agent'; document.getElementById('interaction-source').dispatchEvent(new Event('input')); [...document.querySelectorAll('[data-interaction]')].find(b=>b.textContent.includes('승인')).click()`);
  assert.equal(await evaluate('document.getElementById("approval-reviewed").checked'), false);
  assert.equal(await evaluate('document.getElementById("approval-body").textContent'), '승인 전문: 문서 변경과 로컬 반영');
  assert.equal(await evaluate('document.querySelector("#interaction-approval button:disabled").textContent.includes("미지원")'), true);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate(`document.getElementById('interaction-approval').scrollWidth <= document.getElementById('interaction-approval').clientWidth`), true);
  writeFileSync(join(artifacts, 'mobile-approval.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`document.getElementById('approval-close').click(); [...document.querySelectorAll('[data-interaction]')].find(b=>b.textContent.includes('질문')).click()`);
  assert.equal(await evaluate('document.getElementById("interaction-submit").disabled'), true);
  assert.equal(await evaluate(`document.getElementById('interaction-dialog').scrollWidth <= document.getElementById('interaction-dialog').clientWidth`), true);
  writeFileSync(join(artifacts, 'mobile-question.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`document.getElementById('interaction-close').click(); document.getElementById('interaction-source').value=''; document.getElementById('interaction-state').value=''; document.getElementById('interaction-source').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  writeFileSync(join(artifacts, 'mobile-inbox.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  writeFileSync(join(artifacts, 'desktop-inbox.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await dashboard.close(); await evaluate(`document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('connection').textContent === '연결 끊김'`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, producer: 'synthetic', actualCodeAgentResponses: false,
    checks: ['recommendation-no-auto-submit', 'draft-poll-reopen', 'defer', 'explicit-submit', 'wait-other-answers', 'single-launch', 'stale-view', 'full-approval-unchecked', 'unsupported-disabled', 'XSS', 'mobile', 'disconnect'], artifacts }));
} finally {
  if (send && socket.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close(); }
  else browser.kill();
  await dashboard.close();
  for (const fn of cleanup.reverse()) fn();
}
