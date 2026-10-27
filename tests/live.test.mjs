import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers.mjs';
import { LiveExecution } from '../packages/orchestrator/live.mjs';
import { inspectState } from '../packages/runner/host-context.mjs';
import { Planner } from '../packages/reasoning/planner.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';

function fixture(t) {
  const f = setup(t, { plan: false });
  for (const p of f.store.list('project')) f.engine.catalog.updateKnowledge(p.id, { capabilities: ['code-agent:claude'] }, p.revision);
  const proposal = structuredClone(f.fixture.plan);
  for (const task of proposal.tasks) task.requiredCapabilities = ['code-agent:claude'];
  let mission = f.engine.create({ ...f.fixture.mission, mode: 'live', requestKey: 'live-test' });
  mission = f.engine.plan(mission.id, proposal, mission.revision);
  const state = { schema: 'code-agent.state', schemaVersion: 1, stateVersion: 'v1', observedAt: new Date().toISOString(),
    repo: { root: f.store.need('project', proposal.tasks[0].projectId).path }, work: null, request: null,
    ownership: { process: 'unverified', lease: { state: 'none' } }, consents: { readable: true, open: [] },
    questions: null, unknown: [], resume: { code: 'no-work', reasons: [] } };
  const host = { mode: 'live', name: 'code-agent', transport: 'code-agent-master', calls: 0,
    async inspect() { return structuredClone(state); },
    async execute(ticket) {
      host.calls++;
      assert.equal(f.store.need('decision', ticket.decisionId).action, host.calls === 1 ? 'dispatch-live' : 'continue-live');
      assert.equal(f.store.lock(ticket.projectId).attempt_id, ticket.id);
      state.work = { id: ticket.codeAgentWorkId, phase: 'implement' }; state.resume.code = 'ready'; state.stateVersion = `v${host.calls + 1}`;
      return { status: 'returned', summary: '모델의 완료 주장', sessionId: 'session-test', permissionDenials: [] };
    } };
  return { ...f, mission, proposal, state, host, live: new LiveExecution(f.store), taskId: proposal.tasks[0].id,
    options: { expectedRevision: mission.revision, expectedState: 'v1' } };
}

test('M2: 회차에는 원격 상태 요약을 저장하고 큰 원본 키를 보존하지 않는다', async t => {
  const f = fixture(t);
  f.state.extraPayload = 'raw-state-marker'.repeat(10000);
  const m = await f.live.dispatch(f.mission.id, f.taskId, f.host, f.options);
  const a = m.attempts[0], state = a.turns[0].state;
  assert.equal(state.status, 'ready'); assert.equal(state.phase, 'implement');
  assert.equal(state.stateVersion, 'v2'); assert.equal(state.hash.length, 64);
  assert.ok(state.observedAt);
  for (const key of ['extraPayload', 'repo', 'ownership', 'request', 'consents', 'questions']) assert.ok(!(key in state) && !(key in a.initialState));
  assert.ok(!JSON.stringify(a).includes('raw-state-marker'));
  const next = await f.live.continue(m.id, a.id, f.host, { expectedRevision: m.revision, expectedState: 'v2' });
  assert.equal(next.attempts[0].turns.length, 2);
});

test('실제 배정은 판단·잠금 이후 수행하고 모델 완료 주장으로 작업을 성공시키지 않는다', async t => {
  const f = fixture(t);
  const m = await f.live.dispatch(f.mission.id, f.taskId, f.host, f.options);
  assert.equal(m.state, 'blocked'); assert.equal(m.tasks[0].state, 'awaiting-verification');
  assert.equal(m.evidence.length, 0); assert.equal(m.attempts[0].turns.length, 1);
  assert.ok(f.store.lock(m.attempts[0].projectId));
  assert.throws(() => f.engine.complete(m.id, m.revision), e => e.code === 'live-runner-unavailable');
  assert.throws(() => f.engine.plan(m.id, f.proposal, m.revision), e => e.code === 'unsettled-attempt');
  await assert.rejects(new Planner(f.store).analyze(m.id, { name: 'fixture', generate() { throw new Error('호출 금지'); } }, { expectedRevision: m.revision }), e => e.code === 'invalid-state');
});

test('동일 프로젝트의 이중 배정과 선행 검증 전 후행 작업 배정을 막는다', async t => {
  const f = fixture(t);
  await f.live.dispatch(f.mission.id, f.taskId, f.host, f.options);
  let other = f.engine.create({ ...f.fixture.mission, mode: 'live', requestKey: 'other-live' });
  other = f.engine.plan(other.id, f.proposal, other.revision);
  f.state.work = null; f.state.resume.code = 'no-work';
  await assert.rejects(f.live.dispatch(other.id, f.taskId, f.host, { expectedRevision: other.revision, expectedState: f.state.stateVersion }), e => e.code === 'project-busy');
  await assert.rejects(f.live.dispatch(other.id, 'integrate', f.host, { expectedRevision: other.revision, expectedState: f.state.stateVersion }), e => e.code === 'dependency-pending');
  assert.equal(f.host.calls, 1);
});

for (const [name, change, code] of [
  ['오래된 상태', s => s.stateVersion = 'changed', 'stale-remote-state'],
  ['다른 호스트 임대', s => s.ownership.lease.state = 'held', 'remote-busy'],
  ['열린 승인', s => s.consents.open.push({ id: 'consent' }), 'remote-needs-human'],
  ['미완 접수', s => s.request = { status: 'draft' }, 'remote-busy'],
  ['다른 작업', s => { s.work = { id: 'OTHER' }; s.resume.code = 'ready'; }, 'remote-not-ready'],
]) test(`${name}: 호스트 실행 전 거부`, async t => {
  const f = fixture(t); change(f.state);
  await assert.rejects(f.live.dispatch(f.mission.id, f.taskId, f.host, f.options), e => e.code === code);
  assert.equal(f.host.calls, 0); assert.equal(f.store.need('mission', f.mission.id).attempts.length, 0);
});

test('호스트 오류는 unknown으로 보존하고 자동 재시도하지 않는다', async t => {
  const f = fixture(t), lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  f.host.execute = async () => { throw Object.assign(new Error('timeout with secret\nprivate second line'), { code: 'EHOST' }); };
  const m = await f.live.dispatch(f.mission.id, f.taskId, f.host, f.options);
  assert.equal(m.tasks[0].state, 'unknown'); assert.ok(f.store.lock(m.attempts[0].projectId));
  assert.ok(!JSON.stringify(m).includes('secret'));
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT body FROM records').all()).includes('secret'));
  assert.deepEqual(lines, ['[EHOST] Error: timeout with secret']);
  const log = readFileSync(join(f.root, 'request-logs', m.id + '.log'), 'utf8');
  assert.match(log, /\[EHOST\] Error: timeout with secret/);
  assert.ok(!log.includes('private second line'));
  await assert.rejects(f.live.continue(m.id, m.attempts[0].id, f.host, { expectedRevision: m.revision, expectedState: 'v1' }), e => e.code === 'invalid-state');
});

test('다른 작업 결과와 저장소 기록 실패를 성공으로 처리하지 않는다', async t => {
  const f = fixture(t), base = f.host.execute;
  f.host.execute = async ticket => { const result = await base(ticket); f.state.work.id = 'OTHER'; return result; };
  const m = await f.live.dispatch(f.mission.id, f.taskId, f.host, f.options);
  assert.equal(m.tasks[0].state, 'unknown');
  assert.equal(f.engine.catalog.status().find(p => p.id === m.attempts[0].projectId).executionStatus.state, 'unknown');
  const second = f.proposal.tasks[1]; f.state.work = null; f.state.resume.code = 'no-work';
  const save = f.store.put.bind(f.store);
  f.store.put = (kind, ...args) => { if (kind === 'decision') throw new Error('disk failure'); return save(kind, ...args); };
  await assert.rejects(f.live.dispatch(m.id, second.id, f.host, { expectedRevision: m.revision, expectedState: f.state.stateVersion }), /disk failure/);
  assert.equal(f.store.lock(second.projectId), undefined); assert.equal(f.host.calls, 1);
});

test('계속 실행은 자기 코드 변경을 허용하지만 정책 변경은 거부한다', async t => {
  const f = fixture(t), project = f.store.need('project', f.proposal.tasks[0].projectId);
  writeFileSync(join(project.path, 'policy.txt'), '승인된 범위만 변경');
  writeFileSync(join(project.path, 'code.mjs'), 'export const n=1;');
  new Knowledge(f.store).collect(project.id, { schemaVersion: 1, sources: [{ path: 'policy.txt', kind: 'policy' }, { path: 'code.mjs', kind: 'code' }] }, project.revision);
  f.mission = f.engine.plan(f.mission.id, f.proposal, f.mission.revision);
  let m = await f.live.dispatch(f.mission.id, f.taskId, f.host, { ...f.options, expectedRevision: f.mission.revision });
  writeFileSync(join(project.path, 'code.mjs'), 'export const n=2;');
  m = await f.live.continue(m.id, m.attempts[0].id, f.host, { expectedRevision: m.revision, expectedState: f.state.stateVersion });
  assert.equal(f.host.calls, 2);
  writeFileSync(join(project.path, 'policy.txt'), '변경된 정책');
  await assert.rejects(f.live.continue(m.id, m.attempts[0].id, f.host, { expectedRevision: m.revision, expectedState: f.state.stateVersion }), e => e.code === 'stale-knowledge');
  assert.equal(f.host.calls, 2);
});

test('동의 대기와 기존 세션 재개를 기록하고 사람 승인 자체를 생성하지 않는다', async t => {
  const f = fixture(t), base = f.host.execute;
  f.host.execute = async ticket => { const result = await base(ticket); f.state.resume.code = 'needs-human'; f.state.consents.open = [{ id: 'C-1', action: 'approve' }]; return result; };
  let m = await f.live.dispatch(f.mission.id, f.taskId, f.host, f.options);
  assert.equal(m.state, 'waiting-decision'); assert.equal(m.nextAction, 'answer-in-code-agent-host');
  await assert.rejects(f.live.continue(m.id, m.attempts[0].id, f.host, { expectedRevision: m.revision, expectedState: 'v2' }), e => e.code === 'remote-needs-human');
  f.state.consents.open = []; f.state.resume.code = 'ready';
  f.state.ownership.lease = { state: 'held', host: 'claude', session: 'session-test' };
  f.host.execute = async ticket => { assert.equal(ticket.sessionId, 'session-test'); return base(ticket); };
  m = await f.live.continue(m.id, m.attempts[0].id, f.host, { expectedRevision: m.revision, expectedState: 'v2' });
  assert.equal(m.attempts[0].turns.length, 2); assert.equal(m.tasks[0].state, 'awaiting-verification');
});

test('실행 중 pause는 돌아온 결과로 해제되지 않으며 모의 결과 API를 혼용할 수 없다', async t => {
  const f = fixture(t), base = f.host.execute;
  f.host.execute = async ticket => {
    assert.throws(() => f.engine.accept(ticket, { schemaVersion: 1, mode: 'simulation', status: 'failed', summary: 'fake' }), e => e.code === 'wrong-mode');
    f.engine.control(f.mission.id, 'pause', f.store.need('mission', f.mission.id).revision);
    return base(ticket);
  };
  const m = await f.live.dispatch(f.mission.id, f.taskId, f.host, f.options);
  assert.equal(m.state, 'paused');
  await assert.rejects(f.live.continue(m.id, m.attempts[0].id, f.host, { expectedRevision: m.revision, expectedState: 'v2' }), e => e.code === 'invalid-state');
});

test('L6: 관리 실행 상태 조회는 현재 버전과 프로젝트 cwd를 대조한다', async t => {
  const f = fixture(t), project = f.store.need('project', f.proposal.tasks[0].projectId);
  mkdirSync(join(project.path, '.code-agent'), { recursive: true });
  writeFileSync(join(project.path, '.code-agent/version'), 'fixture');
  const cli = join(f.root, 'status.mjs');
  writeFileSync(cli, `import assert from 'node:assert/strict';
    assert.equal(process.cwd().toLowerCase(), ${JSON.stringify(project.path.toLowerCase())});
    assert.ok(process.argv.includes('--session') && process.argv.includes('session-test'));
    console.log(JSON.stringify(${JSON.stringify(f.state)}));`);
  assert.equal((await inspectState(cli, project, 'v1', 'session-test')).stateVersion, 'v1');
  await assert.rejects(inspectState(cli, project, 'old', 'session-test'), { code: 'stale-remote-state' });
});

test('L6: 직접 실행 호스트는 배정과 계속 실행 전에 거부한다', async t => {
  const f = fixture(t), direct = { ...f.host, name: 'claude', transport: undefined };
  await assert.rejects(f.live.dispatch(f.mission.id, f.taskId, direct, f.options), { code: 'invalid-runner' });
  await assert.rejects(f.live.continue(f.mission.id, 'attempt', direct, f.options), { code: 'invalid-runner' });
  assert.equal(f.host.calls, 0);
  assert.equal(f.store.need('mission', f.mission.id).attempts.length, 0);
});
