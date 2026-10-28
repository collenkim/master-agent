import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, temporary } from './helpers.mjs';
import { taskHeld } from '../packages/orchestrator/scope.mjs';
import { missionProgress } from '../packages/orchestrator/progress.mjs';
import { assertReplanTrees } from '../packages/orchestrator/replan-guard.mjs';
import { delegationVerdict } from '../packages/orchestrator/delegation.mjs';
import { runCheck } from '../packages/verification/command.mjs';
import { sealOf, assertSealed } from '../packages/verification/seal.mjs';
import { validateRecovery } from '../packages/reasoning/recovery-schema.mjs';
import { snapshotTree } from '../packages/verification/tree.mjs';
import { alive } from '../packages/runner/process.mjs';
import { Catalog } from '../packages/catalog/catalog.mjs';

test('C4 scope: 보류는 의존 프로젝트에 전파하고 중대한 보류는 전체에 적용한다', () => {
  const hold = { state: 'held', attemptId: 'a', proposal: { category: 'unknown', action: 'needs-context' } };
  const store = { get: () => hold };
  const mission = { plans: [{ version: 1, proposal: { tasks: [
    { id: 'one', projectId: 'p1', dependsOn: [], references: [] },
    { id: 'two', projectId: 'p2', dependsOn: ['one'], references: [] },
    { id: 'independent', projectId: 'p3', dependsOn: [], references: [] },
  ] } }], attempts: [{ id: 'a', projectId: 'p1', planVersion: 1, state: 'verification-failed', recoveryRunId: 'r' }] };
  assert.equal(taskHeld(store, mission, 'two'), true);
  assert.equal(taskHeld(store, mission, 'independent'), false);
  hold.proposal.category = 'critical';
  assert.equal(taskHeld(store, mission, 'independent'), true);
});

test('C4 progress: 투영된 반영 동의와 업무 질문을 구별하고 다른 목표의 이관은 제외한다', t => {
  const { store } = setup(t, { plan: false }), at = '2026-01-01T00:00:00.000Z';
  const remote = { work: { id: 'work', phase: 'deliver' }, openConsents: 1, deliveryConsentsOnly: true, unansweredQuestions: 0 };
  const mission = { id: 'progress-test', mode: 'live', state: 'blocked', createdAt: at, plans: [{ version: 1 }],
    attempts: [{ id: 'a', invocationId: 'invoke', projectId: 'p', codeAgentWorkId: 'work', startedAt: at,
      turns: [{ id: 'turn', at, state: remote }] }] };
  const tasks = [{ id: 'task', projectId: 'p', state: 'waiting-decision', waitingFor: [], attemptIds: ['a'] }];
  store.put('control-run', { id: 'run', missionId: mission.id, attemptId: 'a', invocationId: 'invoke', state: 'completed', acceptedAt: at });
  store.put('escalation', { id: 'other', missionId: 'other-mission', attemptId: 'a', state: 'open' });
  assert.equal(missionProgress(store, mission, tasks, []).status, 'verification-pending');
  remote.unansweredQuestions = 1;
  assert.equal(missionProgress(store, mission, tasks, []).status, 'approval-pending');
  mission.state = 'cancelled';
  assert.equal(missionProgress(store, mission, tasks, []).nextAction, 'none');
});

test('C4 replan-guard: 인계 후 파일 변경을 직접 거부한다', t => {
  const root = temporary(t), file = join(root, 'source.txt');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', shell: false, windowsHide: true });
  git('init', '-q'); writeFileSync(file, 'before'); git('add', 'source.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const store = { need: () => ({ path: root }), lock: () => undefined };
  const mission = { replanPending: true, replanContext: { trees: { p: snapshotTree(root) } } };
  assert.doesNotThrow(() => assertReplanTrees(store, mission));
  writeFileSync(file, 'after');
  assert.throws(() => assertReplanTrees(store, mission), { code: 'stale-replan' });
});

test('C4 delegation: 승인 조건과 복구 횟수 한도를 독립적으로 검사한다', () => {
  const context = { failure: { state: 'verification-failed' }, codeAgentWorkId: 'work', remote: {
    work: { id: 'work' }, consents: { readable: true, open: [] }, request: { status: 'confirmed' },
    approval: { status: 'approved' }, resume: { code: 'ready' },
  } };
  assert.equal(delegationVerdict(context, { action: 'repair' }, 0).allowed, true);
  assert.equal(delegationVerdict(context, { action: 'repair' }, 2).code, 'recovery-limit');
  context.remote.consents.open.push({ id: 'human' });
  assert.equal(delegationVerdict(context, { action: 'repair' }, 0).code, 'external-approval-required');
});

test('C4 command: 실패 종료도 반환 증거를 봉인하고 출력 원문은 저장하지 않는다', async t => {
  const { store, root, mission } = setup(t);
  const result = await runCheck(store, { missionId: mission.id, attemptId: 'a' }, { id: 'check',
    executable: process.execPath, args: ['-e', "console.log('private-command-output');process.exit(7)"], timeoutMs: 5000 }, root);
  assert.equal(result.exitCode, 7);
  const record = store.list('command-run', { missionId: mission.id })[0];
  assert.equal(record.state, 'returned'); assert.equal(record.exitCode, 7);
  assertSealed(record);
  assert.ok(!JSON.stringify(record).includes('private-command-output'));
});

test('C4 seal: 저장 revision 변경은 허용하지만 증거 내용 변경은 거부한다', () => {
  const record = { id: 'evidence', revision: 1, digest: 'original' };
  record.seal = sealOf(record);
  assert.doesNotThrow(() => assertSealed({ ...record, revision: 2 }));
  assert.throws(() => assertSealed({ ...record, digest: 'changed' }), { code: 'invalid-evidence' });
});

test('C4 recovery-schema: 실제 근거와 허용 파일에 묶인 수정만 허용한다', () => {
  const context = { references: ['failure'], recipe: { allowedPaths: ['source.mjs'] } };
  const proposal = { schemaVersion: 1, action: 'repair', category: 'implementation', summary: '값 수정', cause: '검사 실패',
    references: ['failure'], alternatives: ['범위 내 수정'], steps: [{ instruction: '값 수정', paths: ['source.mjs'], references: ['failure'] }],
    question: '', recommendation: '', uncertainties: [] };
  assert.doesNotThrow(() => validateRecovery(proposal, context));
  assert.throws(() => validateRecovery({ ...proposal, references: ['invented'] }, context), { code: 'invalid-recovery' });
  assert.throws(() => validateRecovery({ ...proposal, steps: [{ ...proposal.steps[0], paths: ['policy.txt'] }] }, context), { code: 'recovery-out-of-scope' });
});

test('C4 catalog: 등록 해제는 폴더를 보존하고 그룹 구성에서만 제외한다', t => {
  const { store, engine, mission, fixture } = setup(t, { plan: false }), project = fixture.projects[0];
  const catalog = new Catalog(store);
  engine.control(mission.id, 'cancel', mission.revision);
  catalog.remove(project.id, store.need('project', project.id).revision);
  assert.ok(existsSync(project.path));
  assert.ok(!catalog.groups()[0].projectIds.includes(project.id));
  assert.equal(catalog.projects().some(p => p.id === project.id), false);
});

test('C4 process: 생존 확인 권한 거부는 종료로 간주하지 않는다', t => {
  const kill = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  assert.equal(alive(1234), true);
  assert.equal(alive(0), false); assert.equal(alive(-1), false); assert.equal(alive('1234'), false);
  assert.equal(kill.mock.callCount(), 1);
  kill.mock.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  assert.equal(alive(1234), false);
});
