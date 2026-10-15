import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { planningSetup, answerFor } from './planning-fixture.mjs';
import { verificationFixture } from './verification-fixture.mjs';
import { stopAnalysis } from '../packages/orchestrator/analysis-control.mjs';
import { Recovery } from '../packages/orchestrator/recovery.mjs';
import { Reconciliation } from '../packages/orchestrator/reconcile.mjs';

test('CLI로 분석을 중단한 뒤 새 계획 적용; 늦은 이전 응답은 폐기', async t => {
  const f = planningSetup(t), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const old = f.planner.analyze(f.mission.id, { name: 'fixture', async generate({ context }) { entered.resolve(); await gate.promise; return { data: answerFor(context) }; } }, { expectedRevision: f.mission.revision }).catch(e => e);
  await entered.promise;
  const active = f.store.need('mission', f.mission.id), oldId = active.analysisRunId;
  const stopped = JSON.parse(execFileSync(process.execPath, [resolve('apps/cli/main.mjs'), 'mission', 'stop-analysis', active.id, oldId, '--revision', String(active.revision), '--db', f.db], { encoding: 'utf8' }));
  assert.equal(stopped.planningHold, true);
  const latest = await f.planner.analyze(active.id, { name: 'fixture', async generate({ context }) { return { data: answerFor(context) }; } }, { expectedRevision: stopped.revision });
  gate.resolve(); assert.equal((await old).code, 'stale-state');
  assert.equal(f.store.need('analysis-run', oldId).status, 'interrupted');
  assert.equal(f.store.need('mission', active.id).revision, latest.mission.revision);
  assert.equal(f.store.need('mission', active.id).plans.length, 1);
});

test('일시 정지 중 분석 취소는 pause 유지, 중복 취소 거부', async t => {
  const f = planningSetup(t);
  let runId;
  await assert.rejects(f.planner.analyze(f.mission.id, { name: 'fixture', async generate({ context }) {
    let m = f.store.need('mission', f.mission.id); runId = m.analysisRunId;
    m = f.engine.control(m.id, 'pause', m.revision);
    const stopped = stopAnalysis(f.store, m.id, runId, m.revision);
    assert.equal(stopped.state, 'paused');
    assert.throws(() => stopAnalysis(f.store, m.id, runId, stopped.revision), { code: 'invalid-state' });
    return { data: answerFor(context) };
  } }, { expectedRevision: f.mission.revision }), { code: 'stale-state' });
  assert.equal(f.store.need('analysis-run', runId).status, 'interrupted');
  assert.equal(f.store.need('mission', f.mission.id).state, 'paused');
});
test('분석 결과 저장 후 계획 활성화 전 중단도 정리하며 적용된 계획은 취소하지 않는다', async t => {
  const f = planningSetup(t), plan = f.planner.engine.plan.bind(f.planner.engine);
  let stopped;
  f.planner.engine.plan = (id, proposal, revision, options) => {
    stopped = stopAnalysis(f.store, id, options.analysisId, revision);
    return plan(id, proposal, revision, options);
  };
  await assert.rejects(f.planner.analyze(f.mission.id, { name: 'fixture', async generate({ context }) { return { data: answerFor(context) }; } }, { expectedRevision: f.mission.revision }), { code: 'stale-state' });
  assert.equal(f.store.need('analysis-run', stopped.analysisRunId).status, 'interrupted');
  f.planner.engine.plan = plan;
  const next = await f.planner.analyze(f.mission.id, { name: 'fixture', async generate({ context }) { return { data: answerFor(context) }; } }, { expectedRevision: stopped.revision });
  assert.throws(() => stopAnalysis(f.store, f.mission.id, next.analysis.id, next.mission.revision), { code: 'invalid-state' });
});

test('복구 분석 취소는 잠금을 보존하고 늦은 수정 제안 실행을 막는다', async t => {
  const f = verificationFixture(t), a = await f.dispatch('edit-one');
  writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 3;\n'); await f.verify(a);
  let runId;
  await assert.rejects(new Recovery(f.store).recover(f.mission.id, a.id, f.host, { async generate() {
    const m = f.store.need('mission', f.mission.id); runId = m.attempts[0].recoveryBusy;
    stopAnalysis(f.store, m.id, runId, m.revision);
    return { data: {} };
  } }, f.options('one')), { code: 'stale-state' });
  assert.equal(f.store.need('recovery-run', runId).state, 'interrupted');
  const m = f.store.need('mission', f.mission.id);
  assert.equal(m.attempts[0].recoveryBusy, undefined); assert.equal(m.attempts[0].turns.length, 1); assert.ok(f.store.lock('one'));
});

async function interruptedVerification(t) {
  const f = verificationFixture(t), a = await f.dispatch('edit-one');
  const put = f.store.put.bind(f.store);
  f.store.put = (kind, value, ...args) => { if (kind === 'verification-run' && value.state === 'verified') throw new Error('summary persistence failed'); return put(kind, value, ...args); };
  await assert.rejects(f.verify(a), /summary persistence failed/); f.store.put = put;
  f.engine.markUnknown(f.mission.id, a.id, f.options('one').expectedRevision);
  return { ...f, a, reconcile() { return new Reconciliation(f.store).verification(f.mission.id, a.id, f.host, f.options('one')); } };
}

test('검증 명령 정상 반환 후 저장 중단은 새 독립 검증으로 복구', async t => {
  const f = await interruptedVerification(t);
  const command = f.store.list('command-run')[0]; assert.equal(command.state, 'returned'); assert.equal(command.exitCode, 0);
  const m = await f.reconcile(); assert.equal(m.attempts[0].state, 'awaiting-verification');
  assert.equal(f.store.list('verification-run')[0].state, 'reconciled');
  assert.equal(f.store.list('evidence').length, 0); assert.ok(f.store.lock('one'));
  await assert.rejects(f.live.continue(m.id, f.a.id, f.host, f.options('one')), { code: 'invalid-state' });
  await f.verify(f.a);
  assert.equal(f.store.need('mission', m.id).attempts[0].state, 'verified');
  assert.equal(f.store.list('command-run').length, 2);
});

test('명령 미반환·누락·변조·다른 계약·파일 변경은 검증 복구 차단', async t => {
  for (const mode of ['started', 'missing', 'tampered', 'contract', 'tree']) await t.test(mode, async t => {
    const f = await interruptedVerification(t), c = f.store.list('command-run')[0];
    if (mode === 'missing') f.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('command-run', c.id);
    else if (mode === 'tree') writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 9;\n');
    else { if (mode === 'started') c.state = 'started'; if (mode === 'tampered') c.outputHash = 'tampered'; if (mode === 'contract') c.commandHash = 'other-command'; f.store.put('command-run', c, c.revision); }
    await assert.rejects(f.reconcile()); assert.ok(f.store.lock('one')); assert.equal(f.store.list('reconciliation').length, 0);
  });
});

test('이전 검증의 늦은 관측 결과가 새 검증 결과를 덮지 않는다', async t => {
  const f = verificationFixture(t), a = await f.dispatch('edit-one'), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const inspect = f.host.inspect; let calls = 0;
  f.host.inspect = async (...args) => { if (++calls === 2) { entered.resolve(); await gate.promise; } return inspect(...args); };
  const old = f.verify(a).catch(e => e); await entered.promise;
  f.engine.markUnknown(f.mission.id, a.id, f.options('one').expectedRevision);
  await new Reconciliation(f.store).verification(f.mission.id, a.id, f.host, f.options('one'));
  await f.verify(a);
  const current = f.store.need('mission', f.mission.id);
  gate.resolve(); assert.equal((await old).code, 'stale-result');
  assert.equal(f.store.need('mission', f.mission.id).revision, current.revision);
  assert.equal(f.store.need('mission', f.mission.id).attempts[0].state, 'verified');
});
