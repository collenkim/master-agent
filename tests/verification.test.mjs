import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Knowledge } from '../packages/knowledge/sources.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';

import { verificationFixture } from './verification-fixture.mjs';

test('실제 파일 변경·검증 명령·두 프로젝트 인계·후행 통합 검증으로 live 완료', async t => {
  const f = verificationFixture(t);
  for (const id of ['edit-one', 'edit-two', 'integrate']) {
    const attempt = await f.dispatch(id);
    const m = await f.verify(attempt);
    assert.equal(m.attempts.at(-1).state, 'verified');
    assert.ok(f.store.lock(attempt.projectId));
    const run = f.store.need('verification-run', m.attempts.at(-1).verificationRunId);
    assert.ok(run.checks.every(c => c.passed && c.output.includes('실제 입력 검증 통과')));
    await f.release(attempt);
    assert.equal(f.store.lock(attempt.projectId), undefined);
  }
  const result = JSON.parse(execFileSync(process.execPath, [resolve('apps/cli/main.mjs'), 'mission', 'complete', f.mission.id,
    '--db', join(f.root, 'state.db'), '--revision', String(f.store.need('mission', f.mission.id).revision)], { encoding: 'utf8' }));
  assert.equal(result.state, 'succeeded');
  const detail = f.engine.describe(result.id);
  assert.equal(detail.evidence.length, 3); assert.ok(detail.evidence.every(e => e.provenance === 'live-verification'));
  assert.equal(detail.verifications.length, 3); assert.ok(detail.verifications.every(v => v.state === 'verified' && v.checks.length));
  assert.equal(detail.nextAction, 'none');
});

test('범위 밖 수정과 승인·code-agent 증거 부족은 테스트 실행 전에 차단한다', async t => {
  const f = verificationFixture(t), attempt = await f.dispatch('edit-one');
  f.states.one.approval.status = 'none';
  await assert.rejects(f.verify(attempt), e => e.code === 'remote-unapproved');
  f.states.one.approval.status = 'approved'; f.states.one.verification.bound.valid = false;
  await assert.rejects(f.verify(attempt), e => e.code === 'missing-remote-evidence');
  f.states.one.verification.bound.valid = true;
  writeFileSync(join(f.projects[0].path, 'unexpected.txt'), 'outside');
  await assert.rejects(f.verify(attempt), e => e.code === 'out-of-scope-change');
  assert.equal(f.store.list('verification-run').length, 0);
});

test('실제 명령 실패는 증거·잠금 해제 없이 수정 가능한 검증 실패로 남는다', async t => {
  const f = verificationFixture(t), attempt = await f.dispatch('edit-one');
  writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 3;');
  const m = await f.verify(attempt);
  assert.equal(m.attempts[0].state, 'verification-failed');
  assert.ok(f.store.lock('one')); assert.equal(f.store.list('evidence').length, 0);
  await assert.rejects(f.release(attempt), e => e.code === 'invalid-state');
});

test('검증 후 파일 변경·외부 작업 미종료·증거 변조는 인계를 막는다', async t => {
  const f = verificationFixture(t), attempt = await f.dispatch('edit-one');
  let m = await f.verify(attempt);
  await assert.rejects(f.verifier.handoff(m.id, attempt.id, f.host, f.options('one')), e => e.code === 'handoff-pending');
  const file = join(f.projects[0].path, 'source.mjs'), original = readFileSync(file, 'utf8');
  writeFileSync(file, 'export const value = 4;');
  await assert.rejects(f.release(attempt), e => e.code === 'stale-evidence');
  writeFileSync(file, original);
  const run = f.store.need('verification-run', m.attempts[0].verificationRunId);
  run.checks[0].output = 'tampered'; f.store.put('verification-run', run, run.revision);
  await assert.rejects(f.release(attempt), e => e.code === 'invalid-evidence');
});

test('검증 중 파일 쓰기는 unknown으로 격리한다', async t => {
  const f = verificationFixture(t), recipe = structuredClone(f.recipes[0]);
  recipe.checks[0].args = ['-e', "require('node:fs').writeFileSync('source.mjs','changed')"];
  f.verifier.configure(f.mission.id, recipe, f.store.need('mission', f.mission.id).revision);
  const attempt = await f.dispatch('edit-one'), m = await f.verify(attempt);
  assert.equal(m.attempts[0].state, 'unknown'); assert.ok(f.store.lock('one'));
});

test('검증 실행 시간 초과는 unknown으로 격리한다', async t => {
  const f = verificationFixture(t), recipe = structuredClone(f.recipes[0]);
  recipe.checks[0].args = ['-e', 'setInterval(()=>{},1000)']; recipe.checks[0].timeoutMs = 150;
  f.verifier.configure(f.mission.id, recipe, f.mission.revision);
  const attempt = await f.dispatch('edit-one'), m = await f.verify(attempt);
  assert.equal(m.attempts[0].state, 'unknown');
});

test('검증 실행 전에 판단 저장 실패가 나면 명령을 시작하지 않는다', async t => {
  const f = verificationFixture(t), attempt = await f.dispatch('edit-one'), original = f.store.put.bind(f.store);
  f.store.put = (kind, ...args) => { if (kind === 'decision') throw new Error('disk-full'); return original(kind, ...args); };
  await assert.rejects(f.verify(attempt), /disk-full/);
  assert.equal(f.store.list('verification-run').length, 0);
  assert.equal(f.store.need('mission', f.mission.id).attempts[0].state, 'waiting-decision');
});

test('완료 후 선행 결과가 바뀌면 후행 배정을 거부하고 변경된 증거를 재사용하지 않는다', async t => {
  const f = verificationFixture(t), attempt = await f.dispatch('edit-one');
  await f.verify(attempt); await f.release(attempt);
  writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 5;');
  await assert.rejects(f.dispatch('edit-two'), e => e.code === 'stale-context');
  assert.equal(f.store.lock('two'), undefined);
});

test('drive는 배정·실제 테스트·모의 외부 종료 관측·인계·통합 완료를 자동으로 잇는다', async t => {
  const f = verificationFixture(t), inspect = f.host.inspect;
  f.host.inspect = async project => {
    const a = f.store.need('mission', f.mission.id).attempts.filter(a => a.projectId === project.id).at(-1);
    if (a?.state === 'verified') Object.assign(f.states[project.id], { work: null, request: null, resume: { code: 'no-work' }, stateVersion: `ended-${a.id}` });
    return inspect(project);
  };
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host);
  assert.equal(result.mission.state, 'succeeded');
  assert.equal(result.mission.attempts.length, 3);
});

test('drive는 실제 검증 실패를 자동 재시도하거나 무한 반복하지 않는다', async t => {
  const f = verificationFixture(t), execute = f.host.execute; let calls = 0;
  f.host.execute = async (...args) => {
    calls++; const result = await execute(...args);
    if (args[0].projectId === 'one') writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 9;'); return result;
  };
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host);
  assert.equal(result.progressed, false); assert.equal(calls, 2);
  assert.ok(result.mission.attempts.every(a => a.turns.length === 1));
  assert.ok(result.blockers.includes('edit-one:verification-failed'));
});

test('검증 계약은 조건·산출물·정확한 경로를 요구하고 배정 후에는 바꿀 수 없다', async t => {
  const f = verificationFixture(t), invalid = structuredClone(f.recipes[0]);
  invalid.artifacts = [];
  assert.throws(() => f.verifier.configure(f.mission.id, invalid, f.mission.revision), e => e.code === 'missing-artifact');
  invalid.artifacts = f.recipes[0].artifacts; invalid.allowedPaths = ['../outside'];
  assert.throws(() => f.verifier.configure(f.mission.id, invalid, f.mission.revision), e => e.code === 'invalid-path');
  await f.dispatch('edit-one');
  assert.throws(() => f.verifier.configure(f.mission.id, f.recipes[0], f.store.need('mission', f.mission.id).revision), e => e.code === 'invalid-state');
});

test('선언만 있고 실제 파일 산출물이 없으면 성공 증거를 만들지 않는다', async t => {
  const f = verificationFixture(t), recipe = structuredClone(f.recipes[0]);
  recipe.artifacts = [{ name: 'result', path: 'missing-report.json' }];
  f.verifier.configure(f.mission.id, recipe, f.mission.revision);
  const attempt = await f.dispatch('edit-one'), m = await f.verify(attempt);
  assert.equal(m.attempts[0].state, 'unknown'); assert.equal(f.store.list('evidence').length, 0);
});
