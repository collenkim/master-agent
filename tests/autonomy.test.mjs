import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verificationFixture } from './verification-fixture.mjs';
import { Recovery } from '../packages/orchestrator/recovery.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { VerificationTemplates } from '../packages/verification/templates.mjs';

test('일반 정보 부족 보류 중 독립 프로젝트는 배정·검증·인계하고 후행 통합은 대기', async t => {
  const f = verificationFixture(t), a = await f.dispatch('edit-one');
  writeFileSync(join(f.projects[0].path, 'source.mjs'), 'export const value = 3;\n'); await f.verify(a);
  const recovery = await new Recovery(f.store).recover(f.mission.id, a.id, f.host, { async generate({ context }) { return { data: {
    schemaVersion: 1, action: 'needs-context', category: 'unknown', summary: 'one의 추가 정보 필요', cause: '명세 미확인', references: [context.failure.id], alternatives: ['추가 관측', '대기'],
    steps: [], question: '기대값 근거는?', recommendation: '명세 확인', uncertainties: ['one의 기대값'] } }; } }, f.options('one'));
  assert.equal(recovery.progressed, false);
  const workflow = new LiveWorkflow(f.store);
  assert.equal((await workflow.advance(f.mission.id, f.host)).progressed, true);
  let m = f.store.need('mission', f.mission.id); const two = m.attempts.find(a => a.projectId === 'two'); assert.ok(two);
  await workflow.advance(m.id, f.host); await f.release(two);
  m = f.store.need('mission', m.id);
  assert.equal(m.tasks.find(t => t.id === 'edit-two').state, 'succeeded'); assert.equal(m.tasks.find(t => t.id === 'integrate').state, 'queued');
  assert.equal((await workflow.advance(m.id, f.host)).progressed, false);
  assert.ok(f.store.lock('one')); assert.equal(f.store.lock('two'), undefined);
});

test('기존 승인 후 ready 상태는 자동 재개하되 동일 상태는 반복하지 않는다', async t => {
  const f = verificationFixture(t), a = await f.dispatch('edit-one');
  Object.assign(f.states.one, { stateVersion: 'approved-next', resume: { code: 'ready' }, verification: { bound: { valid: false } } });
  let calls = 0;
  f.host.execute = async ticket => { calls++; assert.equal(ticket.sessionId, 'fixture-session'); return { status: 'returned', sessionId: 'fixture-session', summary: 'no progress', permissionDenials: [] }; };
  const workflow = new LiveWorkflow(f.store);
  await workflow.advance(f.mission.id, f.host);
  assert.equal(calls, 1);
  await workflow.advance(f.mission.id, f.host);
  assert.equal(f.store.need('mission', f.mission.id).attempts.find(at => at.id === a.id).autoContinuationStates.length, 1);
  // 두 번째 프로젝트는 독립 실행될 수 있으므로 one 호출 횟수는 저장된 상태로 대조한다.
  assert.equal(f.store.need('mission', f.mission.id).attempts.find(at => at.id === a.id).turns.length, 2);
});

test('템플릿은 일치하는 새 계획에 자동 연결되고 범위·완료 조건 변경은 거부', async t => {
  const f = verificationFixture(t), templates = new VerificationTemplates(f.store);
  const template = { id: 'one-value', projectId: 'one', domain: 'fixture', kinds: ['implementation'], criteria: ['value'], outputs: ['result'], recipe: f.recipes[0] };
  templates.register(f.mission.id, template, f.options('one').expectedRevision);
  let m = f.store.need('mission', f.mission.id);
  const plan = structuredClone(m.plans.at(-1).proposal); plan.tasks[0].id = 'one-new'; plan.tasks.at(-1).dependsOn[0] = 'one-new';
  f.engine.plan(m.id, plan, m.revision);
  const result = await new LiveWorkflow(f.store).advance(m.id, f.host);
  assert.equal(result.progressed, true); m = f.store.need('mission', m.id);
  assert.equal(m.verificationRecipes['one-new'].checks[0].executable, process.execPath);
  assert.equal(m.attempts.length, 0);
  assert.equal(templates.candidates(m, { ...plan.tasks[0], allowedChanges: ['new-file.mjs'] }).length, 0);
  assert.equal(templates.candidates({ ...m, criteria: [{ id: 'value', description: 'different meaning' }] }, plan.tasks[0]).length, 0);
  templates.register(m.id, { ...template, id: 'ambiguous' }, m.revision);
  assert.throws(() => templates.apply(m.id, 'one-new', f.options('one').expectedRevision), { code: 'template-selection-required' });
});
