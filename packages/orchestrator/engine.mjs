import { simulate } from './simulation-graph.mjs';
import { randomUUID } from 'node:crypto';
import { Catalog } from '../catalog/catalog.mjs';
import { Knowledge } from '../knowledge/sources.mjs';
import { checkpointsCurrent } from '../verification/tree.mjs';
import { relevantSource, taskHeld, activeHolds } from './scope.mjs';
import { assertReplanTrees } from './replan-guard.mjs';
import { missionProgress } from './progress.mjs';
import { observationIdentity } from '../code-agent-adapter/observe.mjs';
import { requireThat, string, strings, object, hash, now, validateMission, validatePlan } from '../domain/contracts.mjs';

const finished = new Set(['simulation-complete', 'succeeded', 'cancelled']);
const activePlan = mission => mission.plans.at(-1);
const taskState = (mission, id) => {
  const state = mission.tasks.find(t => t.id === id);
  requireThat(state, 'not-found', `작업 ${id}를 찾을 수 없습니다.`); return state;
};

export class Engine {
  constructor(store) { this.store = store; this.catalog = new Catalog(store); }
  create(input, { inTransaction = false } = {}) {
    validateMission(input);
    const request = structuredClone(input);
    const persist = () => {
      const fingerprint = hash(request);
      const previous = this.store.db.prepare('SELECT * FROM requests WHERE key=?').get(request.requestKey);
      if (previous) {
        requireThat(previous.hash === fingerprint, 'request-conflict', '같은 접수 키의 내용이 다릅니다.');
        return this.store.need('mission', previous.mission_id);
      }
      const mission = {
        id: randomUUID(), goal: request.goal, mode: request.mode, criteria: request.criteria,
        ...(request.taskNumber === undefined ? {} : { taskNumber: request.taskNumber }),
        scope: this.catalog.snapshot(request.scope), requestedScope: request.scope,
        state: 'received', plans: [], tasks: [], attempts: [], createdAt: now(), reason: '실행 계획이 필요합니다.',
      };
      const saved = this.store.put('mission', mission);
      this.store.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(request.requestKey, fingerprint, mission.id);
      this.store.event(mission.id, 'mission-created', { mode: mission.mode });
      return saved;
    };
    return inTransaction ? persist() : this.store.transaction(persist);
  }
  checked(id, revision) {
    const mission = this.store.need('mission', id);
    requireThat(Number.isInteger(revision) && revision === mission.revision, 'stale-state', '기대 상태 버전이 다릅니다. 다시 조회하세요.');
    return mission;
  }
  decision(mission, action, details) {
    const d = {
      id: randomUUID(), missionId: mission.id, actor: 'rule-engine', action,
      expectedRevision: mission.revision, planVersion: activePlan(mission)?.version ?? 0,
      at: now(), ...details,
    };
    for (const field of ['reason', 'nextAction', 'verification']) string(d[field], `decision.${field}`);
    strings(d.evidence, 'decision.evidence', true);
    strings(d.alternatives, 'decision.alternatives', true);
    this.store.put('decision', d);
    this.store.event(mission.id, 'decision-recorded', { decisionId: d.id, action });
    return d;
  }
  save(mission, type, payload = {}) {
    const saved = this.store.put('mission', mission, mission.revision);
    this.store.event(mission.id, type, payload);
    return saved;
  }
  plan(id, proposal, expectedRevision, { analysisId } = {}) {
    const copy = structuredClone(proposal);
    return this.store.transaction(() => {
      const mission = this.checked(id, expectedRevision);
      requireThat(mission.state !== 'analyzing' || analysisId === mission.analysisRunId, 'analysis-in-progress', '분석 중에는 해당 분석 결과만 계획으로 적용할 수 있습니다.');
      requireThat(!finished.has(mission.state) && mission.state !== 'paused', 'invalid-state', '종료되었거나 일시 정지된 목표의 계획을 바꿀 수 없습니다.');
      requireThat(!mission.tasks.some(t => ['running', 'unknown'].includes(t.state)) && !mission.attempts.some(a => a.mode === 'live' && !['succeeded', 'abandoned'].includes(a.state)), 'unsettled-attempt', '실행 중이거나 확인되지 않은 시도와 실제 개발 인계를 먼저 해결해야 합니다.');
      assertReplanTrees(this.store, mission);
      const projects = mission.scope.projectIds.map(pid => this.store.need('project', pid));
      const knowledge = new Knowledge(this.store);
      const sourceSnapshotIds = projects.filter(p => p.knowledgeSnapshotId).map(p => knowledge.current(p.id).id);
      let analysis;
      if (analysisId) {
        analysis = this.store.need('analysis-run', analysisId);
        requireThat(analysis.missionId === id && analysis.status === 'ready' && analysis.expectedMissionRevision === expectedRevision &&
          hash(analysis.result.plan) === hash(copy), 'invalid-analysis-binding', '현재 목표·계획과 분석 결과가 일치하지 않습니다.');
        for (const p of analysis.context.projects) requireThat(projects.some(current => current.id === p.id && current.revision === p.revision) &&
          (p.observationIdentity ? observationIdentity(this.store.get('observation', p.id)) === p.observationIdentity :
            (this.store.get('observation', p.id)?.revision ?? 0) === p.observationRevision), 'stale-context', '분석 입력이 변경됐습니다.');
      }
      validatePlan(copy, mission, projects);
      const version = mission.plans.length + 1;
      const snapshots = projects.map(p => ({ id: p.id, revision: p.revision }));
      const decision = this.decision(mission, 'activate-plan', {
        reason: copy.summary, evidence: [...new Set(copy.tasks.flatMap(t => t.references))],
        alternatives: ['현재 계획 유지', '검증한 새 계획 적용'],
        nextAction: `계획 ${version} 활성화`, verification: '범위·도메인·의존 관계·완료 조건 검증 통과',
        inputHash: hash({ proposal: copy, projects: snapshots }), projectVersions: snapshots,
        ...(analysis ? { actor: 'ai+validator', analysisId, provider: analysis.provider, model: analysis.model, choices: analysis.result.decisions } : {}),
      });
      mission.plans.push({ version, proposal: copy, projectVersions: snapshots, sourceSnapshotIds, decisionId: decision.id,
        ...(analysis ? { analysisId, observationVersions: analysis.context.projects.map(p => ({ id: p.id, revision: p.observationRevision, identity: p.observationIdentity })) } : {}), at: now() });
      // 첫 단계에서는 증거 재사용을 추측하지 않는다. 새 계획은 모든 작업을 다시 검증한다.
      mission.tasks = copy.tasks.map(t => ({ id: t.id, state: 'queued', attemptIds: [], evidenceIds: [] }));
      mission.verificationRecipes = {}; mission.liveCheckpoints = {};
      mission.replanPending = false;
      mission.state = 'planned'; mission.planningHold = false; mission.reason = '실행할 계획이 준비됐습니다.';
      return this.save(mission, 'plan-activated', { version, decisionId: decision.id });
    });
  }
  projectVersionsMatch(mission, taskId) {
    const plan = activePlan(mission);
    if (!plan.projectVersions.every(p => this.store.need('project', p.id).revision === p.revision)) return false;
    if (mission.mode !== 'live' && !(plan.observationVersions ?? []).every(p => p.identity ? observationIdentity(this.store.get('observation', p.id)) === p.identity : (this.store.get('observation', p.id)?.revision ?? 0) === p.revision)) return false;
    try {
      if (!checkpointsCurrent(mission)) return false;
      for (const id of plan.sourceSnapshotIds ?? []) {
        const snapshot = this.store.need('knowledge-snapshot', id);
        new Knowledge(this.store).assertFresh({ ...snapshot, sources: snapshot.sources.filter(s => s.kind !== 'code' || !mission.liveCheckpoints?.[snapshot.projectId] && relevantSource(this.store, mission, taskId, snapshot)) });
      }
    }
    catch { return false; }
    return true;
  }
  describe(id) {
    const m = this.store.need('mission', id);
    const plan = activePlan(m);
    const tasks = plan ? plan.proposal.tasks.map(t => {
      const state = taskState(m, t.id);
      let waitingFor = [];
      if (state.state === 'queued') {
        waitingFor = t.dependsOn.filter(dep => taskState(m, dep).state !== 'succeeded').map(dep => `dependency:${dep}`);
        if (this.store.lock(t.projectId)) waitingFor.push(`project-busy:${t.projectId}`);
        if (!this.projectVersionsMatch(m, t.id)) waitingFor.push('project-knowledge-changed');
        if (taskHeld(this.store, m, t.id)) waitingFor.push('recovery-held');
        if (m.state === 'paused') waitingFor.push('mission-paused');
        if (m.state === 'analyzing' || m.planningHold) waitingFor.push('analysis-hold');
      }
      return { ...t, ...state, waitingFor };
    }) : [];
    const events = this.store.events(id);
    const decisions = events.filter(e => e.type === 'decision-recorded').map(e => this.store.need('decision', e.decisionId));
    const evidence = this.store.list('evidence').filter(e => e.missionId === id);
    const analyses = events.filter(e => e.type === 'analysis-started').map(e => this.store.need('analysis-run', e.runId)).map(r => ({ id: r.id, status: r.status, provider: r.provider, model: r.model, promptVersion: r.promptVersion, contextHash: r.contextHash, passes: r.passes.length, result: r.result ?? null, error: r.error ?? null }));
    const verifications = events.filter(e => e.type === 'verification-started').map(e => this.store.need('verification-run', e.runId)).map(r => ({
      id: r.id, attemptId: r.attemptId, state: r.state, decisionId: r.decisionId, changedPaths: r.changedPaths,
      beforeHash: r.before.digest, afterHash: r.after?.digest ?? null, checks: r.checks, artifacts: r.artifacts ?? [], error: r.error ?? null, seal: r.seal ?? null,
    }));
    const live = m.attempts.find(a => a.mode === 'live' && !['running', 'succeeded', 'abandoned'].includes(a.state));
    const recoveries = events.filter(e => e.type === 'recovery-started').map(e => this.store.need('recovery-run', e.runId));
    const replans = events.filter(e => e.type === 'replan-handed-off').map(e => this.store.need('replan-handoff', e.handoffId));
    const deliveries = events.filter(e => e.type === 'delivery-started').map(e => this.store.need('delivery-run', e.runId));
    const reconciliations = events.filter(e => e.type === 'live-reconciled').map(e => this.store.need('reconciliation', e.reconciliationId));
    const commands = this.store.list('command-run').filter(c => c.missionId === id);
    const progress = missionProgress(this.store, m, tasks, events);
    return { ...m, recoveryHolds: activeHolds(this.store, m).map(r => ({ runId: r.id, attemptId: r.attemptId, action: r.proposal?.action, category: r.proposal?.category })), taskDetails: tasks, decisions, evidence, analyses, verifications, recoveries, replans, deliveries, reconciliations, commands, events,
      progress, nextAction: finished.has(m.state) ? 'none' : m.state === 'paused' ? 'resume' :
        activeHolds(this.store, m).length && !tasks.some(t => t.state === 'queued' && !t.waitingFor.length) ? 'review-recovery' : m.attempts.some(a => a.recoveryBusy) ? 'wait-for-recovery' :
        m.state === 'analyzing' ? 'wait-for-analysis' : live ? (live.state === 'unknown' ? 'reconcile-live-ownership' : live.state === 'verified' ? 'handoff-live' : live.state === 'verifying' ? 'wait-for-verification' : live.state === 'verification-failed' ? 'repair-live-task' : live.state === 'waiting-decision' ? 'answer-in-code-agent-host' : 'review-live-checkpoint') : m.planningHold ? (m.state === 'waiting-decision' ? 'human-decision' : 'review-analysis') :
        !plan ? 'provide-plan' : m.tasks.some(t => t.state === 'unknown') ? 'reconcile-unknown-attempt' :
        !this.projectVersionsMatch(m) ? 'replan-project-changed' :
        tasks.some(t => t.state === 'queued' && !t.waitingFor.length) ? 'dispatch-ready-task' :
        m.tasks.every(t => t.state === 'succeeded') ? 'verify-completion' : 'review-blockers' };
  }
  prepare(id, expectedRevision) {
    return this.store.transaction(() => {
      const m = this.checked(id, expectedRevision);
      requireThat(m.mode === 'simulation', 'live-runner-unavailable', '모의 실행 엔진에서는 live 목표를 실행할 수 없습니다.');
      requireThat(['planned', 'executing', 'blocked'].includes(m.state) && !m.planningHold && activePlan(m), 'invalid-state', '분석·재검토·일시 정지 중이거나 배정할 계획이 없습니다.');
      if (!this.projectVersionsMatch(m)) {
        m.state = 'blocked'; m.reason = '프로젝트 지식이나 기존 계획이 바뀌었습니다. 재계획이 필요합니다.';
        this.save(m, 'dispatch-blocked', { reason: 'project-knowledge-changed' }); return null;
      }
      const plan = activePlan(m);
      const task = plan.proposal.tasks.find(t => taskState(m, t.id).state === 'queued' &&
        t.dependsOn.every(dep => taskState(m, dep).state === 'succeeded') && !this.store.lock(t.projectId));
      if (!task) {
        if (!m.tasks.some(t => t.state === 'running')) {
          const reason = m.tasks.some(t => t.state === 'unknown') ? '실행 여부가 미확인인 작업이 있습니다.' :
            m.tasks.some(t => t.state === 'failed') ? '실패한 선행 작업을 검토해야 합니다.' : '다른 목표가 사용 중인 프로젝트 또는 선행 작업을 기다립니다.';
          if (m.state !== 'blocked' || m.reason !== reason) { m.state = 'blocked'; m.reason = reason; this.save(m, 'dispatch-blocked', { reason }); }
        }
        return null;
      }
      const inputEvidence = task.dependsOn.flatMap(dep => taskState(m, dep).evidenceIds);
      const decision = this.decision(m, 'dispatch', {
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
      this.save(m, 'attempt-started', { attemptId: ticket.id, decisionId: decision.id });
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
      const currentInputs = this.projectVersionsMatch(m);
      const disposition = !currentInputs ? 'unknown' : !valid ? 'unknown' : result.status;
      const decision = this.decision(m, 'accept-result', {
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
      return this.save(m, 'result-recorded', { attemptId: attempt.id, disposition, decisionId: decision.id });
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
      const m = this.checked(id, expectedRevision);
      requireThat(!finished.has(m.state) && !['paused', 'analyzing', 'waiting-decision'].includes(m.state) && !m.planningHold && m.tasks.length, 'invalid-state', '완료 판정할 수 없는 상태입니다.');
      requireThat(m.mode === 'simulation', 'live-runner-unavailable', '실제 완료 판정 어댑터가 없습니다.');
      requireThat(this.projectVersionsMatch(m), 'stale-evidence', '프로젝트 조건이 바뀌어 재검증이 필요합니다.');
      requireThat(m.tasks.every(t => t.state === 'succeeded'), 'incomplete', '모든 작업이 성공해야 합니다.');
      const evidence = m.tasks.flatMap(t => t.evidenceIds.map(e => this.store.need('evidence', e)));
      requireThat(evidence.every(e => e.planVersion === activePlan(m).version && e.hash === hash(e.contents) &&
        e.attemptId === taskState(m, e.taskId).attemptIds.at(-1)), 'stale-evidence', '증거와 현재 계획·시도가 다릅니다.');
      for (const task of activePlan(m).proposal.tasks.filter(t => ['verification', 'integration'].includes(t.kind))) {
        requireThat(task.criteria.every(id => evidence.some(e => e.taskId === task.id && e.checks.some(c => c.criterionId === id && c.passed))), 'missing-evidence', '완료 조건의 검증 근거가 없습니다.');
      }
      const d = this.decision(m, 'complete-simulation', {
        reason: '모의 작업과 완료 조건의 모의 증거를 확인했습니다. 실제 개발 완료가 아닙니다.',
        evidence: evidence.map(e => e.id), alternatives: ['추가 검증', '모의 실행 완료'],
        nextAction: 'simulation-complete', verification: '현재 계획·시도·증거 해시·조건별 모의 검증 확인',
      });
      m.state = 'simulation-complete'; m.reason = d.reason;
      return this.save(m, 'simulation-completed', { decisionId: d.id });
    });
  }
  control(id, action, expectedRevision, taskId) {
    return this.store.transaction(() => {
      const m = this.checked(id, expectedRevision);
      requireThat(!finished.has(m.state), 'invalid-state', '종료된 목표입니다.');
      requireThat(['pause', 'resume', 'retry'].includes(action), 'invalid-input', '지원하지 않는 제어 동작입니다.');
      if (action === 'pause') requireThat(m.state !== 'paused', 'invalid-state', '이미 일시 정지 중입니다.');
      if (action === 'resume') requireThat(m.state === 'paused', 'invalid-state', '일시 정지 상태가 아닙니다.');
      if (action === 'retry') {
        requireThat(m.state !== 'analyzing' && !m.planningHold, 'invalid-state', '계획 재검토 중에는 이전 작업을 재시도할 수 없습니다.');
        requireThat(m.state !== 'paused', 'invalid-state', '먼저 일시 정지를 해제하세요.');
        requireThat(taskState(m, taskId).state === 'failed', 'invalid-state', '실패가 확인된 모의 작업만 재시도할 수 있습니다.');
        requireThat(this.projectVersionsMatch(m), 'stale-state', '프로젝트 정보가 바뀌었습니다. 재계획하세요.');
      }
      const d = this.decision(m, action, {
        reason: `사용자가 ${action}을 요청했습니다.`, evidence: [`mission:${m.id}@${m.revision}`],
        alternatives: ['현재 상태 유지', action], nextAction: action,
        verification: '현재 상태와 제어 동작 조건 대조', ...(taskId ? { taskId } : {}),
      });
      if (action === 'pause') m.state = 'paused';
      if (action === 'resume') m.state = m.planningHold ? 'blocked' : activePlan(m) ? 'planned' : 'received';
      if (action === 'retry') { taskState(m, taskId).state = 'queued'; m.state = 'planned'; }
      m.reason = d.reason;
      return this.save(m, action, { decisionId: d.id });
    });
  }
  markUnknown(id, attemptId, expectedRevision) {
    return this.store.transaction(() => {
      const m = this.checked(id, expectedRevision);
      const attempt = m.attempts.find(a => a.id === attemptId);
      requireThat(['running', 'verifying'].includes(attempt?.state), 'invalid-state', '실행 또는 검증 중인 시도가 아닙니다.');
      const d = this.decision(m, 'mark-unknown', {
        reason: '실행 결과를 확인할 수 없어 자동 재실행을 막습니다.', evidence: [attempt.decisionId],
        alternatives: ['자동 재실행', '미확인 상태로 보존'], nextAction: 'reconcile-unknown-attempt',
        verification: '종료·부작용 대조가 필요합니다.',
      });
      attempt.state = 'unknown'; taskState(m, attempt.taskId).state = 'unknown';
      if (m.state !== 'paused') m.state = 'blocked';
      m.reason = d.reason;
      return this.save(m, 'attempt-unknown', { attemptId, decisionId: d.id });
    });
  }
  step(id, runner) { return simulate(this, id, runner, false); }
  run(id, runner) { return simulate(this, id, runner, true); }
}
