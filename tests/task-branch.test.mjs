import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { Store } from '../packages/storage/store.mjs';
import { ControlClient } from '../packages/code-agent-adapter/control.mjs';
import { branchFixture, realDelivered } from './task-branch-fixture.mjs';
import { recoverTaskBranches, taskBranchRecordId } from '../packages/verification/task-branch.mjs';
import { missionPullRequests } from '../packages/verification/pull-request.mjs';

test('task 브랜치를 생성하고 다음 인계 커밋으로 전진한다', async t => {
  const f = branchFixture(t), a = f.commit('a'), b = f.commit('b', a);
  f.handoff('a', a);
  assert.equal((await recoverTaskBranches(f.store, f.mission.id, f.host))[0].state, 'completed');
  assert.equal(f.git('rev-parse', 'task/TASK-42'), a);
  f.handoff('b', b);
  await recoverTaskBranches(f.store, f.mission.id, f.host);
  assert.equal(f.git('rev-parse', 'task/TASK-42'), b);
});

test('기존 CLI 전송 경로가 task-branch를 변경 명령으로 처리하고 응답 유실을 같은 ID로 재전송한다', async t => {
  const f = branchFixture(t), hash = f.commit('a'); f.handoff('a', hash);
  const file = join(f.root, 'branch-transport.json'), tokenFile = join(f.root, 'test-token');
  writeFileSync(tokenFile, 'fixture-only'); writeFileSync(file, JSON.stringify({ calls: [], commands: {}, drop: 1, applied: 0 }));
  const client = new ControlClient({ cliPath: fileURLToPath(new URL('./task-branch-fake-cli.mjs', import.meta.url)), projectPath: f.path,
    controller: 'fixture', generation: 1, tokenFile });
  await assert.rejects(client.result('task-branch', { payload: {} }), { code: 'invalid-input' });
  await recoverTaskBranches(f.store, f.mission.id, { client: () => client });
  const trace = JSON.parse(readFileSync(file, 'utf8')), calls = trace.calls.filter(c => c.type === 'task-branch');
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(trace.applied, 1);
  assert.equal(f.store.list('control-command')[0].state, 'completed');
});

for (const code of ['conflict', 'invalid-state', 'unsupported']) test(`${code}여도 실제 인계 성공·증거 봉인·잠금 해제를 유지한다`, async t => {
  const f = await realDelivered(t); f.fail(code);
  const host = { ...f.executionHost, client: f.host.client };
  await f.verifier.handoff(f.mission.id, f.attempt.id, host, f.options('one'));
  const m = f.store.need('mission', f.mission.id), record = f.store.list('control-command')[0];
  assert.equal(m.attempts[0].state, 'succeeded'); assert.equal(f.store.lock('one'), undefined);
  assert.equal(record.state, code === 'unsupported' ? 'unsupported' : 'failed');
  const evidence = f.store.list('evidence'), delivery = f.store.list('delivery-run');
  await recoverTaskBranches(f.store, m.id, f.host);
  assert.deepEqual(f.store.list('evidence'), evidence); assert.deepEqual(f.store.list('delivery-run'), delivery);
  assert.equal(missionPullRequests(f.store, m.id).projects[0].branch, `feature/${f.attempt.codeAgentWorkId}`);
});

test('hello 미지원이면 task-branch를 보내지 않고 실제 작업 브랜치를 안내한다', async t => {
  const f = branchFixture(t), a = f.commit('a'); f.handoff('a', a); f.git('branch', 'feature/MA-a', a); f.finish(); f.support(false);
  await recoverTaskBranches(f.store, f.mission.id, f.host);
  assert.ok(f.calls.every(c => c.type === 'hello'));
  const pr = missionPullRequests(f.store, f.mission.id).projects[0];
  assert.equal(pr.branch, 'feature/MA-a'); assert.equal(pr.update.state, 'unsupported'); assert.equal(pr.ready, true);
});

test('인계 트랜잭션 저장 후 호출 전 종료를 다른 Store로 재개하며 봉인 기록은 바꾸지 않는다', async t => {
  const f = await realDelivered(t), transaction = f.store.transaction.bind(f.store);
  // 트랜잭션은 COMMIT했지만 handoff 호출자가 결과를 받기 전에 프로세스가 종료된 경계.
  f.store.transaction = fn => {
    const result = transaction(fn);
    if (result?.attempts?.some(a => a.id === f.attempt.id && a.state === 'succeeded')) throw new Error('crash after COMMIT');
    return result;
  };
  await assert.rejects(f.verifier.handoff(f.mission.id, f.attempt.id, { ...f.executionHost, client: f.host.client }, f.options('one')), /crash after COMMIT/);
  f.store.transaction = transaction;
  assert.equal(f.store.need('mission', f.mission.id).attempts[0].state, 'succeeded');
  const record = f.store.list('control-command')[0], evidence = f.store.list('evidence'), delivery = f.store.list('delivery-run');
  assert.equal(record.state, 'pending'); assert.equal(f.calls.length, 0);
  const reopened = new Store(join(f.root, 'state.db'));
  try { await recoverTaskBranches(reopened, f.mission.id, f.host); }
  finally { reopened.close(); }
  assert.equal(f.store.need('control-command', record.id).state, 'completed');
  assert.deepEqual(f.store.list('evidence'), evidence); assert.deepEqual(f.store.list('delivery-run'), delivery);
  assert.equal(f.calls.filter(c => c.type === 'task-branch')[0].commandId, record.commandId);
});

test('브랜치 갱신 후 응답 유실은 재시작 뒤 같은 commandId·payload로 재전송한다', async t => {
  const f = branchFixture(t), a = f.commit('a'); f.handoff('a', a); f.lose();
  const before = f.store.need('mission', f.mission.id);
  await recoverTaskBranches(f.store, f.mission.id, f.host);
  assert.equal(f.git('rev-parse', 'task/TASK-42'), a);
  assert.equal(f.store.list('control-command')[0].state, 'pending');
  const reopened = new Store(join(f.root, 'state.db'));
  try { await recoverTaskBranches(reopened, f.mission.id, f.host); } finally { reopened.close(); }
  const calls = f.calls.filter(c => c.type === 'task-branch');
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  assert.equal(f.store.list('control-command')[0].state, 'completed');
  assert.deepEqual(f.store.need('mission', f.mission.id), before);
});

test('최신 작업의 브랜치 갱신 뒤 이전 작업의 미처리 요청을 재전송하지 않는다', async t => {
  const f = branchFixture(t), a = f.commit('a'), b = f.commit('b', a), old = f.handoff('a', a);
  f.lose(); await recoverTaskBranches(f.store, f.mission.id, f.host);
  f.handoff('b', b); await recoverTaskBranches(f.store, f.mission.id, f.host);
  const count = f.calls.filter(c => c.type === 'task-branch').length;
  await recoverTaskBranches(f.store, f.mission.id, f.host);
  assert.equal(f.git('rev-parse', 'task/TASK-42'), b);
  assert.equal(f.store.need('control-command', taskBranchRecordId(old.id)).state, 'superseded');
  assert.equal(f.calls.filter(c => c.type === 'task-branch').length, count);
});

test('기능 확인 중 늦어진 이전 요청도 새 인계가 있으면 전송하지 않는다', async t => {
  const f = branchFixture(t), a = f.commit('a'), b = f.commit('b', a); f.handoff('a', a);
  let resume, started;
  const startedPromise = new Promise(r => { started = r; });
  const delayed = { client() { return { async result(type) { assert.equal(type, 'hello'); started(); await new Promise(r => { resume = r; }); return { commands: { mutating: ['task-branch'] } }; } }; } };
  const old = recoverTaskBranches(f.store, f.mission.id, delayed); await startedPromise;
  f.handoff('b', b); await recoverTaskBranches(f.store, f.mission.id, f.host); resume(); await old;
  assert.equal(f.git('rev-parse', 'task/TASK-42'), b);
  assert.equal(f.calls.filter(c => c.type === 'task-branch').length, 1);
});

test('재사용 TASK의 갈라진 옛 브랜치는 reset하지 않으며 확정 실패 재시도는 명시한 새 commandId를 쓴다', async t => {
  const f = branchFixture(t), a = f.commit('a'), unrelated = f.commit('old-task'); f.handoff('a', a); f.git('branch', 'task/TASK-42', unrelated);
  await recoverTaskBranches(f.store, f.mission.id, f.host);
  const record = f.store.list('control-command')[0]; assert.equal(record.state, 'failed'); assert.equal(record.code, 'conflict');
  assert.equal(f.calls.filter(c => c.type === 'task-branch').length, 0); assert.equal(f.git('rev-parse', 'task/TASK-42'), unrelated);
  f.git('branch', '-D', 'task/TASK-42'); // 사람이 옛 브랜치를 정리한 상황
  await recoverTaskBranches(f.store, f.mission.id, f.host); assert.equal(f.calls.filter(c => c.type === 'task-branch').length, 0);
  await recoverTaskBranches(f.store, f.mission.id, f.host, { newCommand: true });
  assert.equal(f.store.list('control-command')[0].state, 'completed');
  assert.notEqual(f.calls.at(-1).commandId, record.commandId);
});

test('TASK 번호 없음과 local-files에는 task-branch를 호출하지 않는다', async t => {
  for (const mode of ['no-task', 'local-files']) await t.test(mode, async t => {
    const f = branchFixture(t, { taskNumber: mode === 'no-task' ? null : 'TASK-42' }), a = f.commit('a');
    f.handoff('a', a, { localFiles: mode === 'local-files' }); f.git('branch', 'feature/MA-a', a); f.finish();
    await recoverTaskBranches(f.store, f.mission.id, f.host);
    assert.equal(f.calls.length, 0);
    const pr = missionPullRequests(f.store, f.mission.id).projects[0];
    assert.doesNotMatch(pr.squashMessage, /undefined|\[\]/);
    assert.equal(pr.ready, mode === 'no-task');
    assert.equal(pr.branch, mode === 'no-task' ? 'feature/MA-a' : null);
    if (mode === 'local-files') { assert.equal(pr.commit, null); assert.match(pr.reason, /미커밋/); }
    else assert.equal(pr.squashMessage.split('\n')[0], f.mission.goal);
  });
});
