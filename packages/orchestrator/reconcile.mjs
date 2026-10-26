import { randomUUID } from 'node:crypto';
import { Engine } from './engine.mjs';
import { LiveVerification } from '../verification/live-verification.mjs';
import { snapshotTree, changesBetween, checkpointsCurrent, allowedChange } from '../verification/tree.mjs';
import { assertSealed, sealOf } from '../verification/seal.mjs';
import { requireThat, now, string, hash } from '../domain/contracts.mjs';
import { taskHeld } from './scope.mjs';

export class Reconciliation {
  constructor(store) { this.store = store; this.engine = new Engine(store); this.verifier = new LiveVerification(store); }
  async verification(id, attemptId, host, { expectedRevision, expectedState } = {}) {
    string(expectedState, 'expectedState');
    const { m, attempt, project, task } = this.verifier.locate(id, attemptId, expectedRevision);
    requireThat(attempt.state === 'unknown' && attempt.activeVerificationRunId && attempt.recipe && !attempt.recoveryBusy && !taskHeld(this.store, m, task.id), 'invalid-state', '현재 검증 실행이 미확인인 시도만 대조할 수 있습니다.');
    const run = this.store.need('verification-run', attempt.activeVerificationRunId);
    requireThat(run.missionId === id && run.attemptId === attemptId && ['running', 'unknown'].includes(run.state), 'invalid-evidence', '현재 시도의 미확인 검증 기록이 필요합니다.');
    if (run.state === 'unknown') assertSealed(run);
    requireThat(!this.store.list('delivery-run').some(r => r.attemptId === attemptId && ['running', 'unknown'].includes(r.state)), 'unsettled-process', '반영 검사 프로세스는 별도로 정리해야 합니다.');
    const commands = this.store.list('command-run').filter(r => r.verificationRunId === run.id);
    requireThat(commands.length === attempt.recipe.checks.length && attempt.recipe.checks.every(check => {
      const matches = commands.filter(c => c.checkId === check.id);
      return matches.length === 1 && matches[0].missionId === id && matches[0].attemptId === attemptId && matches[0].commandHash === hash(check) &&
        matches[0].state === 'returned' && Number.isInteger(matches[0].exitCode);
    }), 'unsettled-process', '모든 등록 검증 명령의 정상 반환 기록이 필요합니다. 미반환·시간 초과·부분 실행은 자동 정리하지 않습니다.');
    commands.forEach(assertSealed);
    const remote = await host.inspect(project, expectedState, attempt.turns.at(-1)?.result?.sessionId);
    requireThat(remote.stateVersion === expectedState, 'stale-remote-state', '원격 상태가 변경됐습니다.');
    this.verifier.remoteReady(remote, attempt);
    requireThat(['none', 'released', 'idle'].includes(remote.ownership?.lease?.state), 'remote-busy', '활성 임대가 있습니다.');
    this.verifier.inputsCurrent(m, project.id, task.id);
    const tree = snapshotTree(project.path);
    requireThat(tree.head === run.before.head && tree.digest === run.before.digest && tree.head === attempt.baseline.head &&
      changesBetween(attempt.baseline, tree).every(p => allowedChange(attempt.recipe, attempt.codeAgentWorkId, p)) && checkpointsCurrent(m, project.id), 'stale-evidence', '검증 입력 파일·HEAD·선행 산출물이 변경됐습니다.');
    return this.store.transaction(() => {
      const current = this.verifier.locate(id, attemptId, expectedRevision);
      const d = this.engine.decision(current.m, 'reconcile-verification', { reason: '모든 검증 명령의 정상 반환과 변경 없는 입력을 확인했습니다. 기존 실행을 정리하고 새 독립 검증을 요구합니다.',
        evidence: [run.id, ...commands.map(c => c.id)], alternatives: ['미확인 상태 유지', '입력 재검증'], nextAction: 'verify-live', verification: task.verification });
      const record = { id: randomUUID(), missionId: id, attemptId, verificationRunId: run.id, commandIds: commands.map(c => c.id), remote, tree, decisionId: d.id, at: now() };
      record.seal = sealOf(record); this.store.put('reconciliation', record);
      run.state = 'reconciled'; run.reconciliationId = record.id; run.seal = sealOf(run); this.store.put('verification-run', run, run.revision);
      current.attempt.state = 'awaiting-verification'; current.attempt.reconciliationPending = record.id; delete current.attempt.activeVerificationRunId;
      current.m.tasks.find(t => t.id === task.id).state = 'awaiting-verification'; current.m.state = 'blocked'; current.m.reason = d.reason;
      return this.engine.save(current.m, 'live-reconciled', { reconciliationId: record.id, decisionId: d.id });
    });
  }
  async reconcile(id, attemptId, host, { expectedRevision, expectedState } = {}) {
    string(expectedState, 'expectedState');
    const { m, attempt, project, task } = this.verifier.locate(id, attemptId, expectedRevision);
    requireThat(attempt.state === 'unknown' && attempt.recipe && attempt.baseline && !attempt.recoveryBusy && !taskHeld(this.store, m, task.id),
      'invalid-state', '검증 계약을 가진 미확인 호스트 시도만 대조할 수 있습니다.');
    // 실제 검증 명령이나 반영 재검사가 중단된 경우에는 호스트 반환만으로 복구할 수 없다.
    const verification = this.store.list('verification-run').filter(r => r.attemptId === attemptId);
    const delivery = this.store.list('delivery-run').filter(r => r.attemptId === attemptId);
    requireThat(!verification.some(r => ['running', 'unknown'].includes(r.state)) && !delivery.some(r => ['running', 'unknown'].includes(r.state)), 'unsettled-process', '검증 프로세스 종료 여부를 확인해야 합니다.');
    const returned = attempt.invocationId ? this.store.get('host-return', attempt.invocationId) : undefined;
    requireThat(returned, 'missing-return', '현재 호스트 호출의 영속 반환 기록이 없습니다. 자동 재실행하지 않습니다.');
    assertSealed(returned);
    requireThat(returned.missionId === id && returned.attemptId === attemptId && returned.planVersion === attempt.planVersion && returned.codeAgentWorkId === attempt.codeAgentWorkId &&
      returned.result.status === 'returned' && !returned.result.permissionDenials?.length, 'invalid-return', '현재 호출의 정상 반환 증거가 필요합니다.');
    const remote = await host.inspect(project, expectedState, returned.result.sessionId);
    requireThat(remote.stateVersion === expectedState, 'stale-remote-state', '원격 상태가 변경됐습니다.');
    const evidenceAttempt = { ...attempt, turns: [{ result: returned.result }] };
    this.verifier.remoteReady(remote, evidenceAttempt);
    requireThat(['none', 'released', 'idle'].includes(remote.ownership?.lease?.state), 'remote-busy', '활성 임대 상태는 복구하지 않습니다.');
    this.verifier.inputsCurrent(m, project.id, task.id);
    const tree = snapshotTree(project.path);
    requireThat(tree.head === attempt.baseline.head && changesBetween(attempt.baseline, tree).every(p => allowedChange(attempt.recipe, attempt.codeAgentWorkId, p)) && checkpointsCurrent(m, project.id),
      'out-of-scope-change', '기준 커밋·변경 범위·선행 산출물이 다릅니다.');
    return this.store.transaction(() => {
      const current = this.verifier.locate(id, attemptId, expectedRevision);
      const d = this.engine.decision(current.m, 'reconcile-live', { reason: '현재 호출의 정상 반환과 동일 작업·검증 가능 상태를 대조했습니다. 호스트를 재실행하지 않고 독립 검증으로 이동합니다.',
        evidence: [returned.id, `state:${expectedState}`, `tree:${tree.digest}`], alternatives: ['미확인 상태 유지', '독립 검증으로 이동'], nextAction: 'verify-live', verification: task.verification });
      const record = { id: randomUUID(), missionId: id, attemptId, invocationId: returned.id, decisionId: d.id, remote, tree, at: now() };
      record.seal = sealOf(record); this.store.put('reconciliation', record);
      current.attempt.turns.push({ id: randomUUID(), at: now(), result: returned.result, state: remoteStateSummary(remote, returned.result.control?.runId), disposition: 'awaiting-verification', reconciliationId: record.id });
      current.attempt.state = 'awaiting-verification'; current.attempt.reconciliationPending = record.id;
      current.m.tasks.find(t => t.id === task.id).state = 'awaiting-verification'; current.m.state = 'blocked'; current.m.reason = d.reason;
      return this.engine.save(current.m, 'live-reconciled', { reconciliationId: record.id, decisionId: d.id });
    });
  }
}
import { remoteStateSummary } from './remote-state.mjs';
