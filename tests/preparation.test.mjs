import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';
import { prepareRequest } from '../packages/orchestrator/preparation.mjs';
import { acceptRequest, runRequest, continueRequest } from '../packages/orchestrator/requests.mjs';
import { createInteractions } from '../packages/dashboard/interactions.mjs';
import { dashboardSnapshot } from '../packages/dashboard/monitor.mjs';
import { Planner } from '../packages/reasoning/planner.mjs';
import { answerFor } from './planning-fixture.mjs';

const accepted = f => acceptRequest(f.store, { targetType: 'project', targetId: f.fixture.projects[0].id, goal: '새 프로젝트를 구성한다', taskNumber: 'NEW-1' }).request;
const input = item => ({ id: item.id, revision: item.revision, contentHash: item.contentHash, context: item.context,
  commandId: randomUUID(), action: 'answer', optionIds: ['recheck'], custom: '', resume: true });
const observed = async () => ({ status: 'observed' });

test('empty project planning uses real inventory, excludes hidden credentials, and detects later changes', async t => {
  const f = setup(t, { plan: false }), p = f.fixture.projects[0], request = accepted(f), k = new Knowledge(f.store);
  writeFileSync(join(p.path, '.env'), 'TOKEN=DO-NOT-READ');
  mkdirSync(join(p.path, '.code-agent'));
  const snapshot = k.prepare(p.id), revision = f.store.need('project', p.id).revision;
  assert.equal(snapshot.sources[0].origin, 'directory-inventory');
  assert.equal(snapshot.sources[0].kind, 'code');
  assert.equal(snapshot.sources[0].content.includes('DO-NOT-READ'), false);
  assert.equal(snapshot.sources[0].content.includes('.env'), false);
  k.prepare(p.id); assert.equal(f.store.need('project', p.id).revision, revision);
  const planner = new Planner(f.store);
  const result = await planner.analyze(request.id, { name: 'fixture', async generate({ context }) { return { data: answerFor(context) }; } }, { expectedRevision: 1 });
  assert.equal(result.mission.state, 'planned');
  writeFileSync(join(p.path, 'package.json'), '{"name":"new-service"}');
  assert.throws(() => k.assertFresh(snapshot), { code: 'stale-knowledge' });
});

test('standard sources are bounded and stale explicit policies are not replaced with inventory', t => {
  const f = setup(t), p = f.fixture.projects[0], k = new Knowledge(f.store);
  writeFileSync(join(p.path, 'README.md'), '# Service');
  writeFileSync(join(p.path, 'package.json'), '{"name":"service"}');
  assert.deepEqual(k.prepare(p.id).sources.map(s => s.path), ['README.md', 'package.json']);
  unlinkSync(join(p.path, 'README.md'));
  assert.throws(() => k.prepare(p.id));
  const other = f.fixture.projects[1];
  writeFileSync(join(other.path, 'README.md'), 'x'.repeat(65537));
  assert.throws(() => k.prepare(other.id), { code: 'source-too-large' });
  assert.equal(f.store.need('project', other.id).knowledgeSnapshotId, undefined);
});

test('preparation collects all project issues without installing, granting or invoking a development host', async t => {
  const f = setup(t), request = acceptRequest(f.store, { targetType: 'group', targetId: f.fixture.group.id, goal: '준비' }).request;
  const report = await prepareRequest(f.store, request, { observe: observed });
  assert.equal(report.state, 'waiting');
  for (const projectId of request.projectIds) {
    assert.ok(report.issues.some(i => i.projectId === projectId && i.code === 'host-not-installed'));
    assert.ok(report.issues.some(i => i.projectId === projectId && i.code === 'control-not-bound'));
    assert.ok(f.store.need('project', projectId).knowledgeSnapshotId);
  }
  assert.equal(f.store.list('control-run').length, 0);
  assert.equal(f.store.list('control-binding').length, 0);
});

test('saved binding is insufficient: preparation checks live ownership/generation and authenticates', async t => {
  const f = setup(t), request = accepted(f), p = f.fixture.projects[0];
  f.store.put('control-binding', { id: p.id, owner: true, controller: 'master', generation: 1 });
  const calls = [];
  let generation = 2, failAuth = false;
  const clientFor = () => ({ async result(type) {
    calls.push(type);
    if (type === 'hello') return { versions: [1], hosts: [{ kind: 'codex', supported: true }], project: { enabled: true }, ownership: { controller: 'master', generation } };
    if (failAuth) throw Object.assign(new Error('token access denied'), { code: 'control-unauthorized' });
    return {};
  } });
  const options = { observe: observed, checkHost() {}, clientFor };
  assert.equal((await prepareRequest(f.store, request, options)).issues[0].code, 'control-not-owner');
  assert.deepEqual(calls, ['hello']);
  generation = 1; failAuth = true;
  assert.equal((await prepareRequest(f.store, request, options)).issues[0].code, 'control-unauthorized');
  failAuth = false;
  assert.equal((await prepareRequest(f.store, request, options)).state, 'ready');
});

test('worker holds preparation before model calls and rechecks on the same TASK before workflow', async t => {
  const f = setup(t), request = accepted(f), cliPath = join(f.root, 'fixture.mjs');
  writeFileSync(cliPath, '');
  let ready = false, runs = 0;
  const options = { cliPath, prepare: (store, request) => prepareRequest(store, request, { observe: observed, checkHost() {},
    clientFor: () => ({ async result(type) { return type === 'hello' ? { versions: [1], hosts: [{ kind: 'codex', supported: true }], project: { enabled: true }, ownership: { controller: 'master', generation: 1 } } : {}; } }) }),
    provider: { name: 'fixture' }, workflow: { async run() { runs++; assert.equal(ready, true); return { blockers: [] }; } } };
  const waiting = await runRequest(f.store, request.id, options);
  assert.equal(waiting.state, 'waiting'); assert.equal(runs, 0);
  assert.equal(dashboardSnapshot(f.store).missions.find(m => m.id === request.id).status, 'setup-required');
  assert.equal(dashboardSnapshot(f.store).projects.find(p => p.id === request.targetId).attention, true);
  f.store.put('control-binding', { id: request.targetId, controller: 'master', generation: 1, owner: true });
  continueRequest(f.store, request.id, waiting.revision); ready = true;
  const next = await runRequest(f.store, request.id, options);
  assert.equal(next.id, request.id); assert.equal(next.taskNumber, 'NEW-1'); assert.equal(runs, 1);
  assert.equal(next.preparation.state, 'ready');
});

test('legacy failed requests enter the inbox; defer/recheck/stale/replay preserve one request and launch once', async t => {
  const f = setup(t), request = accepted(f);
  f.store.put('target-request', { ...request, state: 'failed', error: { code: 'missing-knowledge', message: '먼저 근거를 수집하세요.' } }, request.revision);
  let launches = 0;
  const inbox = createInteractions(f.store, { launch: async (store, id) => { launches++; return store.need('target-request', id); } });
  let item = inbox.snapshot().items.find(i => i.handler === 'preparation');
  assert.deepEqual(item.recommendedOptionIds, ['recheck']);
  assert.equal(dashboardSnapshot(f.store).missions.find(m => m.id === request.id).status, 'blocked');
  await inbox.respond({ ...input(item), action: 'defer' }); assert.equal(launches, 0);
  item = inbox.snapshot().items.find(i => i.id === item.id); assert.equal(item.state, 'deferred');
  const body = input(item);
  await inbox.respond(body); await inbox.respond(body);
  assert.equal(launches, 1); assert.equal(f.store.list('target-request').length, 1);
  await assert.rejects(inbox.respond({ ...body, commandId: randomUUID() }), { code: 'stale-question' });
  const updated = f.store.need('target-request', request.id);
  f.store.put('target-request', { ...updated, state: 'waiting', preparation: { state: 'waiting', issues: [{ projectId: request.targetId, code: 'control-not-bound', message: '연결 필요', guidance: '연결 후 재검사' }] } }, updated.revision);
  const reopened = inbox.snapshot().items.find(i => i.handler === 'preparation' && i.state === 'open');
  assert.ok(reopened); assert.notEqual(reopened.id, item.id);
});

test('a missing verification contract becomes an actionable setup request without inventing checks', async t => {
  const f = setup(t), request = accepted(f);
  const result = await runRequest(f.store, request.id, { host: {}, provider: {}, workflow: { async run() { return { blockers: ['new-task:missing-verification-recipe', 'other:remote-needs-human'] }; } } });
  assert.equal(result.state, 'waiting');
  assert.equal(result.preparation.issues[0].code, 'missing-verification-recipe');
  assert.ok(result.blockers.includes('other:remote-needs-human'));
  assert.equal(f.store.need('mission', request.id).verificationRecipes, undefined);
  const item = createInteractions(f.store).snapshot().items.find(i => i.handler === 'preparation');
  assert.ok(item.body.includes('mission verification'));
  assert.equal(item.taskNumber, 'NEW-1');
});
