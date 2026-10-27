import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { setup } from './helpers.mjs';
import { acceptRequest, continueRequest, runRequest, launchRequest, requestStatus, resetRequest } from '../packages/orchestrator/requests.mjs';
import { LEASE_TTL_MS } from '../packages/orchestrator/lease.mjs';
import { verificationFixture } from './verification-fixture.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { answerFor, planningSetup } from './planning-fixture.mjs';
import { hostPrompt } from '../packages/runner/host-context.mjs';

test('M1: request reset은 확인·버전·로컬 생존을 검사하고 같은 요청을 대기로 돌린다', t => {
  const f = setup(t), id = acceptRequest(f.store, { targetType: 'project', targetId: f.fixture.projects[0].id, goal: '복구할 요청' }).request.id;
  let r = f.store.need('target-request', id);
  r = f.store.put('target-request', { ...r, state: 'running', owner: 'lost', host: 'another-host', pid: 123,
    heartbeatAt: new Date().toISOString() }, r.revision);
  assert.throws(() => resetRequest(f.store, id, r.revision), { code: 'invalid-input' });
  assert.throws(() => resetRequest(f.store, id, r.revision - 1, { confirm: true }), { code: 'stale-state' });
  assert.throws(() => continueRequest(f.store, id, r.revision), { code: 'request-busy' });
  r = resetRequest(f.store, id, r.revision, { confirm: true });
  assert.equal(r.state, 'queued'); assert.equal(r.pid, null); assert.equal(r.owner, null);
  assert.ok(f.store.list('decision').some(d => d.action === 'reset-request' && d.actor === 'operator'));
  r = f.store.put('target-request', { ...r, state: 'running', host: hostname(), pid: process.pid }, r.revision);
  assert.throws(() => resetRequest(f.store, id, r.revision, { confirm: true }), { code: 'request-busy' });
});

test('M1: 다른 호스트의 오래된 요청 실행은 회수하고 최근 heartbeat는 계속 차단한다', async t => {
  const f = setup(t), id = acceptRequest(f.store, { targetType: 'project', targetId: f.fixture.projects[0].id, goal: '임대 만료' }).request.id;
  let r = f.store.need('target-request', id);
  r = f.store.put('target-request', { ...r, state: 'running', host: 'another-host', pid: 123, owner: 'lost', heartbeatAt: new Date().toISOString() }, r.revision);
  await assert.rejects(runRequest(f.store, id, { host: {}, provider: {}, workflow: {} }), { code: 'request-busy' });
  r = f.store.put('target-request', { ...r, heartbeatAt: new Date(Date.now() - LEASE_TTL_MS - 1).toISOString() }, r.revision);
  assert.equal(requestStatus(r).state, 'interrupted');
  const result = await runRequest(f.store, id, { host: {}, provider: {}, workflow: { async run() {
    const active = f.store.need('target-request', id);
    assert.equal(active.pid, process.pid); assert.ok(Date.parse(active.heartbeatAt) > Date.parse(r.heartbeatAt));
    return { blockers: ['fixture-wait'] };
  } } });
  assert.equal(result.state, 'waiting');
  assert.ok(f.store.events(id).some(e => e.type === 'request-lease-reclaimed' && e.reason === 'expired'));
});

test('service group membership is versioned; accepted requests keep their original scope and are idempotent', t => {
  const { store, engine, fixture } = setup(t);
  let group = engine.catalog.group({ id: 'service', name: '서비스', description: '유지보수 범위', projectIds: [] });
  group = engine.catalog.membership(group.id, fixture.projects[0].id, 'add', group.revision);
  group = engine.catalog.membership(group.id, fixture.projects[1].id, 'add', group.revision);
  assert.throws(() => engine.catalog.membership(group.id, fixture.projects[2].id, 'add', 1), { code: 'stale-state' });
  const input = { targetType: 'group', targetId: group.id, groupRevision: group.revision, goal: '두 서비스 수정', taskNumber: 'UZRF-392', requestKey: 'stable' };
  const accepted = acceptRequest(store, input);
  engine.catalog.membership(group.id, fixture.projects[0].id, 'remove', group.revision);
  assert.deepEqual(accepted.request.projectIds, fixture.projects.slice(0, 2).map(p => p.id).sort());
  assert.equal(acceptRequest(store, input).created, false);
  assert.equal(accepted.request.taskNumber, 'UZRF-392');
  assert.equal(store.need('mission', accepted.request.id).taskNumber, 'UZRF-392');
  assert.throws(() => acceptRequest(store, { ...input, taskNumber: 'UZRF-393' }), { code: 'request-conflict' });
  assert.throws(() => acceptRequest(store, { ...input, goal: '다른 요청' }), { code: 'request-conflict' });
  assert.throws(() => acceptRequest(store, { ...input, requestKey: 'new' }), { code: 'stale-state' });
  const single = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[2].id, goal: '한 프로젝트 수정' });
  assert.deepEqual(single.request.projectIds, [fixture.projects[2].id]);
  assert.equal(Object.hasOwn(single.request, 'taskNumber'), false);
  for (const taskNumber of ['', 'hello world', '../work', 'x'.repeat(65), 392, null]) {
    assert.throws(() => acceptRequest(store, { targetType: 'project', targetId: fixture.projects[2].id, goal: '잘못된 번호', taskNumber }), { code: 'invalid-input' });
  }
  engine.catalog.group({ id: 'empty', name: '빈 그룹', projectIds: [] });
  assert.throws(() => acceptRequest(store, { targetType: 'group', targetId: 'empty', goal: '수정' }), { code: 'empty-scope' });
});

for (const targetType of ['group', 'project']) test(`${targetType} requests execute the real workflow, checks and handoff to completion`, async t => {
  const f = verificationFixture(t);
  f.engine.catalog.group({ id: 'service', name: '통합 서비스', projectIds: ['one', 'two'] });
  const tasks = structuredClone(targetType === 'group' ? f.tasks : [f.tasks[0], { ...f.tasks[2], dependsOn: ['edit-one'] }]);
  const templates = tasks.map(task => {
    const recipe = structuredClone(f.recipes.find(r => r.taskId === task.id));
    if (targetType === 'project') recipe.checks = recipe.checks.filter(c => c.id === 'check-one');
    return { id: `template-${task.id}`, projectId: task.projectId, domain: task.domain, kinds: [task.kind], criteria: task.criteria, outputs: task.outputs, recipe };
  });
  const { request } = acceptRequest(f.store, { targetType, targetId: targetType === 'group' ? 'service' : 'one', goal: '값을 2로 변경', taskNumber: 'UZRF-392', criteria: [{ id: 'value', description: '값이 2다' }], templates });
  const provider = { name: 'fixture-not-ai', model: 'fixture', async generate({ context }) {
    assert.equal(context.mission.taskNumber, 'UZRF-392');
    const answer = answerFor(context);
    answer.plan.tasks = tasks.map(task => ({ ...task, planAcknowledgements: [], coordination: '', references: context.projects.find(p => p.id === task.projectId).sources.map(s => s.id) }));
    return { data: answer };
  } };
  const inspect = f.host.inspect;
  const execute = f.host.execute;
  f.host.execute = async (ticket, options) => {
    assert.equal(ticket.taskNumber, 'UZRF-392');
    assert.notEqual(ticket.codeAgentWorkId, ticket.taskNumber);
    assert.match(hostPrompt(ticket), /"taskNumber": "UZRF-392"/);
    return execute(ticket, options);
  };
  f.host.inspect = async project => {
    const attempt = f.store.need('mission', request.id).attempts.filter(a => a.projectId === project.id).at(-1);
    if (attempt?.state === 'verified') Object.assign(f.states[project.id], { work: null, request: null, resume: { code: 'no-work' }, stateVersion: `ended-${attempt.id}` });
    return inspect(project);
  };
  const completed = await runRequest(f.store, request.id, { host: f.host, provider });
  assert.equal(completed.state, 'completed');
  assert.equal(f.store.need('mission', request.id).state, 'succeeded');
  assert.ok(f.store.need('mission', request.id).plans[0].analysisId);
  assert.equal(f.store.need('mission', request.id).attempts.length, targetType === 'group' ? 3 : 2);
  assert.match(readFileSync(join(f.projects[1].path, 'source.mjs'), 'utf8'), targetType === 'group' ? /value = 2/ : /value = 1/);
  await assert.rejects(runRequest(f.store, request.id, { host: f.host, provider: {} }), { code: 'request-busy' });
});

test('automatic polling does not invalidate a plan, but actual state changes still do', async t => {
  const { store, planner, mission, fixture } = planningSetup(t);
  const p = fixture.projects[0];
  store.put('observation', { id: p.id, status: 'observed', state: { stateVersion: 'stable', work: null, resume: { code: 'no-work' } } });
  const provider = { name: 'fixture', async generate({ context }) {
    const observation = store.need('observation', p.id);
    store.put('observation', { ...observation, recordedAt: new Date().toISOString() }, observation.revision);
    return { data: answerFor(context) };
  } };
  assert.equal((await planner.analyze(mission.id, provider, { expectedRevision: mission.revision })).mission.state, 'planned');
  const context = planner.context(store.need('mission', mission.id));
  const observation = store.need('observation', p.id);
  store.put('observation', { ...observation, state: { ...observation.state, stateVersion: 'changed' } }, observation.revision);
  assert.throws(() => planner.assertContext(context), { code: 'stale-context' });
});

test('worker claim excludes duplicates and failure/continue preserve the same mission', async t => {
  const { store, fixture } = setup(t);
  const { request } = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[0].id, goal: '작업', taskNumber: 'TASK-77' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { host: {}, provider: {}, workflow: { async run() { await gate; throw Object.assign(new Error('근거를 준비하세요'), { code: 'missing-knowledge' }); } } };
  const running = runRequest(store, request.id, options);
  await assert.rejects(runRequest(store, request.id, options), { code: 'request-busy' });
  assert.throws(() => continueRequest(store, request.id, store.need('target-request', request.id).revision), { code: 'request-busy' });
  release(); const failed = await running;
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'missing-knowledge');
  const continued = continueRequest(store, request.id, failed.revision);
  assert.equal(continued.id, request.id); assert.equal(continued.taskNumber, 'TASK-77');
  assert.equal(requestStatus({ state: 'running', pid: 999999999, host: (await import('node:os')).hostname() }).state, 'interrupted');
});

test('detached CLI worker preserves installation problems as preparation waits without a browser connection', async t => {
  const { store, fixture, db, root } = setup(t);
  const { request } = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[0].id, goal: '작업' });
  await launchRequest(store, request.id, { dbPath: db, cliPath: join(root, 'missing-code-agent.js') });
  let record;
  for (let i = 0; i < 100; i++) { record = store.need('target-request', request.id); if (record.state === 'waiting') break; await delay(50); }
  assert.equal(record.state, 'waiting'); assert.equal(record.error, null);
  assert.equal(record.preparation.issues[0].code, 'invalid-cli');
  await delay(100);
});

test('dashboard authenticates writes, edits membership and submits group/project requests once', async t => {
  const { db, fixture, store } = setup(t); let launches = 0;
  const dashboard = await startDashboard({ dbPath: db, port: 0, observe: false, launch: async (store, id) => { launches++; return store.need('target-request', id); } });
  try {
    const overview = await (await fetch(dashboard.url + '/api/overview')).json();
    const post = (path, body, token = overview.token) => fetch(dashboard.url + path, { method: 'POST', headers: { Origin: dashboard.url, 'Content-Type': 'application/json', 'X-Master-Token': token }, body: JSON.stringify(body) });
    const groupInput = { group: { id: 'service', name: '서비스', description: '유지보수', projectIds: [fixture.projects[0].id] }, revision: 0 };
    assert.equal((await post('/api/groups', groupInput, 'wrong')).status, 403);
    const group = await (await post('/api/groups', groupInput)).json(); assert.equal(group.revision, 1);
    assert.equal((await post('/api/groups', { ...groupInput, revision: 99 })).status, 409);
    const input = { targetType: 'group', targetId: group.id, groupRevision: group.revision, goal: '요청', taskNumber: 'WEB-1', requestKey: 'web-stable' };
    assert.equal((await post('/api/requests', input)).status, 202);
    assert.equal((await post('/api/requests', input)).status, 202); assert.equal(launches, 1);
    assert.equal((await post('/api/requests', { targetType: 'project', targetId: fixture.projects[1].id, goal: '단일 요청' })).status, 202);
    assert.equal(launches, 2); assert.equal(store.list('target-request').length, 2);
    const updated = await (await fetch(dashboard.url + '/api/overview')).json();
    assert.equal(updated.requests.find(r => r.targetType === 'group').taskNumber, 'WEB-1');
  } finally { await dashboard.close(); }
});

test('L2: 호스트 오류 원문은 요청 DB 대신 로그의 첫 줄에만 남긴다', async t => {
  const { store, fixture, root } = setup(t), lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  const { request } = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[0].id, goal: '오류 진단' });
  const result = await runRequest(store, request.id, { host: {}, provider: {}, workflow: { async run() {
    throw Object.assign(new Error('private host detail\nprivate second line'), { code: 'EHOST' });
  } } });
  assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'EHOST');
  assert.ok(!JSON.stringify(store.db.prepare('SELECT body FROM records').all()).includes('private'));
  assert.deepEqual(lines, ['[EHOST] Error: private host detail']);
  const log = readFileSync(join(root, 'request-logs', request.id + '.log'), 'utf8');
  assert.match(log, /\[EHOST\] Error: private host detail/);
  assert.ok(!log.includes('private second line'));
});

test('L5: 동시 launch는 시작 전에 하나만 예약하고 실행기를 한 번 시작한다', async t => {
  const { store, fixture, db, root } = setup(t);
  const { request } = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[0].id, goal: '동시 시작' });
  const options = { dbPath: db, cliPath: join(root, 'missing-code-agent.js') };
  const results = await Promise.allSettled([launchRequest(store, request.id, options), launchRequest(store, request.id, options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'request-busy');
  let record;
  for (let i = 0; i < 100; i++) { record = store.need('target-request', request.id); if (record.state === 'waiting') break; await delay(50); }
  assert.equal(record.state, 'waiting'); assert.equal(record.launchId, null);
  assert.equal(record.preparation.issues[0].code, 'invalid-cli');
  await delay(100);
});

test('L5: 초기화한 예약의 늦은 실행기는 거부하고 현재 예약과 만료된 시작 임대만 인수한다', async t => {
  const { store, fixture } = setup(t);
  const { request } = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[0].id, goal: '예약 대조' });
  let record = store.put('target-request', { ...request, state: 'launching', launchId: 'old-launch', pid: null,
    host: hostname(), heartbeatAt: new Date().toISOString() }, request.revision);
  let calls = 0;
  const options = { host: {}, provider: {}, workflow: { async run() { calls++; return { blockers: [] }; } } };
  await assert.rejects(runRequest(store, request.id, options), { code: 'request-busy' });
  await assert.rejects(runRequest(store, request.id, { ...options, launchId: 'wrong-launch' }), { code: 'request-busy' });
  record = resetRequest(store, request.id, record.revision, { confirm: true });
  assert.equal(record.launchId, null);
  await assert.rejects(runRequest(store, request.id, { ...options, launchId: 'old-launch' }), { code: 'request-busy' });
  assert.equal(calls, 0);
  record = store.put('target-request', { ...record, state: 'launching', launchId: 'current-launch', pid: null,
    host: hostname(), heartbeatAt: new Date().toISOString() }, record.revision);
  record = await runRequest(store, request.id, { ...options, launchId: 'current-launch' });
  assert.equal(record.state, 'waiting'); assert.equal(record.launchId, null); assert.equal(calls, 1);
  store.put('target-request', { ...record, state: 'launching', launchId: 'expired-launch', pid: null,
    heartbeatAt: new Date(Date.now() - LEASE_TTL_MS - 1).toISOString() }, record.revision);
  assert.equal((await runRequest(store, request.id, options)).state, 'waiting');
  assert.equal(calls, 2);
  assert.ok(store.events(request.id).some(e => e.type === 'request-lease-reclaimed' && e.reason === 'expired'));
});
