import { simulate } from '../simulation/graph.mjs';
import { SimulationExecution } from '../simulation/execution.mjs';
import { randomUUID } from 'node:crypto';
import { Catalog } from '../catalog/catalog.mjs';
import { Knowledge } from '../knowledge/sources.mjs';
import { checkpointsCurrent } from '../verification/tree.mjs';
import { relevantSource, taskHeld, activeHolds } from './scope.mjs';
import { assertReplanTrees } from './replan-guard.mjs';
import { missionProgress } from './progress.mjs';
import { observationIdentity } from '../code-agent-adapter/observe.mjs';
import { clearMissionCheckpoints, EVENT_RETENTION_DAYS, terminalMission } from '../storage/retention.mjs';
import { requireThat, string, strings, hash, now, validateMission, validatePlan } from '../domain/contracts.mjs';

const activePlan = mission => mission.plans.at(-1);
export function taskState(mission, id) {
  const state = mission.tasks.find(t => t.id === id);
  requireThat(state, 'not-found', `작업 ${id}를 찾을 수 없습니다.`); return state;
}

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
      const scope = this.catalog.snapshot(request.scope);
      // 취소한 목표의 업무 번호는 새 접수에 사용할 수 있다. 접수 키는 원래 목표를 유지한다.
      if (request.taskNumber !== undefined) {
        const duplicate = this.store.list('mission').find(m =>
          m.state !== 'cancelled' && m.taskNumber?.toLowerCase() === request.taskNumber.toLowerCase() &&
          m.scope.projectIds.some(projectId => scope.projectIds.includes(projectId)));
        if (duplicate) {
          const projects = duplicate.scope.projectIds.filter(projectId => scope.projectIds.includes(projectId));
          requireThat(false, 'request-conflict', `업무 번호 ${request.taskNumber}는 프로젝트 ${projects.join(', ')}에 이미 접수됐습니다. 기존 목표 ${duplicate.id}에서 이어가세요. 같은 프로젝트에 중복 생성하지 않습니다.`);
        }
      }
      const mission = {
        id: randomUUID(), goal: request.goal, mode: request.mode, criteria: request.criteria,
        ...(request.taskNumber === undefined ? {} : { taskNumber: request.taskNumber }),
        scope, requestedScope: request.scope,
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
    if (terminalMission(mission)) {
      mission.finishedAt ??= now();
      clearMissionCheckpoints(this.store, mission);
    }
    const saved = this.store.put('mission', mission, mission.revision);
    this.store.event(mission.id, type, payload);
    return saved;
  }
  pruneEvents(id, expectedRevision) {
    return this.store.transaction(() => {
      const mission = this.checked(id, expectedRevision);
      requireThat(terminalMission(mission), 'invalid-state', '종료된 목표의 이벤트만 정리한다.');
      const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86400000).toISOString();
      const endedAt = mission.finishedAt ?? this.store.events(id).filter(e => ['live-completed', 'simulation-completed', 'cancel'].includes(e.type)).at(-1)?.at;
      requireThat(endedAt && endedAt < cutoff, 'retention-pending', `목표 종료 후 ${EVENT_RETENTION_DAYS}일이 지나야 이벤트를 정리한다.`);
      const deleted = this.store.db.prepare('DELETE FROM events WHERE mission_id=? AND at<?').run(id, cutoff).changes;
      const decision = this.decision(mission, 'prune-events', { actor: 'operator', reason: `보존 기간이 지난 이벤트 ${deleted}건을 정리했다.`,
        evidence: [`mission:${id}`], alternatives: ['이벤트 유지', '보존 기간 지난 이벤트 정리'], nextAction: 'none', verification: '종료 상태·종료 시각·기대 버전 대조', deleted, cutoff });
      const saved = this.save(mission, 'events-pruned', { decisionId: decision.id, deleted, cutoff });
      return { missionId: id, revision: saved.revision, deleted, cutoff };
    });
  }
  plan(id, proposal, expectedRevision, { analysisId } = {}) {
    const copy = structuredClone(proposal);
    return this.store.transaction(() => {
      const mission = this.checked(id, expectedRevision);
      requireThat(mission.state !== 'analyzing' || analysisId === mission.analysisRunId, 'analysis-in-progress', '분석 중에는 해당 분석 결과만 계획으로 적용할 수 있습니다.');
      requireThat(!terminalMission(mission) && mission.state !== 'paused', 'invalid-state', '종료되었거나 일시 정지된 목표의 계획을 바꿀 수 없습니다.');
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
    // 이벤트 보존 기간과 결정·검증 원본의 수명은 독립적이다.
    const records = kind => this.store.list(kind, { missionId: id });
    const decisions = records('decision');
    const evidence = records('evidence');
    const analyses = records('analysis-run').map(r => ({ id: r.id, status: r.status, provider: r.provider, model: r.model, promptVersion: r.promptVersion, contextHash: r.contextHash, passes: r.passes?.length ?? 0, result: r.result ?? null, error: r.error ?? null }));
    const verifications = records('verification-run').map(r => ({
      id: r.id, attemptId: r.attemptId, state: r.state, decisionId: r.decisionId, changedPaths: r.changedPaths,
      beforeHash: r.before.digest, afterHash: r.after?.digest ?? null, checks: r.checks, artifacts: r.artifacts ?? [], error: r.error ?? null, seal: r.seal ?? null,
    }));
    const live = m.attempts.find(a => a.mode === 'live' && !['running', 'succeeded', 'abandoned'].includes(a.state));
    const recoveries = records('recovery-run');
    const replans = records('replan-handoff');
    const deliveries = records('delivery-run');
    const reconciliations = records('reconciliation');
    const commands = records('command-run');
    const progress = missionProgress(this.store, m, tasks, events);
    return { ...m, recoveryHolds: activeHolds(this.store, m).map(r => ({ runId: r.id, attemptId: r.attemptId, action: r.proposal?.action, category: r.proposal?.category })), taskDetails: tasks, decisions, evidence, analyses, verifications, recoveries, replans, deliveries, reconciliations, commands, events,
      progress, nextAction: terminalMission(m) ? 'none' : m.state === 'paused' ? 'resume' :
        m.replanPending && m.replanRefreshRequired ? `mission replan-refresh ${m.id} --revision ${m.revision}` :
        activeHolds(this.store, m).length && !tasks.some(t => t.state === 'queued' && !t.waitingFor.length) ? 'review-recovery' : m.attempts.some(a => a.recoveryBusy) ? 'wait-for-recovery' :
        m.state === 'analyzing' ? 'wait-for-analysis' : live ? (live.state === 'unknown' ? 'reconcile-live-ownership' : live.state === 'verified' ? 'handoff-live' : live.state === 'verifying' ? 'wait-for-verification' : live.state === 'verification-failed' ? 'repair-live-task' : live.state === 'waiting-decision' ? 'answer-in-code-agent-host' : 'review-live-checkpoint') : m.planningHold ? (m.state === 'waiting-decision' ? 'human-decision' : 'review-analysis') :
        !plan ? 'provide-plan' : m.tasks.some(t => t.state === 'unknown') ? 'reconcile-unknown-attempt' :
        !this.projectVersionsMatch(m) ? 'replan-project-changed' :
        tasks.some(t => t.state === 'queued' && !t.waitingFor.length) ? 'dispatch-ready-task' :
        m.tasks.every(t => t.state === 'succeeded') ? 'verify-completion' : 'review-blockers' };
  }
  prepare(id, expectedRevision) { return new SimulationExecution(this).prepare(id, expectedRevision); }
  accept(ticket, result) { return new SimulationExecution(this).accept(ticket, result); }
  validateResult(result, task) { return new SimulationExecution(this).validateResult(result, task); }
  complete(id, expectedRevision) { return new SimulationExecution(this).complete(id, expectedRevision); }
  control(id, action, expectedRevision, taskId, { reason = '사용자가 목표 취소를 요청했습니다.' } = {}) {
    if (action === 'retry') return new SimulationExecution(this).retry(id, expectedRevision, taskId);
    return this.store.transaction(() => {
      const m = this.checked(id, expectedRevision);
      requireThat(!terminalMission(m), 'invalid-state', '종료된 목표입니다.');
      requireThat(['pause', 'resume', 'cancel'].includes(action), 'invalid-input', '지원하지 않는 제어 동작입니다.');
      if (action === 'cancel') {
        requireThat(!m.attempts.some(a => a.state === 'running'), 'invalid-state', '먼저 mission stop 또는 mission unknown으로 시도를 종료하라.');
        string(reason, 'reason');
      }
      if (action === 'pause') requireThat(m.state !== 'paused', 'invalid-state', '이미 일시 정지 중입니다.');
      if (action === 'resume') requireThat(m.state === 'paused', 'invalid-state', '일시 정지 상태가 아닙니다.');
      const d = this.decision(m, action, {
        actor: 'operator', reason: action === 'cancel' ? reason : `사용자가 ${action}을 요청했습니다.`, evidence: [`mission:${m.id}@${m.revision}`],
        alternatives: ['현재 상태 유지', action], nextAction: action,
        verification: '현재 상태와 제어 동작 조건 대조', ...(taskId ? { taskId } : {}),
      });
      if (action === 'pause') m.state = 'paused';
      if (action === 'resume') m.state = m.planningHold ? 'blocked' : activePlan(m) ? 'planned' : 'received';
      if (action === 'cancel') {
        m.state = 'cancelled'; m.finishedAt = now();
        m.replanPending = false; m.planningHold = false; delete m.recoveryHold;
        for (const attempt of m.attempts) delete attempt.recoveryBusy;
        this.store.db.prepare('DELETE FROM locks WHERE mission_id=?').run(id);
        for (const [kind, field, states] of [
          ['analysis-run', 'status', ['running']],
          ['recovery-run', 'state', ['analyzing', 'authorized', 'held', 'executing']],
        ]) {
          for (const run of this.store.list(kind, { missionId: id }).filter(r => states.includes(r[field]))) {
            this.store.put(kind, { ...run, [field]: 'cancelled', finishedAt: m.finishedAt, cancellationDecisionId: d.id }, run.revision);
          }
        }
        const request = this.store.get('target-request', id);
        if (request) this.store.put('target-request', { ...request, state: 'cancelled', blockers: [], error: null, updatedAt: m.finishedAt }, request.revision);
      }
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
