import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { SimulationRunner } from '../packages/runner/simulation.mjs';
import { setup, cleanup, temporary } from './helpers.mjs';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptRequest } from '../packages/orchestrator/requests.mjs';

const rejects = code => error => error.code === code;

test('M2: 이벤트 정리는 종료 30일 뒤에만 수행하고 판단 원본과 다른 목표를 보존한다', t => {
  const { engine, store, mission, fixture } = setup(t);
  assert.throws(() => engine.pruneEvents(mission.id, mission.revision), { code: 'invalid-state' });
  let m = engine.control(mission.id, 'cancel', mission.revision);
  assert.throws(() => engine.pruneEvents(m.id, m.revision), { code: 'retention-pending' });
  const old = new Date(Date.now() - 31 * 86400000).toISOString();
  m = store.put('mission', { ...m, finishedAt: old }, m.revision);
  store.db.prepare('UPDATE events SET at=? WHERE mission_id=?').run(old, m.id);
  const other = engine.create({ ...fixture.mission, requestKey: 'retention-other' });
  const otherEvents = store.events(other.id), decisions = engine.describe(m.id).decisions;
  store.event(m.id, 'recent', {});
  assert.throws(() => engine.pruneEvents(m.id, m.revision - 1), { code: 'stale-state' });
  const result = engine.pruneEvents(m.id, m.revision);
  assert.ok(result.deleted > 0);
  assert.ok(store.events(m.id).every(e => e.at > old));
  assert.ok(store.events(m.id).some(e => e.type === 'recent'));
  assert.deepEqual(store.events(other.id), otherEvents);
  assert.deepEqual(engine.describe(m.id).decisions.slice(0, decisions.length), decisions);
  assert.equal(engine.describe(m.id).decisions.at(-1).action, 'prune-events');
});

test('S1: 취소는 잠금·분석·복구 보류를 해제하고 프로젝트 등록 해제를 허용한다', t => {
  const { engine, store, mission } = setup(t);
  const ticket = engine.prepare(mission.id, mission.revision);
  let current = engine.markUnknown(mission.id, ticket.id, store.need('mission', mission.id).revision);
  current = store.put('mission', { ...current, planningHold: true, replanPending: true, recoveryHold: 'recovery' }, current.revision);
  store.put('analysis-run', { id: 'analysis', missionId: mission.id, status: 'running' });
  store.put('recovery-run', { id: 'recovery', missionId: mission.id, state: 'analyzing' });
  const cancelled = engine.control(mission.id, 'cancel', current.revision, undefined, { reason: '잘못 접수한 목표' });
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.reason, '잘못 접수한 목표');
  assert.equal(cancelled.planningHold, false); assert.equal(cancelled.replanPending, false);
  assert.equal(cancelled.recoveryHold, undefined);
  assert.equal(store.need('analysis-run', 'analysis').status, 'cancelled');
  assert.equal(store.need('recovery-run', 'recovery').state, 'cancelled');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM locks WHERE mission_id=?').get(mission.id).n, 0);
  assert.ok(engine.catalog.remove(ticket.projectId, store.need('project', ticket.projectId).revision).deletedAt);
  assert.equal(engine.describe(mission.id).nextAction, 'none');
});

test('S1: 취소한 목표의 TASK 번호는 새 요청에서 재사용하고 접수 키는 유지한다', t => {
  const { engine, store, fixture } = setup(t);
  const input = { targetType: 'project', targetId: fixture.projects[0].id, taskNumber: 'TASK-1', goal: '취소할 요청', requestKey: 'cancel-me' };
  const { request } = acceptRequest(store, input);
  const m = store.need('mission', request.id);
  engine.control(m.id, 'cancel', m.revision);
  assert.equal(store.need('target-request', m.id).state, 'cancelled');
  assert.equal(acceptRequest(store, input).request.id, m.id);
  assert.notEqual(acceptRequest(store, { ...input, requestKey: 'replacement' }).request.id, m.id);
});

test('S1: 실행 중 시도·오래된 revision·종료 목표 취소는 상태를 바꾸지 않는다', t => {
  const { engine, store, mission } = setup(t);
  const ticket = engine.prepare(mission.id, mission.revision);
  let m = store.need('mission', mission.id);
  m.attempts[0].mode = 'live'; m = store.put('mission', m, m.revision);
  assert.throws(() => engine.control(m.id, 'cancel', m.revision), e => e.code === 'invalid-state' && /mission stop.*mission unknown/.test(e.message));
  assert.ok(store.lock(ticket.projectId));
  m = engine.markUnknown(m.id, ticket.id, m.revision);
  assert.throws(() => engine.control(m.id, 'cancel', m.revision - 1), rejects('stale-state'));
  m = engine.control(m.id, 'cancel', m.revision);
  assert.throws(() => engine.control(m.id, 'cancel', m.revision), rejects('invalid-state'));
  for (const state of ['succeeded', 'simulation-complete']) {
    m = store.put('mission', { ...m, state }, m.revision);
    assert.throws(() => engine.control(m.id, 'cancel', m.revision), rejects('invalid-state'));
  }
});

test('세 프로젝트: 판단이 저장된 이후 실행하고 통합 증거로 모의 완료한다', async t => {
  const { engine, store, mission } = setup(t);
  const base = new SimulationRunner();
  const runner = { mode: 'simulation', async execute(ticket) {
    const decision = store.need('decision', ticket.decisionId);
    assert.equal(decision.action, 'dispatch');
    assert.equal(store.need('mission', mission.id).attempts.at(-1).id, ticket.id);
    assert.equal(store.lock(ticket.projectId).attempt_id, ticket.id);
    if (ticket.task.kind === 'integration') assert.equal(ticket.inputEvidence.length, 3);
    return base.execute(ticket);
  } };
  const result = await engine.run(mission.id, runner);
  assert.equal(result.state, 'simulation-complete');
  assert.equal(result.attempts.length, 4);
  assert.equal(result.evidence.length, 4);
  assert.ok(result.evidence.every(e => e.provenance === 'simulation'));
  assert.equal(result.nextAction, 'none');
  assert.ok(engine.catalog.status().every(p => p.execution === null));
  assert.ok(result.events.find(e => e.type === 'simulation-completed'));
});

test('같은 접수 키는 중복 생성하지 않고 다른 내용은 거부한다', t => {
  const { engine, fixture, mission } = setup(t);
  assert.equal(engine.create(fixture.mission).id, mission.id);
  assert.throws(() => engine.create({ ...fixture.mission, goal: '다른 요청' }), rejects('request-conflict'));
});

test('그룹 중복을 제거하며 접수 후 그룹 변경은 대상 스냅샷에 영향을 주지 않는다', t => {
  const { engine, fixture } = setup(t);
  engine.catalog.group({ id: 'overlap', name: '겹치는 그룹', projectIds: fixture.group.projectIds });
  const m = engine.create({ ...fixture.mission, requestKey: 'overlap', scope: { projectIds: [fixture.projects[0].id], groupIds: [fixture.group.id, 'overlap'] } });
  engine.catalog.group({ ...fixture.group, projectIds: [] }, 1);
  assert.equal(engine.describe(m.id).scope.projectIds.length, 3);
  assert.equal(engine.describe(m.id).scope.groups[0].projectIds.length, 3);
});

test('같은 실행 경로를 다른 프로젝트로 등록할 수 없다', t => {
  const { engine, fixture } = setup(t);
  assert.throws(() => engine.catalog.register({ ...fixture.projects[0], id: 'duplicate' }), rejects('duplicate-path'));
});

test('계획은 도메인·근거·범위·순환·검증 누락을 실행 전에 거부한다', t => {
  const { engine, fixture, mission, store } = setup(t, { plan: false });
  const cases = [
    ['domain-mismatch', p => p.tasks[0].domain = 'unrelated'],
    ['unknown-reference', p => p.tasks[0].references = ['invented']],
    ['out-of-scope', p => p.tasks[0].projectId = 'missing'],
    ['cyclic-plan', p => { p.tasks[0].dependsOn = [p.tasks[1].id]; p.tasks[1].dependsOn = [p.tasks[0].id]; }],
    ['missing-verification', p => p.tasks.pop()],
    ['missing-verification', p => p.tasks.at(-1).dependsOn = []],
    ['needs-review', p => p.unresolved = ['정책 미확인']],
  ];
  for (const [code, change] of cases) {
    const proposal = structuredClone(fixture.plan); change(proposal);
    assert.throws(() => engine.plan(mission.id, proposal, mission.revision), rejects(code), code);
  }
  assert.equal(store.list('decision').length, 0);
  assert.equal(engine.describe(mission.id).revision, 1);
});

test('기존 프로젝트 계획과 조정 내용을 대조해야 배정할 수 있다', t => {
  const { engine, fixture, mission } = setup(t, { plan: false });
  const project = fixture.projects[0];
  engine.catalog.updateKnowledge(project.id, { currentPlans: ['existing-plan@1'] }, 1);
  assert.throws(() => engine.plan(mission.id, fixture.plan, mission.revision), rejects('invalid-input'));
  const plan = structuredClone(fixture.plan);
  for (const task of plan.tasks.filter(t => t.projectId === project.id)) {
    task.planAcknowledgements = ['existing-plan@1']; task.coordination = '기존 작업 이후 모의 실행으로 충돌을 피함';
  }
  assert.equal(engine.plan(mission.id, plan, mission.revision).state, 'planned');
});

test('판단 기록 저장 실패는 실행 시도·잠금·이벤트를 남기지 않는다', async t => {
  const { engine, store, mission } = setup(t);
  const before = engine.describe(mission.id);
  const original = store.put.bind(store);
  store.put = (kind, ...args) => { if (kind === 'decision') throw new Error('disk-full'); return original(kind, ...args); };
  let calls = 0;
  await assert.rejects(engine.step(mission.id, { mode: 'simulation', execute() { calls++; } }), /disk-full/);
  assert.equal(calls, 0);
  assert.deepEqual(engine.describe(mission.id), before);
  assert.ok(engine.catalog.status().every(p => !p.execution));
});

test('계획 뒤 프로젝트 지식 변경은 자동 배정을 차단하고 재계획을 요구한다', async t => {
  const { engine, fixture, mission } = setup(t);
  engine.catalog.updateKnowledge(fixture.projects[0].id, { constraints: ['계약 변경'] }, 1);
  const result = await engine.run(mission.id, new SimulationRunner());
  assert.equal(result.state, 'blocked');
  assert.equal(result.attempts.length, 0);
  assert.equal(result.nextAction, 'replan-project-changed');
});

test('실행 중 지식 변경은 결과를 격리하고 프로젝트 잠금을 유지한다', async t => {
  const { engine, fixture, mission, store } = setup(t);
  const ticket = engine.prepare(mission.id, mission.revision);
  engine.catalog.updateKnowledge(fixture.projects[0].id, { constraints: ['변경'] }, 1);
  const result = engine.accept(ticket, await new SimulationRunner().execute(ticket));
  assert.equal(result.tasks[0].state, 'unknown');
  assert.equal(store.list('evidence').length, 0);
  assert.ok(store.lock(ticket.projectId));
});

test('일부 실패해도 독립 작업은 실행하며 실패한 작업만 새 시도로 재시도한다', async t => {
  const { engine, mission } = setup(t);
  let result = await engine.run(mission.id, new SimulationRunner({ failTaskIds: ['implement-payment'] }));
  assert.equal(result.attempts.length, 3);
  assert.equal(result.tasks.find(t => t.id === 'integrate').state, 'queued');
  engine.control(mission.id, 'retry', result.revision, 'implement-payment');
  result = await engine.run(mission.id, new SimulationRunner());
  assert.equal(result.state, 'simulation-complete');
  assert.equal(result.attempts.filter(a => a.taskId === 'implement-order').length, 1);
  assert.equal(result.attempts.filter(a => a.taskId === 'implement-payment').length, 2);
});

test('실패한 통합 검증은 프로젝트별 성공과 무관하게 완료를 막는다', async t => {
  const { engine, mission } = setup(t);
  const result = await engine.run(mission.id, new SimulationRunner({ failTaskIds: ['integrate'] }));
  assert.equal(result.state, 'blocked');
  assert.throws(() => engine.complete(mission.id, result.revision), rejects('incomplete'));
});

test('중복 결과와 재시도 이후 늦은 결과는 현재 상태를 바꾸지 않는다', async t => {
  const { engine, mission } = setup(t);
  const runner = new SimulationRunner({ failTaskIds: ['implement-order'] });
  const old = engine.prepare(mission.id, mission.revision);
  const outcome = await runner.execute(old);
  let result = engine.accept(old, outcome);
  assert.throws(() => engine.accept(old, outcome), rejects('stale-result'));
  result = engine.control(mission.id, 'retry', result.revision, old.taskId);
  const fresh = engine.prepare(mission.id, result.revision);
  const before = engine.describe(mission.id);
  assert.throws(() => engine.accept(old, outcome), rejects('stale-result'));
  assert.deepEqual(engine.describe(mission.id), before);
  assert.notEqual(old.id, fresh.id);
});

test('두 master 연결이 같은 프로젝트를 동시에 배정하지 않는다', t => {
  const { engine, fixture, mission, db } = setup(t);
  const second = new Store(db); cleanup(t, () => second.close());
  const other = new Engine(second);
  const locked = engine.prepare(mission.id, mission.revision);
  let m2 = other.create({ ...fixture.mission, requestKey: 'second' });
  m2 = other.plan(m2.id, fixture.plan, m2.revision);
  const different = other.prepare(m2.id, m2.revision);
  assert.notEqual(different.projectId, locked.projectId);
  assert.throws(() => other.prepare(mission.id, mission.revision), rejects('stale-state'));
});

test('일시 정지는 새 배정을 막고 도착한 결과를 보존한다', async t => {
  const { engine, mission } = setup(t);
  const ticket = engine.prepare(mission.id, mission.revision);
  let m = engine.describe(mission.id);
  m = engine.control(m.id, 'pause', m.revision);
  assert.equal((await engine.step(m.id, new SimulationRunner())).progressed, false);
  m = engine.accept(ticket, await new SimulationRunner().execute(ticket));
  assert.equal(m.state, 'paused');
  assert.equal(m.tasks[0].state, 'succeeded');
  m = engine.control(m.id, 'resume', m.revision);
  assert.equal((await engine.run(m.id, new SimulationRunner())).state, 'simulation-complete');
});

test('재시작은 실행 중 시도를 자동 재배정하지 않는다', async t => {
  const { engine, mission, db, close } = setup(t);
  const ticket = engine.prepare(mission.id, mission.revision);
  close();
  const reopened = new Store(db); cleanup(t, () => reopened.close());
  const next = new Engine(reopened);
  let m = next.describe(mission.id);
  assert.equal(m.attempts[0].id, ticket.id);
  assert.ok(reopened.lock(ticket.projectId));
  m = next.markUnknown(m.id, ticket.id, m.revision);
  assert.throws(() => next.control(m.id, 'retry', m.revision, ticket.taskId), rejects('invalid-state'));
  await next.run(m.id, new SimulationRunner());
  assert.equal(next.describe(m.id).attempts.filter(a => a.taskId === ticket.taskId).length, 1);
});

test('러너 예외는 실패로 추정하지 않고 미확인 상태를 보존한다', async t => {
  const { engine, mission, store } = setup(t);
  const result = await engine.step(mission.id, { mode: 'simulation', execute() { throw new Error('connection-lost'); } });
  assert.equal(result.mission.tasks[0].state, 'unknown');
  assert.ok(store.lock(result.mission.attempts[0].projectId));
});

test('유효하지 않은 결과는 성공으로 수용하지 않는다', t => {
  const { engine, mission } = setup(t);
  const ticket = engine.prepare(mission.id, mission.revision);
  const result = engine.accept(ticket, { schemaVersion: 1, mode: 'simulation', status: 'succeeded', summary: '완료', artifacts: [], checks: [] });
  assert.equal(result.tasks[0].state, 'unknown');
});

test('재계획은 이전 시도·판단을 보존하고 증거를 새 계획에서 재사용하지 않는다', async t => {
  const { engine, fixture, mission } = setup(t);
  await engine.step(mission.id, new SimulationRunner());
  const before = engine.describe(mission.id);
  const m = engine.plan(mission.id, { ...fixture.plan, summary: '새 계획' }, before.revision);
  assert.equal(m.plans.length, 2);
  assert.equal(m.attempts.length, 1);
  assert.ok(m.tasks.every(t => t.evidenceIds.length === 0));
  const result = await engine.run(mission.id, new SimulationRunner());
  assert.equal(result.state, 'simulation-complete');
  assert.equal(result.evidence.length, 5);
});

test('증거 변조 시 완료를 거부한다', async t => {
  const { engine, mission, store } = setup(t);
  for (let i = 0; i < 4; i++) await engine.step(mission.id, new SimulationRunner());
  const evidence = store.list('evidence')[0];
  store.put('evidence', { ...evidence, contents: 'tampered' }, evidence.revision);
  const m = engine.describe(mission.id);
  assert.throws(() => engine.complete(m.id, m.revision), rejects('stale-evidence'));
});

test('실제 목표에 모의 러너를 사용해 개발 완료를 위장할 수 없다', async t => {
  const { engine, fixture } = setup(t);
  let m = engine.create({ ...fixture.mission, mode: 'live', requestKey: 'live' });
  m = engine.plan(m.id, fixture.plan, m.revision);
  await assert.rejects(engine.run(m.id, new SimulationRunner()), rejects('live-runner-unavailable'));
  assert.equal(engine.describe(m.id).attempts.length, 0);
});

test('다른 CLI 가 쓰는 동안 같은 DB 의 트랜잭션은 실패하지 않고 잠금이 풀리기를 기다린다', async t => {
  const root = temporary(t), db = join(root, 'shared.db');
  const holder = new Store(db);
  cleanup(t, () => holder.close());
  holder.db.exec('BEGIN IMMEDIATE');
  const script = `import { Store } from ${JSON.stringify(pathToFileURL(resolve('packages/storage/store.mjs')).href)};
const s = new Store(${JSON.stringify(db)}); s.transaction(() => s.put('probe', { id: 'p' })); s.close(); console.log('ok');`;
  const child = new Promise((done, fail) => execFile(process.execPath, ['--input-type=module', '-e', script], (error, stdout) => error ? fail(error) : done(stdout.trim())));
  await new Promise(r => setTimeout(r, 500));
  holder.db.exec('COMMIT');
  assert.equal(await child, 'ok');
  assert.equal(holder.get('probe', 'p').id, 'p');
});
