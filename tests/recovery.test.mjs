import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verificationFixture } from './verification-fixture.mjs';
import { Recovery } from '../packages/orchestrator/recovery.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';

const repair = context => ({ schemaVersion: 1, action: 'repair', category: 'implementation', summary: '값 수정', cause: 'assertion 기대값과 다름',
  references: [context.failure.id], alternatives: ['기존 범위 수정', '추가 조사'], steps: [{ instruction: 'value를 2로 수정', paths: ['source.mjs'], references: [context.failure.id] }],
  question: '', recommendation: '', uncertainties: [] });
async function failed(t) {
  const f = verificationFixture(t), attempt = await f.dispatch('edit-one');
  writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 3;\n');
  await f.verify(attempt);
  f.states.one.resume = { code: 'ready' };
  return { ...f, attempt, recovery: new Recovery(f.store), recover(provider, extra = {}) {
    return this.recovery.recover(f.mission.id, attempt.id, f.host, provider, { ...f.options('one'), ...extra });
  } };
}
test('실패 진단·판단을 먼저 저장하고 동일 세션에 수정 계획 전달 후 실제 재검증', async t => {
  const f = await failed(t), execute = f.host.execute;
  f.host.execute = async (ticket, options) => {
    assert.equal(ticket.sessionId, 'fixture-session'); assert.equal(ticket.recovery.proposal.action, 'repair');
    assert.equal(f.store.need('recovery-run', ticket.recovery.runId).state, 'executing');
    assert.ok(f.engine.describe(f.mission.id).decisions.some(d => d.type === 'decide-recovery' || d.kind === 'decide-recovery' || d.proposal?.action === 'repair'));
    return execute(ticket, options);
  };
  const result = await f.recover({ async generate({ context }) {
    assert.match(context.failure.checks[0].diagnostic, /AssertionError/);
    assert.equal(context.failure.checks[0].exitCode, 1);
    assert.match(context.currentCode[0].content, /value = 3/);
    f.states.one.observedAt = new Date().toISOString();
    return { data: repair(context) };
  } });
  assert.equal(result.progressed, true); assert.equal(result.recovery.state, 'returned');
  const verified = await f.verify(f.attempt);
  assert.equal(verified.attempts[0].state, 'verified');
  assert.deepEqual(verified.attempts[0].recipe, f.store.need('mission', f.mission.id).verificationRecipes['edit-one']);
});
test('범위 밖 수정 제안을 자동 재검토하고 계속 잘못되면 실행하지 않는다', async t => {
  const f = await failed(t); let calls = 0;
  await assert.rejects(f.recover({ async generate({ context }) { calls++; const p = repair(context); p.steps[0].paths = ['policy.txt']; return { data: p }; } }), { code: 'recovery-out-of-scope' });
  assert.equal(calls, 2); assert.equal(f.store.need('mission', f.mission.id).attempts[0].turns.length, 1);
  assert.equal(f.store.need('mission', f.mission.id).attempts[0].recoveryBusy, undefined);
});
test('잘못된 인용을 재검토한 뒤 보정된 계획만 실행한다', async t => {
  const f = await failed(t); let calls = 0;
  const result = await f.recover({ async generate({ context }) {
    const p = repair(context); if (++calls === 1) p.references = ['invented']; return { data: p };
  } });
  assert.equal(calls, 2); assert.equal(result.progressed, true);
  assert.equal(result.recovery.passes[0].error, 'invalid-recovery');
});
test('분석 중 pause를 보존하고 실행·검증의 동시 진입을 차단', async t => {
  const f = await failed(t);
  await assert.rejects(f.recover({ async generate({ context }) {
    await assert.rejects(f.verify(f.attempt), { code: 'invalid-state' });
    await assert.rejects(f.live.continue(f.mission.id, f.attempt.id, f.host, f.options('one')), { code: 'invalid-state' });
    f.engine.control(f.mission.id, 'pause', f.options('one').expectedRevision);
    return { data: repair(context) };
  } }), { code: 'stale-state' });
  assert.equal(f.store.need('mission', f.mission.id).state, 'paused');
  assert.equal(f.store.need('mission', f.mission.id).attempts[0].turns.length, 1);
});
test('분석 중 파일 또는 외부 상태 변경은 실행 전 차단', async t => {
  for (const mode of ['file', 'remote']) await t.test(mode, async t => {
    const f = await failed(t);
    await assert.rejects(f.recover({ async generate({ context }) {
      if (mode === 'file') writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 4;\n');
      else f.states.one.stateVersion = 'changed';
      return { data: repair(context) };
    } }), { code: mode === 'file' ? 'stale-context' : 'stale-remote-state' });
    assert.equal(f.store.need('mission', f.mission.id).attempts[0].turns.length, 1);
  });
});
test('외부 동의를 대신하지 않고 같은 실패를 drive가 중복 분석하지 않는다', async t => {
  const f = await failed(t); f.states.one.consents.open.push({ id: 'human' }); let calls = 0;
  const provider = { async generate({ context }) { calls++; return { data: repair(context) }; } };
  const workflow = new LiveWorkflow(f.store);
  const result = await workflow.advance(f.mission.id, f.host, provider);
  assert.equal(result.recovery.verdict.code, 'external-approval-required');
  await workflow.advance(f.mission.id, f.host, provider);
  assert.equal(calls, 1); assert.equal(f.store.need('mission', f.mission.id).attempts[0].turns.length, 1);
});
test('정보 부족·재계획·중대한 판단을 기록하고 추가 근거는 승인으로 취급하지 않는다', async t => {
  for (const action of ['needs-context', 'replan', 'needs-human']) await t.test(action, async t => {
    const f = await failed(t);
    const result = await f.recover({ async generate({ context }) {
      assert.equal(context.supplemental, '추가 관측');
      return { data: { ...repair(context), action, category: action === 'needs-human' ? 'critical' : 'scope', steps: [], question: '범위 검토 필요', recommendation: '기존 작업 보존', uncertainties: ['변경 영향 확인'] } };
    } }, { context: '추가 관측' });
    assert.equal(result.progressed, false); assert.equal(result.recovery.state, 'held');
    assert.equal(result.mission.state, action === 'needs-human' ? 'waiting-decision' : 'blocked');
    assert.ok(f.store.lock('one')); assert.equal(result.mission.attempts[0].turns.length, 1);
  });
});
test('동일 시도의 자동 실행은 두 번으로 제한하고 unknown은 복구하지 않는다', async t => {
  const f = await failed(t), provider = { async generate({ context }) { return { data: { ...repair(context), action: 'reverify', category: 'transient', steps: [] } }; } };
  assert.equal((await f.recover(provider)).progressed, true);
  assert.equal((await f.recover(provider)).progressed, true);
  assert.equal((await f.recover(provider)).recovery.verdict.code, 'recovery-limit');
  const m = f.store.need('mission', f.mission.id); m.attempts[0].state = 'unknown'; f.store.put('mission', m, m.revision);
  await assert.rejects(f.recover(provider), { code: 'invalid-state' });
});
