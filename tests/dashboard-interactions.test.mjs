import { ControlClient } from '../packages/code-agent-adapter/control.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInteractions } from '../packages/dashboard/interactions.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { Store } from '../packages/storage/store.mjs';
import { runRequest } from '../packages/orchestrator/requests.mjs';
import { Recovery } from '../packages/orchestrator/recovery.mjs';
import { planningSetup, blockedAnswer } from './planning-fixture.mjs';
import { verificationFixture } from './verification-fixture.mjs';

async function pending(t, { count = 1, recommendation = '확정 이벤트' } = {}) {
  const f = planningSetup(t);
  await f.planner.analyze(f.mission.id, { name: 'fixture', async generate({ context }) {
    const answer = blockedAnswer(context); answer.issues[0].recommendation = recommendation;
    if (count === 2) answer.issues.push({ ...answer.issues[0], id: 'q2', question: '두 번째 질문' });
    return { data: answer };
  } }, { expectedRevision: f.mission.revision, maxPasses: 1 });
  return f;
}
const input = (item, extra = {}) => ({ id: item.id, revision: item.revision, contentHash: item.contentHash, context: item.context,
  commandId: randomUUID(), action: 'answer', optionIds: item.options[0] ? [item.options[0].id] : [], custom: '', ...extra });
function request(store, id) {
  return store.put('target-request', { id, state: 'waiting', templatesRegistered: true, templates: [], projectIds: [], provider: 'claude', createdAt: new Date().toISOString() });
}

test('master inbox defaults only an exact producer recommendation; deferral never answers', async t => {
  const f = await pending(t), inbox = createInteractions(f.store);
  let item = inbox.snapshot().items[0];
  assert.deepEqual(item.recommendedOptionIds, ['1']); assert.ok(item.references.length);
  const deferred = await inbox.respond(input(item, { action: 'defer', optionIds: [] }));
  assert.equal(deferred.state, 'deferred'); assert.equal(f.store.need('mission', f.mission.id).clarifications, undefined);
  item = inbox.snapshot().items[0]; assert.equal(item.state, 'deferred');
  await inbox.respond(input(item, { optionIds: [], custom: '운영 담당자가 확정한 조건', resume: false }));
  assert.equal(inbox.snapshot().items[0].state, 'answered');
  assert.equal(f.store.need('mission', f.mission.id).clarifications[0].answer, '운영 담당자가 확정한 조건');
});

test('legacy recommendation prose is displayed without guessing a default choice', async t => {
  const f = await pending(t, { recommendation: '첫 번째를 기준으로 검토' });
  assert.deepEqual(createInteractions(f.store).snapshot().items[0].recommendedOptionIds, []);
});

test('persisted command survives a lost response/reopened DB and prevents duplicate or changed answers', async t => {
  const f = await pending(t), inbox = createInteractions(f.store), item = inbox.snapshot().items[0], body = input(item);
  const first = await inbox.respond(body);
  const reopened = new Store(f.db);
  try {
    const secondInbox = createInteractions(reopened);
    assert.deepEqual(await secondInbox.respond(body), first);
    await assert.rejects(secondInbox.respond({ ...body, custom: 'changed' }), { code: 'request-conflict' });
    await assert.rejects(secondInbox.respond({ ...body, commandId: randomUUID() }), { code: 'stale-question' });
    assert.equal(reopened.need('mission', f.mission.id).clarifications.length, 1);
    assert.equal(reopened.list('interaction-command').length, 1);
  } finally { reopened.close(); }
});

test('all answers are required before a single launch; parallel tabs cannot launch twice', async t => {
  const f = await pending(t, { count: 2 }); request(f.store, f.mission.id);
  let launches = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const inbox = createInteractions(f.store, { launch: async (store, id) => { launches++; await gate; return store.need('target-request', id); } });
  const initial = inbox.snapshot().items;
  const first = await inbox.respond(input(initial[0], { resume: true }));
  assert.equal(first.resume.state, 'waiting-answers'); assert.equal(launches, 0);
  await assert.rejects(inbox.respond(input(initial[1])), { code: 'stale-question' });
  const next = inbox.snapshot().items.find(i => i.state === 'open'), body = input(next, { resume: true });
  const running = inbox.respond(body);
  assert.equal(launches, 1);
  assert.equal((await inbox.respond(body)).resume.state, 'launching');
  release(); assert.equal((await running).resume.state, 'requested');
  assert.equal((await inbox.respond(body)).resume.state, 'requested'); assert.equal(launches, 1);
  assert.equal(f.store.need('target-request', f.mission.id).state, 'queued');
});

test('launch failure preserves applied answer and never automatically relaunches', async t => {
  const f = await pending(t); request(f.store, f.mission.id); let calls = 0;
  const inbox = createInteractions(f.store, { launch: async () => { calls++; throw new Error('unavailable'); } });
  const body = input(inbox.snapshot().items[0], { resume: true });
  const receipt = await inbox.respond(body);
  assert.equal(receipt.state, 'applied'); assert.equal(receipt.resume.state, 'failed');
  await inbox.respond(body); assert.equal(calls, 1);
});

test('restart can reconcile an interrupted master launch without reapplying the answer or resetting a worker', async t => {
  const f = await pending(t); request(f.store, f.mission.id);
  const original = createInteractions(f.store, { launch: async (store, id) => store.need('target-request', id) });
  const body = input(original.snapshot().items[0], { resume: true }), result = await original.respond(body);
  f.store.put('interaction-command', { ...result, resume: { state: 'launching', requestId: f.mission.id } }, result.revision);
  let calls = 0;
  const restarted = createInteractions(f.store, { launch: async (store, id) => { calls++; return store.need('target-request', id); } });
  assert.equal((await restarted.retry(result.id)).resume.state, 'requested');
  await restarted.respond(body);
  assert.equal(calls, 1); assert.equal(f.store.need('mission', f.mission.id).clarifications.length, 1);
});

test('cloned code-agent ledger IDs remain distinct per project', async t => {
  const f = await pending(t);
  const record = { schemaVersion: 1, source: 'code-agent', sourceInstanceId: 'cloned', requestId: 'same', revision: 1, contentHash: 'hash',
    context: { workId: null, branch: 'main', sessionId: 'session' }, title: '같은 원장 복사', stage: 'setup', kind: 'question',
    questions: [], status: 'pending', canRespond: false, unavailableReason: 'no channel', createdAt: new Date().toISOString() };
  const inbox = createInteractions(f.store, { readRemote: async () => ({ capability: { sourceInstanceId: 'cloned', responseSupported: true }, records: [record] }) });
  for (const p of f.fixture.projects.slice(0, 2)) await inbox.refreshProject(p);
  const items = inbox.snapshot().items.filter(i => i.source === 'code-agent');
  assert.equal(items.length, 2); assert.notEqual(items[0].id, items[1].id);
  assert.notDeepEqual(items[0].projectIds, items[1].projectIds);
});

test('group edits preserve the accepted question scope and do not copy an answer to another project', async t => {
  const f = await pending(t), inbox = createInteractions(f.store), item = inbox.snapshot().items[0];
  f.engine.catalog.group({ ...f.fixture.group, projectIds: [f.fixture.projects[0].id] }, f.store.need('group', f.fixture.group.id).revision);
  assert.deepEqual(inbox.snapshot().items[0].projectIds, item.projectIds);
  await inbox.respond(input(item));
  assert.deepEqual(f.store.need('mission', f.mission.id).scope.projectIds, item.projectIds);
  assert.equal(f.store.list('interaction-command').length, 1);
});

test('a replaced remote ledger resets the cursor and expires old requests without querying missing IDs', async t => {
  const f = await pending(t), project = f.fixture.projects[0], cli = join(f.root, 'remote.mjs'), view = join(f.root, 'view.json'), tokenFile = join(f.root, 'token');
  writeFileSync(tokenFile, 'synthetic');
  f.store.put('control-binding', { id: project.id, controller: 'test', tokenFile, generation: 1 });
  writeFileSync(cli, `import {readFileSync} from 'node:fs'; const request=JSON.parse(readFileSync(0,'utf8')); const view=JSON.parse(readFileSync(${JSON.stringify(view)},'utf8'));
    const hello={codeAgent:{version:'fixture',stateSchema:7},interactions:{schemaVersion:1,humanChannel:'dashboard-human',signature:'Ed25519'},commands:{read:['interactions','interaction','interaction.result'],mutating:['interaction.respond']}};
    const after=request.payload?.after??0; const found=view.requests.find(r=>r.requestId===request.payload?.requestId);
    const result=request.type==='hello'?hello:request.type==='interactions'?{...view,requests:view.requests.filter(r=>r.revision>after),cursor:Math.max(after,view.latestCursor)}:found;
    console.log(JSON.stringify({protocol:'code-agent.master',version:1,ok:Boolean(result),result,error:result?undefined:{code:'not-found',message:'missing old ID'}}));`);
  const record = source => ({ schemaVersion: 1, source: 'code-agent', sourceInstanceId: source, requestId: `request-${source}`, revision: 1, contentHash: source,
    context: { workId: null }, questions: [], title: source, stage: 'setup', kind: 'question', status: 'pending', canRespond: false, createdAt: new Date().toISOString() });
  const feed = source => writeFileSync(view, JSON.stringify({ schemaVersion: 1, sourceInstanceId: source, latestCursor: 1, requests: [record(source)] }));
  const inbox = createInteractions(f.store, { cliPath: cli });
  feed('old'); await inbox.refreshProject(project);
  feed('new'); await inbox.refreshProject(project);
  const state = inbox.snapshot();
  assert.equal(state.sources[0].sourceInstanceId, 'new'); assert.equal(state.sources[0].error, null);
  assert.equal(state.items.find(i => i.requestId === 'request-old').state, 'expired');
  assert.equal(state.items.find(i => i.requestId === 'request-new').state, 'open');
});

test('setup consent binds by execution and links its escalation without inventing a work ID', async t => {
  const f = await pending(t), project = f.fixture.projects[0], m = f.store.need('mission', f.mission.id);
  f.store.put('mission', { ...m, taskNumber: 'TASK-SETUP', attempts: [{ id: 'attempt-setup', projectId: project.id, taskId: 'T1', state: 'waiting-decision', codeAgentWorkId: 'MA-not-started' }] }, m.revision);
  f.store.put('control-run', { id: 'run-setup', projectId: project.id, missionId: m.id, attemptId: 'attempt-setup', sessionId: 'session-setup' });
  f.store.put('escalation', { id: 'escalation-setup', missionId: m.id, attemptId: 'attempt-setup', taskId: 'T1', projectId: project.id, target: 'consent-setup', kind: 'consent', state: 'open', reason: 'baseline approval', createdAt: new Date().toISOString() });
  const record = { schemaVersion: 1, source: 'code-agent', sourceInstanceId: 'source-setup', requestId: 'request-setup', revision: 1,
    context: { workId: null, runId: 'run-setup', sessionId: 'session-setup' }, origin: { type: 'consent', id: 'consent-setup' },
    questions: [], consent: { summary: '기준 커밋 생성', choices: [] }, title: '기준 커밋 생성', stage: 'setup', kind: 'consent', status: 'pending', canRespond: true, localKeyAvailable: true };
  const inbox = createInteractions(f.store, { readRemote: async () => ({ capability: { sourceInstanceId: record.sourceInstanceId }, records: [record] }) });
  await inbox.refreshProject(project);
  let snapshot = inbox.snapshot(), remote = snapshot.items.find(i => i.handler === 'code-agent');
  assert.equal(remote.missionId, m.id); assert.equal(remote.taskNumber, 'TASK-SETUP'); assert.equal(remote.taskId, 'T1'); assert.equal(remote.workId, null);
  assert.equal(snapshot.items.find(i => i.handler === 'escalation').relatedInteractionId, remote.id);
  record.context.sessionId = 'other-session';
  await inbox.refreshProject(project);
  snapshot = inbox.snapshot(); remote = snapshot.items.find(i => i.handler === 'code-agent');
  assert.equal(remote.missionId, null); assert.equal(snapshot.items.find(i => i.handler === 'escalation').relatedInteractionId, null);
  record.context.runId = null;
  await inbox.refreshProject(project);
  assert.equal(inbox.snapshot().items.find(i => i.handler === 'code-agent').missionId, null);
});

test('stale content/context, paused goal, invalid answers, deletion and update locks reject without receipts', async t => {
  const f = await pending(t), inbox = createInteractions(f.store), item = inbox.snapshot().items[0];
  for (const patch of [{ contentHash: 'changed' }, { context: { ...item.context, missionRevision: 0 } }]) await assert.rejects(inbox.respond(input(item, patch)), { code: 'stale-question' });
  for (const patch of [{ optionIds: ['unknown'] }, { optionIds: ['1', '2'] }, { custom: 'mixed' }, { optionIds: [], custom: '' }]) await assert.rejects(inbox.respond(input(item, patch)), { code: 'invalid-input' });
  const projectId = item.projectIds[0];
  const maintenance = f.store.put('project-maintenance', { id: projectId, active: true });
  await assert.rejects(inbox.respond(input(item)), { code: 'project-busy' });
  f.store.put('project-maintenance', { ...maintenance, active: false }, maintenance.revision);
  const p = f.store.need('project', projectId); f.store.put('project', { ...p, deletedAt: new Date().toISOString() }, p.revision);
  await assert.rejects(inbox.respond(input(item)), { code: 'stale-question' });
  f.store.put('project', p, p.revision + 1);
  f.engine.control(f.mission.id, 'pause', f.store.need('mission', f.mission.id).revision);
  await assert.rejects(inbox.respond(input(item)), { code: 'stale-question' });
  assert.equal(f.store.list('interaction-command').length, 0);
});

test('independent legacy requests/approval are visible across stages but human-only writes stay disabled', async t => {
  const f = await pending(t), p = f.fixture.projects[0]; let fail = false;
  const inbox = createInteractions(f.store, { readRemote: async () => {
    if (fail) throw new Error('offline');
    return { capability: { version: 'legacy', responseSupported: false },
      questions: { workId: 'TASK-42', questionsHash: 'hash', questions: [{ id: 'Q1', title: '<script>question</script>', body: 'Full question', options: { A: 'Option A' } }] },
      consents: [{ id: 'C1', action: 'deliver', summary: 'Full approval', choices: [{ shown: 'README.md change' }], shownHash: 'approval-hash' }] };
  } });
  for (const stage of ['setup', 'request', 'plan', 'implement', 'test', 'review', 'deliver', 'recovery', 'maintenance']) {
    const old = f.store.get('observation', p.id);
    f.store.put('observation', { id: p.id, status: 'observed', state: { stateVersion: 'state', repo: { branch: 'one' }, work: { id: 'TASK-42', phase: stage } } }, old?.revision ?? 0);
    await inbox.refreshProject(p);
    const items = inbox.snapshot().items.filter(i => i.source === 'code-agent');
    assert.equal(items.length, 2); assert.ok(items.every(i => i.stage === stage && i.missionId === null && !i.respondSupported));
    const approval = items.find(i => i.kind === 'approval');
    assert.equal(approval.body, 'Full approval'); assert.deepEqual(approval.options, []); assert.deepEqual(approval.recommendedOptionIds, []);
    await assert.rejects(inbox.respond(input(approval, { optionIds: [] })), { code: 'interaction-unsupported' });
  }
  fail = true; await inbox.refreshProject(p);
  assert.equal(inbox.snapshot().items.filter(i => i.source === 'code-agent' && i.state === 'open').length, 2);
  assert.equal(inbox.snapshot().sources[0].error, 'interaction-unavailable');
});

test('HTTP answer requires same-origin token and changed payload cannot reuse a command', async t => {
  const f = await pending(t), dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false });
  try {
    const data = await (await fetch(dashboard.url + '/api/overview')).json();
    const inbox = await (await fetch(dashboard.url + '/api/interactions')).json(), item = inbox.items[0], body = input(item);
    const send = (payload, token = data.token) => fetch(dashboard.url + '/api/interactions/respond', { method: 'POST',
      headers: { Origin: dashboard.url, 'Content-Type': 'application/json', 'X-Master-Token': token }, body: JSON.stringify(payload) });
    assert.equal((await send(body, 'wrong')).status, 403);
    assert.equal((await send(body)).status, 200);
    assert.equal((await send({ ...body, commandId: randomUUID() })).status, 409);
    assert.equal((await fetch(dashboard.url + '/interactions.mjs')).status, 200);
  } finally { await dashboard.close(); }
});

test('recovery answer reuses the original attempt/session and rechecks actual failure evidence before repair', async t => {
  const f = verificationFixture(t), attempt = await f.dispatch('edit-one');
  writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 3;\n'); await f.verify(attempt);
  f.states.one.resume = { code: 'ready' };
  await new Recovery(f.store).recover(f.mission.id, attempt.id, f.host, { name: 'fixture', async generate({ context }) {
    return { data: { schemaVersion: 1, action: 'needs-context', category: 'unknown', summary: '확정 값 필요', cause: '값 미정', references: [context.failure.id],
      alternatives: ['2로 수정', '보류'], steps: [], question: '확정 값은?', recommendation: '2로 수정', uncertainties: ['값 확인'] } };
  } }, f.options('one'));
  request(f.store, f.mission.id);
  let executions = 0;
  const execute = f.host.execute;
  f.host.execute = async (ticket, options) => { executions++; assert.equal(ticket.sessionId, 'fixture-session'); return execute(ticket, options); };
  const inbox = createInteractions(f.store, { launch: async (store, id) => runRequest(store, id, { host: f.host,
    provider: { name: 'fixture', async generate({ context }) {
      assert.equal(context.supplemental, '2로 수정');
      return { data: { schemaVersion: 1, action: 'repair', category: 'implementation', summary: '값 수정', cause: 'assertion 불일치', references: [context.failure.id],
        alternatives: ['범위 내 수정', '추가 조사'], steps: [{ instruction: '2로 수정', paths: ['source.mjs'], references: [context.failure.id] }], question: '', recommendation: '', uncertainties: [] } };
    } }, workflow: { async run() { return { blockers: [] }; } } }) });
  const held = f.store.list('recovery-run').find(r => r.state === 'held');
  f.store.put('recovery-run', { ...held, proposal: { ...held.proposal, action: 'replan' } }, held.revision);
  inbox.observeMaster();
  const replan = inbox.snapshot().items.find(i => i.handler === 'recovery');
  assert.equal(replan.respondSupported, false);
  await assert.rejects(inbox.respond(input(replan)), { code: 'interaction-unsupported' });
  f.store.put('recovery-run', held, held.revision + 1);
  inbox.observeMaster();
  const item = inbox.snapshot().items.find(i => i.handler === 'recovery'); assert.ok(item);
  const body = input(item, { resume: true }); await inbox.respond(body); await inbox.respond(body);
  const m = f.store.need('mission', f.mission.id);
  assert.equal(executions, 1); assert.equal(m.attempts.length, 1); assert.equal(m.attempts[0].id, attempt.id);
  assert.equal(m.recoveryAnswers[0].state, 'reviewed');
  assert.equal((await f.verify(attempt)).attempts[0].state, 'verified');
});



test('M6: 요청함 snapshot은 쓰지 않고 관측 갱신 뒤에만 master revision을 반영한다', async t => {
  const f = await pending(t), inbox = createInteractions(f.store), before = inbox.snapshot().items[0];
  const m = f.store.need('mission', f.mission.id);
  f.store.put('mission', { ...m, reason: '외부 실행기 변경' }, m.revision);
  let transactions = 0; const transaction = f.store.transaction;
  t.mock.method(f.store, 'transaction', function (...args) { transactions++; return transaction.apply(this, args); });
  const current = inbox.snapshot({ box: 'waiting', page: 1, pageSize: 10 }).items[0];
  assert.equal(transactions, 0); assert.equal(current.revision, before.revision);
  inbox.observeMaster();
  assert.equal(transactions, 1);
  assert.ok(inbox.snapshot().items[0].revision > before.revision);
});

test('M6: HTTP 요청함은 상자·필터·페이지를 서버에서 적용하고 GET은 revision을 바꾸지 않는다', async t => {
  const f = await pending(t), project = f.fixture.projects[0];
  const records = Array.from({ length: 120 }, (_, i) => ({ schemaVersion: 1, source: 'code-agent', sourceInstanceId: 'paged',
    requestId: 'page-' + i, revision: 1, contentHash: 'hash-' + i, context: { workId: null }, questions: [],
    title: '원격 페이지 ' + i, stage: i % 2 ? 'planning' : 'review', kind: 'question',
    status: i < 60 ? 'pending' : 'applied', canRespond: false, createdAt: new Date().toISOString() }));
  const inbox = createInteractions(f.store, { readRemote: async () => ({ capability: { sourceInstanceId: 'paged' }, records }) });
  await inbox.refreshProject(project);
  const dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false });
  try {
    await dashboard.monitor.refresh();
    const saved = () => f.store.db.prepare('SELECT kind,id,revision FROM records ORDER BY kind,id').all();
    const before = saved(), events = f.store.db.prepare('SELECT count(*) AS n FROM events').get().n;
    const get = async query => (await fetch(dashboard.url + '/api/interactions?source=code-agent&' + query)).json();
    const first = await get('box=waiting&page=1&pageSize=10'), second = await get('box=waiting&page=2&pageSize=10');
    assert.equal(first.total, 60); assert.equal(second.page, 2);
    assert.equal(first.items.length, 10); assert.equal(second.items.length, 10);
    assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 20);
    const archived = await get('box=archive&page=999&pageSize=10');
    assert.equal(archived.total, 60); assert.equal(archived.page, 6);
    assert.ok(archived.items.every(i => i.state === 'answered'));
    assert.equal((await get('box=waiting&stage=review')).total, 30);
    assert.equal((await get('box=waiting&projectId=not-a-project')).total, 0);
    assert.equal((await get('box=archive&search=' + encodeURIComponent('원격 페이지 119'))).total, 1);
    assert.equal((await fetch(dashboard.url + '/api/interactions?pageSize=101')).status, 400);
    const overview = await (await fetch(dashboard.url + '/api/overview')).json();
    assert.equal(overview.interactions, undefined);
    assert.deepEqual(saved(), before);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events').get().n, events);
  } finally { await dashboard.close(); }
});

test('M6: 관측 전에 질문 원본만 변경돼도 오래된 답변은 기록하지 않는다', async t => {
  const f = await pending(t), inbox = createInteractions(f.store), item = inbox.snapshot().items[0];
  const before = f.store.need('mission', f.mission.id), run = f.store.need('analysis-run', item.runId);
  f.store.put('analysis-run', { ...run, result: { ...run.result, issues: run.result.issues.map(i => ({ ...i, question: '변경된 질문' })) } }, run.revision);
  assert.equal(f.store.need('mission', f.mission.id).revision, before.revision);
  await assert.rejects(inbox.respond(input(item)), { code: 'stale-question' });
  assert.equal(f.store.list('interaction-command').length, 0);
  assert.equal(f.store.need('mission', f.mission.id).clarifications, undefined);
});

test('M6: 질문 응답에는 원격 challenge·humanChannel과 기타 내부 필드를 노출하지 않는다', async t => {
  const f = await pending(t), project = f.fixture.projects[0];
  const record = { schemaVersion: 1, source: 'code-agent', sourceInstanceId: 'projection', requestId: 'projected',
    revision: 1, contentHash: 'hash', context: { workId: null }, questions: [], title: '표시할 질문', stage: 'planning',
    kind: 'question', status: 'pending', canRespond: false, challenge: 'private-challenge',
    humanChannel: { channelId: 'private-channel' }, privateExtension: 'private-extension',
    application: { state: 'pending', privateExtension: 'private-application' },
    continuation: { state: 'not-requested', privateExtension: 'private-continuation' } };
  const inbox = createInteractions(f.store, { readRemote: async () => ({
    capability: { sourceInstanceId: 'projection', humanChannel: 'private-capability' }, records: [record] }) });
  await inbox.refreshProject(project);
  const result = inbox.snapshot({ box: 'waiting', source: 'code-agent', page: 1, pageSize: 10 });
  assert.equal(result.items[0].title, '표시할 질문'); assert.equal(result.items[0].remote.status, 'pending');
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.ok(!/"(?:challenge|humanChannel)"/.test(JSON.stringify(result)));
  assert.equal(f.store.need('interaction', result.items[0].id).remote.challenge, record.challenge);
});


test('M9: 원격 질문의 숫자 속성·선택 개수·승인 번호를 검증한다', async t => {
  const f = await pending(t), project = f.fixture.projects[0];
  const question = { questionId: 'Q1', title: '입력 확인', mode: 'text', options: [], recommendedOptionIds: [], defaultOptionIds: [], evidence: [],
    minSelections: 0, maxSelections: 0, input: { minLength: 1, maxLength: 8000, required: true, description: '답변' } };
  const base = { schemaVersion: 1, source: 'code-agent', sourceInstanceId: 'numbers', requestId: 'numeric-question', revision: 1,
    context: { workId: null }, title: '숫자 계약', kind: 'question', stage: 'planning', status: 'pending', canRespond: false, questions: [question] };
  let record = base;
  const inbox = createInteractions(f.store, { readRemote: async () => ({ capability: { sourceInstanceId: 'numbers' }, records: [record] }) });
  for (const q of [
    { ...question, input: { ...question.input, maxLength: '8000" autofocus' } },
    { ...question, input: { ...question.input, minLength: -1 } },
    { ...question, input: { ...question.input, maxLength: 8001 } },
    { ...question, maxSelections: 1.5 },
    { ...question, minSelections: 17, maxSelections: 17 },
    { ...question, options: [{ optionId: 'one', input: { minLength: 1, maxLength: '5' } }] },
  ]) {
    record = { ...base, questions: [q] };
    await assert.rejects(inbox.refreshProject(project), { code: 'invalid-remote-question' });
  }
  record = { ...base, kind: 'consent', questions: [], consent: { summary: '동의', choices: [{ index: '1', shown: '파일' }] } };
  await assert.rejects(inbox.refreshProject(project), { code: 'invalid-remote-question' });
  assert.equal(inbox.snapshot().items.filter(i => i.source === 'code-agent').length, 0);
  record = base; await inbox.refreshProject(project);
  assert.equal(inbox.snapshot().items.find(i => i.source === 'code-agent').questions[0].input.maxLength, 8000);
});


test('L4: 재기동은 sending을 unknown으로 전환하고 같은 commandId로 기존 응답 결과를 한 번 확인한다', async t => {
  const f = await pending(t), project = f.fixture.projects[0], cli = join(f.root, 'recovery-cli.mjs');
  writeFileSync(cli, '');
  f.store.put('control-binding', { id: project.id, controller: 'restart', generation: 1, tokenFile: join(f.root, 'unused-token') });
  const command = { id: 'interrupted-response', interactionId: 'remote-item', projectId: project.id,
    controller: 'restart', generation: 1, state: 'sending', remoteWire: { commandId: 'interrupted-response' }, resume: { state: 'not-requested' } };
  f.store.put('interaction-command', command);
  const calls = [];
  t.mock.method(ControlClient.prototype, 'result', async (type, input) => {
    calls.push([type, input]);
    assert.equal(f.store.need('interaction-command', command.id).state, 'unknown');
    return { status: 'responded', receiptId: 'received-once' };
  });
  const inbox = createInteractions(f.store, { cliPath: cli, readRemote: async () => ({ capability: {}, records: [] }) });
  await inbox.stop();
  assert.deepEqual(calls, [['interaction.respond', command.remoteWire]]);
  assert.equal(f.store.need('interaction-command', command.id).state, 'received');
  assert.equal(f.store.need('interaction-command', command.id).receiptId, 'received-once');
  await createInteractions(f.store, { cliPath: cli, readRemote: async () => ({ capability: {}, records: [] }) }).stop();
  assert.equal(calls.length, 1);
});

test('L4: 재기동 확인 실패는 unknown과 수동 재시도 경로를 보존하고 자동으로 반복하지 않는다', async t => {
  const f = await pending(t), project = f.fixture.projects[0], cli = join(f.root, 'recovery-cli.mjs');
  writeFileSync(cli, '');
  f.store.put('control-binding', { id: project.id, controller: 'restart', generation: 1, tokenFile: join(f.root, 'unused-token') });
  const id = 'unconfirmed-response';
  f.store.put('interaction-command', { id, interactionId: 'remote-item', projectId: project.id,
    controller: 'restart', generation: 1, state: 'sending', remoteWire: { commandId: id }, resume: { state: 'not-requested' } });
  const calls = [];
  t.mock.method(ControlClient.prototype, 'result', async (type, input) => {
    calls.push([type, input]);
    if (calls.length === 1) throw Object.assign(new Error('private-host-error'), { code: 'control-unavailable' });
    return { status: 'responded', receiptId: 'retry-receipt' };
  });
  const options = { cliPath: cli, readRemote: async () => ({ capability: {}, records: [] }) };
  const inbox = createInteractions(f.store, options);
  await inbox.stop();
  assert.equal(f.store.need('interaction-command', id).state, 'unknown');
  assert.ok(!JSON.stringify(f.store.need('interaction-command', id)).includes('private-host-error'));
  await createInteractions(f.store, options).stop();
  assert.equal(calls.length, 1);
  await inbox.retry(id);
  assert.deepEqual(calls.map(([type]) => type), ['interaction.respond', 'interaction.respond']);
  assert.equal(calls[1][1].commandId, id);
  assert.equal(f.store.need('interaction-command', id).state, 'received');
});

test('L5: 원격 답변 optionInputs는 문자열 값만 서명 전에 허용한다', async t => {
  const f = await pending(t), project = f.fixture.projects[0], cli = join(f.root, 'input-cli.mjs');
  writeFileSync(cli, '');
  f.store.put('control-binding', { id: project.id, controller: 'inputs', generation: 1, tokenFile: join(f.root, 'unused-token') });
  const record = { schemaVersion: 1, source: 'code-agent', sourceInstanceId: 'option-inputs', requestId: 'Q-inputs', revision: 1,
    contentHash: 'remote-hash', context: { workId: null }, questions: [], title: '선택 입력', stage: 'planning',
    kind: 'question', status: 'pending', canRespond: true, localKeyAvailable: true };
  t.mock.method(ControlClient.prototype, 'result', async type => { assert.equal(type, 'interaction'); return record; });
  const inbox = createInteractions(f.store, { cliPath: cli, resolveHumanKey: () => assert.fail('잘못된 입력을 서명하면 안 된다'),
    readRemote: async () => ({ capability: { sourceInstanceId: 'option-inputs' }, records: [record] }) });
  await inbox.refreshProject(project);
  const item = inbox.snapshot().items.find(i => i.source === 'code-agent');
  for (const optionInputs of [null, [], { one: 3 }, { one: {} }, { one: 'x'.repeat(8001) }]) {
    await assert.rejects(inbox.respond(input(item, { answers: [{ questionId: 'Q1', optionIds: ['one'], optionInputs }] })), { code: 'invalid-input' });
  }
  assert.equal(f.store.list('interaction-command').length, 0);
});
