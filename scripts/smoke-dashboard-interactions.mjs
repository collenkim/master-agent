// Windows Chrome UI smoke. Synthetic producers/launcher; never contacts a managed project or model.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { openBrowser } from './browser.mjs';
import { planningSetup, blockedAnswer } from '../tests/planning-fixture.mjs';
import { createInteractions } from '../packages/dashboard/interactions.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { acceptRequest } from '../packages/orchestrator/requests.mjs';
import { createSmokeArtifacts } from './smoke-artifacts.mjs';

const artifacts = createSmokeArtifacts('interactions-browser-'), cleanup = [];
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
  const waitList = () => waitFor(`document.getElementById('interaction-items')?.getAttribute('aria-busy') === 'false'`);
  await waitFor('document.querySelectorAll("#interaction-items .project").length === 4');
  assert.equal(await evaluate('Boolean(window.injected || document.querySelector("#interaction-items img"))'), false);
  await evaluate(`document.getElementById('interaction-source').value='master'; document.getElementById('interaction-source').dispatchEvent(new Event('input'));`);
  await waitList(); await evaluate(`document.querySelector('[data-interaction]').click()`);
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
  await dashboard.monitor.refresh();
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
  const answeredId = f.store.list('interaction-command').find(c => c.answer === '직접 확인한 정책').interactionId;
  await evaluate(`document.getElementById('interaction-close').click(); document.getElementById('interaction-state').value='answered'; document.getElementById('interaction-state').dispatchEvent(new Event('input'))`);
  await waitList(); await evaluate(`document.querySelector('[data-interaction="${answeredId}"]').click()`);
  assert.equal(await evaluate(`document.getElementById('interaction-stale').textContent`), '');
  assert.ok(['직접 확인한 정책', '보존할 입력'].includes(await evaluate(`document.getElementById('interaction-custom').value`)));
  assert.equal(await evaluate(`document.getElementById('interaction-submit').disabled`), true);
  await evaluate(`document.getElementById('interaction-state').value='pending'; document.getElementById('interaction-state').dispatchEvent(new Event('input'))`);
  await evaluate(`document.getElementById('interaction-close').click(); document.getElementById('interaction-source').value='code-agent'; document.getElementById('interaction-source').dispatchEvent(new Event('input'))`);
  await waitList(); await evaluate(`[...document.querySelectorAll('[data-interaction]')].find(b=>b.textContent.includes('승인')).click()`);
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
  await dashboard.monitor.refresh();
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
  // Structured remote numeric constraints are validated on the server and escaped in HTML attributes.
  const numericQuestion = { questionId: 'NUMERIC', title: '속성 검증', mode: 'multiple', required: true,
    minSelections: 0, maxSelections: 2, recommendedOptionIds: [], defaultOptionIds: [], evidence: [], background: '',
    recommendationReason: '명시적으로 선택한다', input: { required: false, minLength: 1, maxLength: 50, description: '직접 입력' },
    options: [{ optionId: 'one', label: '입력 포함', description: '', consequence: '', input: { required: false, minLength: 2, maxLength: 20, description: '옵션 입력' } },
      { optionId: 'two', label: '두 번째', description: '', consequence: '' }] };
  await createInteractions(f.store, { readRemote: async () => ({ capability: { sourceInstanceId: 'numeric-browser' }, records: [{
    schemaVersion: 1, source: 'code-agent', sourceInstanceId: 'numeric-browser', requestId: 'numeric', revision: 1,
    context: { workId: null }, questions: [numericQuestion], title: '속성 검증', stage: 'planning', kind: 'question', status: 'pending', canRespond: false,
  }] }) }).refreshProject(project);
  await evaluate(`document.getElementById('interaction-source').value='code-agent'; document.getElementById('interaction-search').value='속성 검증'; document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('interaction-items').textContent.includes('속성 검증')`);
  await waitList(); await evaluate(`document.querySelector('[data-interaction]').click()`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#interaction-remote-questions [minlength]')].map(e => [e.getAttribute('minlength'),e.getAttribute('maxlength')])`),
    [['2', '20'], ['1', '50']]);
  assert.equal(await evaluate(`document.getElementById('interaction-remote-questions').textContent.includes('0~2개 선택')`), true);
  await evaluate(`document.getElementById('interaction-close').click()`);
  // Archive browsing must preserve every receipt and active request while keeping large histories bounded.
  const archivedBase = f.store.list('interaction').find(i => i.source === 'code-agent' && i.kind === 'question');
  for (let index = 0; index < 55; index++) f.store.put('interaction', { ...archivedBase,
    id: `archive-${index}`, title: `보관 시험 ${index}`, producerState: 'closed',
    updatedAt: new Date(Date.now() + index * 1000).toISOString() });
  const commandCount = f.store.list('interaction-command').length;
  const activeIds = f.store.list('interaction').filter(i => i.producerState === 'open').map(i => i.id);
  await evaluate(`document.getElementById('interaction-source').value=''; document.getElementById('interaction-search').value='보관 시험'; document.getElementById('interaction-archive').click(); document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('interaction-list-status').textContent.includes('55건')`);
  const ids = () => evaluate(`[...document.querySelectorAll('#interaction-items [data-interaction]')].map(e => e.dataset.interaction)`);
  const firstPage = await ids();
  assert.equal(firstPage.length, 25); assert.equal(firstPage[0], 'archive-54');
  assert.equal(await evaluate(`document.getElementById('interaction-items').textContent.includes('새 요청')`), false);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await evaluate(`document.getElementById('interaction-next-page').click(); document.getElementById('refresh').click()`);
  await waitFor(`!document.getElementById('refresh').disabled`);
  const secondPage = await ids();
  assert.equal(secondPage.length, 25); assert.equal(secondPage[0], 'archive-29');
  await evaluate(`document.getElementById('interaction-next-page').click()`);
  await waitList();
  const lastPage = await ids();
  assert.equal(lastPage.length, 5); assert.equal(new Set([...firstPage, ...secondPage, ...lastPage]).size, 55);
  assert.equal(await evaluate(`document.getElementById('interaction-next-page').disabled`), true);
  await evaluate(`document.getElementById('interaction-search').value='보관 시험 54'; document.getElementById('interaction-search').dispatchEvent(new Event('input'))`);
  await waitList();
  assert.deepEqual(await ids(), ['archive-54']);
  assert.equal(await evaluate(`document.getElementById('interaction-prev').disabled`), true);
  await evaluate(`document.querySelector('#interaction-items [data-interaction]').click()`);
  assert.equal(await evaluate(`document.getElementById('interaction-submit').disabled`), true);
  await evaluate(`document.getElementById('interaction-close').click(); document.getElementById('interaction-search').value=''; document.getElementById('interaction-waiting').click()`);
  await waitList();
  assert.equal(await evaluate(`document.getElementById('interaction-state').value`), 'pending');
  assert.equal((await ids()).some(id => id.startsWith('archive-')), false);
  const serverPage = await (await fetch(dashboard.url + '/api/interactions?box=archive&page=3&pageSize=25&search=' + encodeURIComponent('보관 시험'))).json();
  assert.equal(serverPage.items.length, 5); assert.equal(serverPage.total, 55); assert.equal(serverPage.page, 3);
  const savedRevisions = f.store.list('interaction').map(i => [i.id, i.revision]);
  const publicPage = await (await fetch(dashboard.url + '/api/interactions?box=all')).json();
  assert.deepEqual(f.store.list('interaction').map(i => [i.id, i.revision]), savedRevisions);
  assert.equal(/"(?:challenge|humanChannel)"/.test(JSON.stringify(publicPage)), false);
  assert.equal(f.store.list('interaction-command').length, commandCount);
  assert.deepEqual(f.store.list('interaction').filter(i => i.producerState === 'open').map(i => i.id), activeIds);
  await dashboard.close(); await evaluate(`document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('connection').textContent === '연결 끊김'`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, producer: 'synthetic', actualCodeAgentResponses: false,
    checks: ['recommendation-no-auto-submit', 'draft-poll-reopen', 'defer', 'explicit-submit', 'poll-submit-race', 'success-not-stale', 'live-response-history', 'answered-reopen', 'next-question', 'wait-other-answers', 'single-launch', 'stale-view-preserves-input', 'full-approval-unchecked', 'unsupported-disabled', 'XSS', 'remote-number-attributes', 'mobile', 'preparation-legacy-failure', 'preparation-default-no-auto-submit', 'preparation-same-task-recheck', 'archive-pagination', 'server-pagination', 'GET-read-only', 'public-projection', 'archive-search', 'archive-read-only', 'disconnect'], artifacts }));
} finally {
  await browser?.close();
  await dashboard.close();
  for (const fn of cleanup.reverse()) fn();
}
