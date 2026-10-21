// Windows Chrome UI smoke. Synthetic producers/launcher; never contacts a managed project or model.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { openBrowser } from './browser.mjs';
import { planningSetup, blockedAnswer } from '../tests/planning-fixture.mjs';
import { createInteractions } from '../packages/dashboard/interactions.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { acceptRequest } from '../packages/orchestrator/requests.mjs';

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
let browser;
try {
  browser = await openBrowser(dashboard.url, artifacts);
  const { send, evaluate, waitFor, errors } = browser;
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
  // Hold a poll that captured the unanswered question; POST must fetch again after that poll completes.
  await evaluate(`window.originalFetch = window.fetch; window.holdOverview = true;
    window.fetch = async (...args) => {
      const response = await window.originalFetch(...args);
      if (args[0] === '/api/overview' && window.holdOverview) {
        window.holdOverview = false;
        return new Promise(resolve => { window.releaseOverview = () => resolve(response); });
      }
      return response;
    }; document.getElementById('refresh').click()`);
  await waitFor(`typeof window.releaseOverview === 'function'`);
  await evaluate(`document.getElementById('interaction-form').requestSubmit()`);
  await waitFor(`document.getElementById('interaction-error').textContent.includes('적용')`);
  await evaluate(`window.releaseOverview(); window.fetch = window.originalFetch`);
  await waitFor(`!document.getElementById('interaction-close').disabled`);
  assert.equal(f.store.need('mission', f.mission.id).clarifications.length, 1); assert.equal(launches, 0);
  assert.equal(await evaluate(`document.getElementById('interaction-stale').textContent`), '');
  assert.ok((await evaluate(`document.getElementById('interaction-history').textContent`)).includes('직접 확인한 정책'));
  assert.equal(await evaluate(`document.getElementById('interaction-history').textContent.includes('아직 제출한 답변이 없습니다')`), false);
  assert.equal(await evaluate(`document.getElementById('interaction-submit').disabled`), true);
  assert.ok((await evaluate(`document.getElementById('interaction-error').textContent`)).includes('남은 질문 1개'));
  await evaluate(`document.getElementById('interaction-next').click()`);
  assert.equal(await evaluate(`document.getElementById('interaction-submit').disabled`), false);
  assert.equal(await evaluate(`document.getElementById('interaction-custom').disabled`), false);
  await evaluate(`document.getElementById('interaction-custom').value='보존할 입력'; document.getElementById('interaction-custom').dispatchEvent(new Event('input'))`);
  const mission = f.store.need('mission', f.mission.id);
  f.store.put('mission', { ...mission, reason: 'External edit to trigger stale view' }, mission.revision);
  await evaluate(`document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('interaction-stale').textContent.includes('변경')`);
  assert.equal(await evaluate('document.getElementById("interaction-submit").disabled'), true);
  assert.equal(await evaluate(`document.getElementById('interaction-custom').value`), '보존할 입력');
  await evaluate(`document.getElementById('interaction-close').click(); document.querySelector('[data-interaction]').click(); document.getElementById('interaction-form').requestSubmit()`);
  await waitFor(`document.getElementById('interaction-error').textContent.includes('적용')`);
  await waitFor(`!document.getElementById('interaction-close').disabled`);
  assert.equal(launches, 1); assert.equal(f.store.need('mission', f.mission.id).clarifications.length, 2);
  assert.equal(await evaluate(`document.getElementById('interaction-stale').textContent`), '');
  assert.equal(await evaluate(`document.getElementById('interaction-next').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('interaction-history').textContent.includes('아직 제출한 답변이 없습니다')`), false);
  await evaluate(`document.getElementById('interaction-close').click(); document.getElementById('interaction-state').value='answered'; document.getElementById('interaction-state').dispatchEvent(new Event('input')); document.querySelector('[data-interaction]').click()`);
  assert.equal(await evaluate(`document.getElementById('interaction-stale').textContent`), '');
  assert.ok(['직접 확인한 정책', '보존할 입력'].includes(await evaluate(`document.getElementById('interaction-custom').value`)));
  assert.equal(await evaluate(`document.getElementById('interaction-submit').disabled`), true);
  await evaluate(`document.getElementById('interaction-state').value='pending'; document.getElementById('interaction-state').dispatchEvent(new Event('input'))`);
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
  // An older failed request must become actionable without creating a replacement TASK.
  const preparation = acceptRequest(f.store, { targetType: 'project', targetId: project.id, goal: '새 서비스 준비', taskNumber: 'SETUP-1' }).request;
  f.store.put('target-request', { ...preparation, state: 'failed', error: { code: 'missing-knowledge', message: '먼저 근거를 수집하세요.' } }, preparation.revision);
  await evaluate(`document.getElementById('interaction-source').value='master'; document.getElementById('interaction-state').value='pending'; document.getElementById('interaction-search').value='SETUP-1'; document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('interaction-items').textContent.includes('프로젝트 실행 준비 필요')`);
  assert.ok((await evaluate('document.getElementById("projects").textContent')).includes('먼저 근거를 수집하세요.'));
  await evaluate(`document.querySelector('[data-interaction]').click()`);
  assert.equal(await evaluate('document.querySelector("#interaction-options input:checked").value'), 'recheck');
  assert.equal(await evaluate('document.getElementById("interaction-custom-label").hidden'), true);
  assert.equal(launches, 1);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate(`document.getElementById('interaction-dialog').scrollWidth <= document.getElementById('interaction-dialog').clientWidth`), true);
  writeFileSync(join(artifacts, 'mobile-preparation.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`document.getElementById('interaction-form').requestSubmit()`);
  await waitFor(`document.getElementById('interaction-error').textContent.includes('적용')`);
  assert.equal(launches, 2);
  assert.equal(f.store.need('target-request', preparation.id).state, 'queued');
  assert.equal(f.store.need('target-request', preparation.id).taskNumber, 'SETUP-1');
  await evaluate(`document.getElementById('interaction-close').click()`);
  await dashboard.close(); await evaluate(`document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('connection').textContent === '연결 끊김'`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, producer: 'synthetic', actualCodeAgentResponses: false,
    checks: ['recommendation-no-auto-submit', 'draft-poll-reopen', 'defer', 'explicit-submit', 'poll-submit-race', 'success-not-stale', 'live-response-history', 'answered-reopen', 'next-question', 'wait-other-answers', 'single-launch', 'stale-view-preserves-input', 'full-approval-unchecked', 'unsupported-disabled', 'XSS', 'mobile', 'preparation-legacy-failure', 'preparation-default-no-auto-submit', 'preparation-same-task-recheck', 'disconnect'], artifacts }));
} finally {
  await browser?.close();
  await dashboard.close();
  for (const fn of cleanup.reverse()) fn();
}
