import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { verificationFixture } from './verification-fixture.mjs';
import { answerFor } from './planning-fixture.mjs';
import { Recovery } from '../packages/orchestrator/recovery.mjs';
import { Replanning } from '../packages/orchestrator/replan.mjs';
import { Planner } from '../packages/reasoning/planner.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';

async function setup(t) {
  const f = verificationFixture(t), attempt = await f.dispatch('edit-one');
  writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 3;\n');
  await f.verify(attempt);
  await new Recovery(f.store).recover(f.mission.id, attempt.id, f.host, { async generate({ context }) {
    return { data: { schemaVersion: 1, action: 'replan', category: 'scope', summary: '검증 역할 재배정', cause: '기존 분해 보완 필요', references: [context.failure.id], alternatives: ['현 계획 유지', '작업 재분해'], steps: [], question: '', recommendation: '최신 코드 기준 재계획', uncertainties: [] } };
  } }, f.options('one'));
  const settled = () => Object.assign(f.states.one, { stateVersion: 'settled', work: null, request: null, resume: { code: 'no-work' } });
  const provider = { name: 'fixture', async generate({ context }) {
    assert.equal(context.replan.attemptId, attempt.id);
    assert.match(context.projects[0].sources.find(s => s.kind === 'code').content, /value = 3/);
    const data = answerFor(context);
    data.plan.tasks.forEach(t => { t.requiredCapabilities = ['code-agent:claude']; t.allowedChanges = ['source.mjs']; t.exclusions = ['policy.txt']; });
    return { data };
  } };
  return { ...f, attempt, settled, provider, transition(provider) { return new Replanning(f.store).transition(f.mission.id, attempt.id, f.host, provider, f.options('one')); } };
}
test('실패 변경 보존·종료 대조·근거 재수집·새 계획 활성화까지 연결', async t => {
  const f = await setup(t); f.settled();
  const result = await f.transition(f.provider), m = result.mission;
  assert.equal(m.state, 'planned'); assert.equal(m.plans.length, 2); assert.equal(m.replans.length, 1);
  assert.equal(m.attempts[0].state, 'abandoned'); assert.equal(m.evidence.length, 0);
  assert.equal(f.store.lock('one'), undefined); assert.deepEqual(m.verificationRecipes, {});
  assert.ok(m.tasks.every(t => t.state === 'queued' && !t.evidenceIds.length));
  assert.match(readFileSync(join(f.projects[0].path, 'source.mjs'), 'utf8'), /value = 3/);
  assert.equal(m.replanPending, false);
  const next = await new LiveWorkflow(f.store).advance(m.id, f.host, f.provider);
  assert.equal(next.progressed, false); assert.ok(next.blockers.some(b => b.includes('missing-verification-recipe')));
});
test('외부 작업·임대·다른 시도 미정리와 오래된 파일은 잠금 해제 전에 차단', async t => {
  for (const mode of ['work', 'lease', 'other', 'tree']) await t.test(mode, async t => {
    const f = await setup(t);
    if (mode !== 'work') f.settled();
    if (mode === 'lease') f.states.one.ownership.lease.state = 'held';
    if (mode === 'other') {
      const m = f.store.need('mission', f.mission.id);
      m.attempts.push({ id: 'other-attempt', mode: 'live', state: 'unknown', projectId: 'two' });
      f.store.put('mission', m, m.revision);
    }
    if (mode === 'tree') writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 4;\n');
    await assert.rejects(f.transition(), { code: mode === 'other' ? 'unsettled-attempt' : mode === 'tree' ? 'stale-replan' : 'handoff-pending' });
    assert.ok(f.store.lock('one')); assert.equal(f.store.list('replan-handoff').length, 0);
  });
});
test('근거 재수집 실패 시 모든 카탈로그 갱신·판단·잠금 정리가 롤백된다', async t => {
  const f = await setup(t); f.settled();
  const project = f.store.need('project', 'one'), decisions = f.store.list('decision').length;
  unlinkSync(join(f.projects[1].path, 'policy.txt'));
  await assert.rejects(f.transition());
  assert.deepEqual(f.store.need('project', 'one'), project);
  assert.equal(f.store.list('decision').length, decisions); assert.ok(f.store.lock('one'));
  assert.equal(f.store.need('mission', f.mission.id).attempts[0].state, 'verification-failed');
});
test('계획 생성 실패 후 이전 계획을 실행하지 않고 분석만 재개한다', async t => {
  const f = await setup(t); f.settled();
  await assert.rejects(f.transition({ name: 'fixture', async generate() { throw Object.assign(new Error('offline'), { code: 'provider-offline' }); } }));
  let m = f.store.need('mission', f.mission.id);
  assert.equal(m.planningHold, true); assert.equal(m.replanPending, true); assert.equal(m.plans.length, 1);
  assert.equal((await new LiveWorkflow(f.store).advance(m.id, f.host)).progressed, false);
  m = (await new Planner(f.store).analyze(m.id, f.provider, { expectedRevision: m.revision })).mission;
  assert.equal(m.plans.length, 2); assert.equal(m.replans.length, 1);
});
test('분석 중 수집하지 않은 파일 변경도 새 계획 적용을 막는다', async t => {
  const f = await setup(t); f.settled();
  await assert.rejects(f.transition({ name: 'fixture', async generate(args) {
    writeFileSync(join(f.projects[0].path, 'new.txt'), 'unexpected'); return f.provider.generate(args);
  } }), { code: 'stale-replan' });
  const m = f.store.need('mission', f.mission.id); assert.equal(m.plans.length, 1); assert.ok(m.planningHold);
});
test('drive는 외부 종료 전 대기하고 종료 후 재계획 인계를 수행한다', async t => {
  const f = await setup(t), workflow = new LiveWorkflow(f.store);
  assert.equal((await workflow.advance(f.mission.id, f.host, f.provider)).progressed, false);
  f.settled(); const result = await workflow.advance(f.mission.id, f.host, f.provider);
  assert.equal(result.progressed, true); assert.equal(result.mission.plans.length, 2);
});
