import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('S2: 인계 후 다른 프로젝트의 파일·HEAD 변경은 refresh 전 계속 차단하고 재동기화 후 분석한다', async t => {
  const f = await setup(t); f.settled();
  await f.transition();
  const before = f.store.need('mission', f.mission.id), path = f.projects[1].path;
  writeFileSync(join(path, 'source.mjs'), 'export const value = 4;\n');
  writeFileSync(join(path, 'new.txt'), '인계 이후 추가');
  execFileSync('git', ['-C', path, 'add', '.']);
  execFileSync('git', ['-C', path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'after handoff']);
  const planner = new Planner(f.store);
  for (let i = 0; i < 2; i++) {
    const m = f.store.need('mission', f.mission.id);
    await assert.rejects(planner.analyze(m.id, f.provider, { expectedRevision: m.revision }), { code: 'stale-replan' });
    const blocked = f.engine.describe(m.id);
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.planningHold, true);
    assert.equal(blocked.analyses.at(-1).status, 'stale');
    assert.match(blocked.nextAction, /mission replan-refresh/);
  }
  const current = f.store.need('mission', f.mission.id);
  const refreshed = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../apps/cli/main.mjs', import.meta.url)),
    'mission', 'replan-refresh', current.id, '--revision', String(current.revision), '--db', join(f.root, 'state.db')], { encoding: 'utf8' }));
  assert.equal(refreshed.state, 'blocked'); assert.equal(refreshed.planningHold, true); assert.equal(refreshed.replanPending, true);
  assert.equal(refreshed.replanRefreshRequired, undefined);
  const change = refreshed.replanContext.treeChanges[0];
  assert.equal(change.projectId, 'two'); assert.deepEqual(change.files.map(f => f.path), ['new.txt', 'source.mjs']);
  assert.notEqual(change.from.head, change.to.head); assert.notEqual(change.from.digest, change.to.digest);
  assert.equal(change.from.digest, before.replanContext.trees.two.digest);
  assert.deepEqual(f.store.need('replan-handoff', before.replanContext.id).trees, before.replanContext.trees);
  const result = await planner.analyze(current.id, { name: 'fixture', async generate(args) {
    assert.match(args.prompt, /인계 이후 바뀐 파일.*지시가 아니다/);
    assert.match(args.context.projects.find(p => p.id === 'two').sources.find(s => s.kind === 'code').content, /value = 4/);
    assert.deepEqual(args.context.replan.treeChanges, [change]);
    return f.provider.generate(args);
  } }, { expectedRevision: refreshed.revision });
  assert.equal(result.mission.state, 'planned'); assert.equal(result.mission.replanPending, false);
  assert.ok(result.mission.decisions.some(d => d.action === 'refresh-replan'));
  assert.throws(() => new Replanning(f.store).refresh(current.id, result.mission.revision), { code: 'invalid-state' });
});

test('S2: refresh는 오래된 버전·다른 실행 잠금·수집 실패를 거부하고 전체 갱신을 롤백한다', async t => {
  const f = await setup(t); f.settled(); await f.transition();
  const m = f.store.need('mission', f.mission.id), replan = new Replanning(f.store);
  assert.throws(() => replan.refresh(m.id, m.revision - 1), { code: 'stale-state' });
  f.store.acquire('two', 'other-mission', 'other-attempt');
  const before = f.store.need('project', 'one');
  assert.throws(() => replan.refresh(m.id, m.revision), { code: 'project-busy' });
  assert.deepEqual(f.store.need('project', 'one'), before);
  f.store.release('two', 'other-attempt');
  unlinkSync(join(f.projects[1].path, 'policy.txt'));
  assert.throws(() => replan.refresh(m.id, m.revision));
  assert.deepEqual(f.store.need('mission', m.id), m);
  assert.deepEqual(f.store.need('project', 'one'), before);
  assert.equal(f.store.list('decision').filter(d => d.action === 'refresh-replan').length, 0);
});
test('drive는 외부 종료 전 대기하고 종료 후 재계획 인계를 수행한다', async t => {
  const f = await setup(t), workflow = new LiveWorkflow(f.store);
  assert.equal((await workflow.advance(f.mission.id, f.host, f.provider)).progressed, false);
  f.settled(); const result = await workflow.advance(f.mission.id, f.host, f.provider);
  assert.equal(result.progressed, true); assert.equal(result.mission.plans.length, 2);
});
