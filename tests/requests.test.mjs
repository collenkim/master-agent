import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { setup } from './helpers.mjs';
import { acceptRequest, continueRequest, runRequest, launchRequest, requestStatus } from '../packages/orchestrator/requests.mjs';
import { verificationFixture } from './verification-fixture.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { answerFor, planningSetup } from './planning-fixture.mjs';

test('service group membership is versioned; accepted requests keep their original scope and are idempotent', t => {
  const { store, engine, fixture } = setup(t);
  let group = engine.catalog.group({ id: 'service', name: '서비스', description: '유지보수 범위', projectIds: [] });
  group = engine.catalog.membership(group.id, fixture.projects[0].id, 'add', group.revision);
  group = engine.catalog.membership(group.id, fixture.projects[1].id, 'add', group.revision);
  assert.throws(() => engine.catalog.membership(group.id, fixture.projects[2].id, 'add', 1), { code: 'stale-state' });
  const input = { targetType: 'group', targetId: group.id, groupRevision: group.revision, goal: '두 서비스 수정', requestKey: 'stable' };
  const accepted = acceptRequest(store, input);
  engine.catalog.membership(group.id, fixture.projects[0].id, 'remove', group.revision);
  assert.deepEqual(accepted.request.projectIds, fixture.projects.slice(0, 2).map(p => p.id).sort());
  assert.equal(acceptRequest(store, input).created, false);
  assert.throws(() => acceptRequest(store, { ...input, goal: '다른 요청' }), { code: 'request-conflict' });
  assert.throws(() => acceptRequest(store, { ...input, requestKey: 'new' }), { code: 'stale-state' });
  const single = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[2].id, goal: '한 프로젝트 수정' });
  assert.deepEqual(single.request.projectIds, [fixture.projects[2].id]);
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
  const { request } = acceptRequest(f.store, { targetType, targetId: targetType === 'group' ? 'service' : 'one', goal: '값을 2로 변경', criteria: [{ id: 'value', description: '값이 2다' }], templates });
  const provider = { name: 'fixture-not-ai', model: 'fixture', async generate({ context }) {
    const answer = answerFor(context);
    answer.plan.tasks = tasks.map(task => ({ ...task, planAcknowledgements: [], coordination: '', references: context.projects.find(p => p.id === task.projectId).sources.map(s => s.id) }));
    return { data: answer };
  } };
  const inspect = f.host.inspect;
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
  const { request } = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[0].id, goal: '작업' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { host: {}, provider: {}, workflow: { async run() { await gate; throw Object.assign(new Error('근거를 준비하세요'), { code: 'missing-knowledge' }); } } };
  const running = runRequest(store, request.id, options);
  await assert.rejects(runRequest(store, request.id, options), { code: 'request-busy' });
  assert.throws(() => continueRequest(store, request.id, store.need('target-request', request.id).revision), { code: 'request-busy' });
  release(); const failed = await running;
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'missing-knowledge');
  assert.equal(continueRequest(store, request.id, failed.revision).id, request.id);
  assert.equal(requestStatus({ state: 'running', pid: 999999999, host: (await import('node:os')).hostname() }).state, 'interrupted');
});

test('detached CLI worker persists failures after launch, without a browser connection', async t => {
  const { store, fixture, db, root } = setup(t);
  const { request } = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[0].id, goal: '작업' });
  await launchRequest(store, request.id, { dbPath: db, cliPath: join(root, 'missing-code-agent.js') });
  let record;
  for (let i = 0; i < 100; i++) { record = store.need('target-request', request.id); if (record.state === 'failed') break; await delay(50); }
  assert.equal(record.state, 'failed'); assert.equal(record.error.code, 'invalid-cli');
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
    const input = { targetType: 'group', targetId: group.id, groupRevision: group.revision, goal: '요청', requestKey: 'web-stable' };
    assert.equal((await post('/api/requests', input)).status, 202);
    assert.equal((await post('/api/requests', input)).status, 202); assert.equal(launches, 1);
    assert.equal((await post('/api/requests', { targetType: 'project', targetId: fixture.projects[1].id, goal: '단일 요청' })).status, 202);
    assert.equal(launches, 2); assert.equal(store.list('target-request').length, 2);
  } finally { await dashboard.close(); }
});
