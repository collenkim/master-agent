import { randomUUID } from 'node:crypto';
import { requireThat, hash, now } from '../domain/contracts.mjs';
import { terminalMission } from '../storage/retention.mjs';
import { taskState } from '../orchestrator/engine.mjs';

const activePlan = mission => mission.plans.at(-1);

export class SimulationExecution {
  constructor(engine) { this.engine = engine; this.store = engine.store; }
  prepare(id, expectedRevision) {
    return this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision);
      requireThat(m.mode === 'simulation', 'live-runner-unavailable', '모의 실행 엔진에서는 live 목표를 실행할 수 없습니다.');
      requireThat(['planned', 'executing', 'blocked'].includes(m.state) && !m.planningHold && activePlan(m), 'invalid-state', '분석·재검토·일시 정지 중이거나 배정할 계획이 없습니다.');
      if (!this.engine.projectVersionsMatch(m)) {
        m.state = 'blocked'; m.reason = '프로젝트 지식이나 기존 계획이 바뀌었습니다. 재계획이 필요합니다.';
        this.engine.save(m, 'dispatch-blocked', { reason: 'project-knowledge-changed' }); return null;
      }
      const plan = activePlan(m);
      const task = plan.proposal.tasks.find(t => taskState(m, t.id).state === 'queued' &&
        t.dependsOn.every(dep => taskState(m, dep).state === 'succeeded') && !this.store.lock(t.projectId));
      if (!task) {
        if (!m.tasks.some(t => t.state === 'running')) {
          const reason = m.tasks.some(t => t.state === 'unknown') ? '실행 여부가 미확인인 작업이 있습니다.' :
            m.tasks.some(t => t.state === 'failed') ? '실패한 선행 작업을 검토해야 합니다.' : '다른 목표가 사용 중인 프로젝트 또는 선행 작업을 기다립니다.';
          if (m.state !== 'blocked' || m.reason !== reason) { m.state = 'blocked'; m.reason = reason; this.engine.save(m, 'dispatch-blocked', { reason }); }
        }
        return null;
      }
      const inputEvidence = task.dependsOn.flatMap(dep => taskState(m, dep).evidenceIds);
      const decision = this.engine.decision(m, 'dispatch', {
        reason: task.rationale, evidence: [...task.references, ...inputEvidence],
        alternatives: ['선행 작업 대기', '실행 가능한 작업 배정'], nextAction: task.goal,
        verification: task.verification, projectVersions: plan.projectVersions,
        inputHash: hash({ task, inputEvidence, plan: plan.version }),
      });
      const ticket = {
        id: randomUUID(), token: randomUUID(), missionId: id, planVersion: plan.version,
        taskId: task.id, projectId: task.projectId, decisionId: decision.id,
        inputEvidence, state: 'running', startedAt: now(), mode: 'simulation',
      };
      this.store.acquire(task.projectId, id, ticket.id);
      m.attempts.push(ticket);
      const state = taskState(m, task.id); state.state = 'running'; state.attemptIds.push(ticket.id);
      m.state = 'executing'; m.reason = `모의 작업 ${task.id} 실행 중`;
      this.engine.save(m, 'attempt-started', { attemptId: ticket.id, decisionId: decision.id });
      return { ...ticket, task, project: this.store.need('project', task.projectId) };
    });
  }
  accept(ticket, result) {
    return this.store.transaction(() => {
      const m = this.store.need('mission', ticket.missionId);
      const attempt = m.attempts.find(a => a.id === ticket.id);
      requireThat(attempt && attempt.token === ticket.token, 'invalid-ticket', '실행 소유권이 일치하지 않습니다.');
      requireThat(attempt.mode === 'simulation' && m.mode === 'simulation', 'wrong-mode', '실제 개발 결과를 모의 결과로 수용할 수 없습니다.');
      requireThat(attempt.state === 'running' && activePlan(m).version === attempt.planVersion &&
        taskState(m, attempt.taskId).attemptIds.at(-1) === attempt.id, 'stale-result', '이전 시도 또는 종료된 시도의 결과입니다.');
      const task = activePlan(m).proposal.tasks.find(t => t.id === attempt.taskId);
      const state = taskState(m, task.id);
      const valid = this.validateResult(result, task);
      const currentInputs = this.engine.projectVersionsMatch(m);
      const disposition = !currentInputs ? 'unknown' : !valid ? 'unknown' : result.status;
      const decision = this.engine.decision(m, 'accept-result', {
        reason: !currentInputs ? '실행 중 프로젝트 조건 변경: 결과를 격리합니다.' : !valid ? '형식이 불명확한 결과: 성공으로 수용하지 않습니다.' : result.summary,
        evidence: [attempt.decisionId, `result-sha256:${hash(result ?? null)}`],
        alternatives: ['결과 수용', '실패 기록', '미확인 결과 격리'], nextAction: disposition,
        verification: task.verification,
      });
      attempt.state = disposition; attempt.finishedAt = now(); attempt.resultHash = hash(result ?? null);
      attempt.result = result ?? null; state.state = disposition;
      if (disposition === 'succeeded') {
        for (const artifact of result.artifacts) {
          const e = {
            id: randomUUID(), missionId: m.id, planVersion: attempt.planVersion, taskId: task.id,
            attemptId: attempt.id, provenance: 'simulation', name: artifact.name,
            contents: artifact.contents, hash: hash(artifact.contents), checks: result.checks,
            decisionId: decision.id, at: now(),
          };
          this.store.put('evidence', e); state.evidenceIds.push(e.id);
        }
      }
      // unknown은 프로세스 종료나 부작용 부재를 증명하지 못하므로 잠금을 유지한다.
      if (disposition !== 'unknown') this.store.release(task.projectId, attempt.id);
      if (m.state !== 'paused') m.state = disposition === 'succeeded' ? 'executing' : 'blocked';
      m.reason = `${task.id}: ${disposition}`;
      return this.engine.save(m, 'result-recorded', { attemptId: attempt.id, disposition, decisionId: decision.id });
    });
  }
  validateResult(result, task) {
    if (!result || result.schemaVersion !== 1 || result.mode !== 'simulation' ||
        !['succeeded', 'failed'].includes(result.status) || typeof result.summary !== 'string' || !result.summary.trim()) return false;
    if (result.status === 'failed') return true;
    if (!Array.isArray(result.artifacts) || !Array.isArray(result.checks)) return false;
    if (!result.artifacts.every(a => a && typeof a.name === 'string' && typeof a.contents === 'string' && a.contents.length)) return false;
    if (new Set(result.artifacts.map(a => a.name)).size !== result.artifacts.length) return false;
    if (!task.outputs.every(output => result.artifacts.some(a => a.name === output))) return false;
    if (!result.checks.every(c => c && task.criteria.includes(c.criterionId) && typeof c.passed === 'boolean')) return false;
    if (['verification', 'integration'].includes(task.kind)) {
      if (new Set(result.checks.map(c => c.criterionId)).size !== result.checks.length) return false;
      return task.criteria.every(id => result.checks.some(c => c.criterionId === id && c.passed === true));
    }
    return true;
  }
  complete(id, expectedRevision) {
    return this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision);
      requireThat(!terminalMission(m) && !['paused', 'analyzing', 'waiting-decision'].includes(m.state) && !m.planningHold && m.tasks.length, 'invalid-state', '완료 판정할 수 없는 상태입니다.');
      requireThat(m.mode === 'simulation', 'live-runner-unavailable', '실제 완료 판정 어댑터가 없습니다.');
      requireThat(this.engine.projectVersionsMatch(m), 'stale-evidence', '프로젝트 조건이 바뀌어 재검증이 필요합니다.');
      requireThat(m.tasks.every(t => t.state === 'succeeded'), 'incomplete', '모든 작업이 성공해야 합니다.');
      const evidence = m.tasks.flatMap(t => t.evidenceIds.map(e => this.store.need('evidence', e)));
      requireThat(evidence.every(e => e.planVersion === activePlan(m).version && e.hash === hash(e.contents) &&
        e.attemptId === taskState(m, e.taskId).attemptIds.at(-1)), 'stale-evidence', '증거와 현재 계획·시도가 다릅니다.');
      for (const task of activePlan(m).proposal.tasks.filter(t => ['verification', 'integration'].includes(t.kind))) {
        requireThat(task.criteria.every(id => evidence.some(e => e.taskId === task.id && e.checks.some(c => c.criterionId === id && c.passed))), 'missing-evidence', '완료 조건의 검증 근거가 없습니다.');
      }
      const d = this.engine.decision(m, 'complete-simulation', {
        reason: '모의 작업과 완료 조건의 모의 증거를 확인했습니다. 실제 개발 완료가 아닙니다.',
        evidence: evidence.map(e => e.id), alternatives: ['추가 검증', '모의 실행 완료'],
        nextAction: 'simulation-complete', verification: '현재 계획·시도·증거 해시·조건별 모의 검증 확인',
      });
      m.state = 'simulation-complete'; m.reason = d.reason;
      return this.engine.save(m, 'simulation-completed', { decisionId: d.id });
    });
  }
  retry(id, expectedRevision, taskId) {
    return this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision);
      requireThat(!terminalMission(m), 'invalid-state', '종료된 목표입니다.');
      requireThat(m.mode === 'simulation', 'wrong-mode', '모의 작업만 retry로 재시도할 수 있습니다. 실제 실행은 복구 절차를 사용하세요.');
      requireThat(m.state !== 'analyzing' && !m.planningHold, 'invalid-state', '계획 재검토 중에는 이전 작업을 재시도할 수 없습니다.');
      requireThat(m.state !== 'paused', 'invalid-state', '먼저 일시 정지를 해제하세요.');
      requireThat(taskState(m, taskId).state === 'failed', 'invalid-state', '실패가 확인된 모의 작업만 재시도할 수 있습니다.');
      requireThat(this.engine.projectVersionsMatch(m), 'stale-state', '프로젝트 정보가 바뀌었습니다. 재계획하세요.');
      const d = this.engine.decision(m, 'retry', {
        actor: 'operator', reason: '사용자가 retry을 요청했습니다.', evidence: [`mission:${m.id}@${m.revision}`],
        alternatives: ['현재 상태 유지', 'retry'], nextAction: 'retry',
        verification: '현재 상태와 제어 동작 조건 대조', taskId,
      });
      taskState(m, taskId).state = 'queued'; m.state = 'planned'; m.reason = d.reason;
      return this.engine.save(m, 'retry', { decisionId: d.id });
    });
  }
}
