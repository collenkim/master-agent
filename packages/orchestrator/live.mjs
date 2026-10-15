import { randomUUID } from 'node:crypto';
import { Engine } from './engine.mjs';
import { Knowledge } from '../knowledge/sources.mjs';
import { hash, now, requireThat, string } from '../domain/contracts.mjs';
import { snapshotTree } from '../verification/tree.mjs';
import { sealOf } from '../verification/seal.mjs';
import { taskHeld, relevantSource } from './scope.mjs';

const taskState = (m, id) => m.tasks.find(t => t.id === id);

// other-work 는 지금 작업이 아닌(끝난) 작업의 임대다 — code-agent 도 다음 진행 명령에서 넘겨받는다(lease.ts leaseDecision)
export function ownsLease(state, sessionId) {
  const lease = state.ownership?.lease;
  return ['none', 'released', 'other-work'].includes(lease?.state) || (sessionId && lease?.host === 'claude' && lease.session === sessionId && ['held', 'idle'].includes(lease.state));
}
// master 통신 계약 실행의 권한 거부는 hook·허용 도구가 돌려보낸 기록이다 — 막힘은 실행 끝 상태와 code-agent 재개 판정으로 본다
const denialsBlock = result => Boolean(result?.permissionDenials?.length && !result.control);
/** 위임 판단이 수정 요청을 보낸 회차 — code-agent 는 다시 받을 확인 요청을 사람 몫(needs-human·reapproval-required)으로 보이지만,
 *  고쳐서 다시 준비하는 것은 같은 세션이다. 다시 준비한 확인 요청의 응답은 다시 사람 또는 위임 판단이 한다 */
const REVISE_NEXT = new Set(['confirm-request', 'plan-consent', 'deliver-consent']);
export function revisingTurn(store, attempt, state) {
  const turn = attempt?.turns.at(-1);
  if (!turn || attempt.delegatedTurnId !== turn.id || !['needs-human', 'reapproval-required'].includes(state?.resume?.code) || !REVISE_NEXT.has(state.resume.next?.action)) return false;
  return changeRequests(store, attempt).length > 0;
}
/** 마지막 회차에 위임 판단이 보낸 수정 요청 — 이어 가는 세션에 지시 전문을 준다(판단 요약 메모는 앞부분만 담는다) */
function changeRequests(store, attempt) {
  const turn = attempt.turns.at(-1);
  return store.list('delegation').filter(d => d.attemptId === attempt.id && d.kind === 'consent' && d.state === 'changes-requested' && Date.parse(d.recordedAt) >= Date.parse(turn.at));
}
function ready(state, workId, fresh, sessionId, delegated = false, revising = false) {
  requireThat(state && typeof state.stateVersion === 'string', 'invalid-remote-state', '상태 버전이 필요합니다.');
  requireThat(ownsLease(state, sessionId), 'remote-busy', '다른 호스트의 임대가 남아 있습니다. 종료·해제를 확인하세요.');
  requireThat(state.consents?.readable === true && state.consents.open.length === 0, 'remote-needs-human', '열린 동의를 기존 호스트에서 처리해야 합니다.');
  requireThat(!state.questions?.unanswered?.length && !state.questions?.unverified?.length, 'remote-needs-human', '답변 또는 확인이 필요한 질문이 있습니다.');
  if (fresh && !state.work) requireThat(state.resume.code === 'no-work' && state.request === null, 'remote-busy', '접수 중인 작업이 있거나 시작할 수 없습니다.');
  // 위임으로 요구가 확정됐지만 작업 시작이 막혔다(startBlocked) — 같은 세션이 사유를 정리하고 시작한다
  else if (delegated && !state.work && state.request?.status === 'confirmed') requireThat(['no-work', 'ready'].includes(state.resume.code), 'remote-not-ready', '확정된 요구의 작업을 시작할 수 있는 상태가 아닙니다.');
  else if (revising && !state.work) requireThat(state.request && state.request.status !== 'confirmed', 'remote-not-ready', '수정 요청을 받은 요구를 고칠 수 있는 상태가 아닙니다.');
  else requireThat(state.work?.id === workId && (state.resume.code === 'ready' || revising), 'remote-not-ready', '지정한 code-agent 작업이 실행 가능 상태가 아닙니다.');
}

/** 호스트 한 회차의 배정·관측 계약. 호스트 종료는 개발 완료 증거가 아니다. */
export class LiveExecution {
  constructor(store) { this.store = store; this.engine = new Engine(store); }
  continuationInputs(mission, projectId, taskId) {
    const plan = mission.plans.at(-1);
    requireThat(plan.projectVersions.every(p => this.store.need('project', p.id).revision === p.revision), 'stale-context', '프로젝트 카탈로그가 변경됐습니다.');
    for (const id of plan.sourceSnapshotIds ?? []) {
      const snapshot = this.store.need('knowledge-snapshot', id);
      new Knowledge(this.store).assertFresh({ ...snapshot, sources: snapshot.sources.filter(s => s.kind !== 'code' || snapshot.projectId !== projectId && !mission.liveCheckpoints?.[snapshot.projectId] && relevantSource(this.store, mission, taskId, snapshot)) });
    }
  }
  async dispatch(id, taskId, host, { expectedRevision, expectedState, workId } = {}) {
    requireThat(host?.mode === 'live' && host.name === 'claude' && typeof host.inspect === 'function' && typeof host.execute === 'function', 'invalid-runner', 'Claude 개발 호스트가 필요합니다.');
    string(expectedState, 'expectedState');
    const before = this.engine.checked(id, expectedRevision);
    requireThat(before.mode === 'live', 'wrong-mode', 'live 목표만 실제 호스트로 배정할 수 있습니다.');
    const plan = before.plans.at(-1), task = plan?.proposal.tasks.find(t => t.id === taskId);
    requireThat(task && taskState(before, taskId).state === 'queued', 'invalid-state', '계획의 대기 작업만 배정할 수 있습니다.');
    const project = this.store.need('project', task.projectId);
    requireThat(project.capabilities.includes('code-agent:claude') && task.requiredCapabilities.includes('code-agent:claude') && !task.requiredCapabilities.includes('simulation'), 'capability-mismatch', '프로젝트와 작업에 code-agent:claude 실행 기능이 필요합니다.');
    host.checkInstallation?.(project);
    const state = await host.inspect(project, expectedState);
    requireThat(state.stateVersion === expectedState, 'stale-remote-state', '조회한 상태와 다릅니다.');
    const codeAgentWorkId = workId ?? `MA-${randomUUID()}`;
    requireThat(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(codeAgentWorkId), 'invalid-input', 'code-agent 작업 ID 형식이 잘못됐습니다.');
    ready(state, codeAgentWorkId, true);
    const recipe = before.verificationRecipes?.[taskId];
    requireThat(!recipe || recipe.planVersion === plan.version, 'stale-recipe', '현재 계획의 검증 계약이 아닙니다.');
    const baseline = recipe ? snapshotTree(project.path) : undefined;
    const ticket = this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision);
      requireThat(['planned', 'executing', 'blocked', 'waiting-decision'].includes(m.state) && !m.planningHold && !taskHeld(this.store, m, taskId), 'invalid-state', '현재 목표는 배정할 수 없습니다.');
      requireThat(this.engine.projectVersionsMatch(m, taskId), 'stale-context', '계획 근거가 변경됐습니다. 재계획이 필요합니다.');
      requireThat(task.dependsOn.every(dep => taskState(m, dep).state === 'succeeded'), 'dependency-pending', '선행 작업의 검증된 완료가 필요합니다.');
      const d = this.engine.decision(m, 'dispatch-live', {
        reason: task.rationale, evidence: [...task.references, `code-agent-state:${state.stateVersion}`], alternatives: ['상태 재검토', '설치된 호스트에 배정'],
        nextAction: task.goal, verification: task.verification, codeAgentWorkId, provider: host.name,
        inputHash: hash({ task, goal: m.goal, state, codeAgentWorkId }),
      });
      const attempt = { id: randomUUID(), token: randomUUID(), missionId: id, taskId, projectId: project.id, planVersion: plan.version,
        mode: 'live', state: 'running', invocationId: randomUUID(), codeAgentWorkId, initialState: state, provider: host.name, model: host.model ?? 'cli-default', decisionId: d.id, startedAt: now(), turns: [],
        ...(recipe ? { recipe: structuredClone(recipe), baseline } : {}) };
      this.store.acquire(project.id, id, attempt.id);
      m.attempts.push(attempt); const t = taskState(m, taskId); t.state = 'running'; t.attemptIds.push(attempt.id);
      m.state = 'executing'; m.reason = `개발 호스트에 ${taskId} 배정`;
      this.engine.save(m, 'live-dispatched', { attemptId: attempt.id, decisionId: d.id });
      return { ...attempt, expectedState, task, project, goal: m.goal, criteria: m.criteria,
        inputEvidence: task.dependsOn.flatMap(dep => taskState(m, dep).evidenceIds.map(e => this.store.need('evidence', e))) };
    });
    return this.invoke(ticket, host);
  }
  /** master 재시작 뒤 실행 중으로 남은 시도에 다시 붙는다 — 같은 호출의 실행을 찾아 결과를 받고, 실행을 새로 만들지 않는다 */
  async reattach(id, attemptId, host) {
    requireThat(host?.transport === 'code-agent-master' && typeof host.reattach === 'function', 'invalid-runner', 'master 통신 계약 호스트만 실행에 다시 붙을 수 있습니다.');
    const m = this.store.need('mission', id), attempt = m.attempts.find(a => a.id === attemptId);
    requireThat(m.mode === 'live' && attempt?.mode === 'live' && attempt.state === 'running' && this.store.lock(attempt.projectId)?.attempt_id === attemptId, 'invalid-state', '실행 중으로 기록된 현재 시도만 다시 붙습니다.');
    const task = m.plans.at(-1).proposal.tasks.find(t => t.id === attempt.taskId);
    const ticket = { ...attempt, expectedState: attempt.turns.at(-1)?.state?.stateVersion ?? attempt.initialState?.stateVersion, sessionId: attempt.turns.at(-1)?.result?.sessionId,
      task, project: this.store.need('project', attempt.projectId), goal: m.goal, criteria: m.criteria, inputEvidence: [] };
    this.store.transaction(() => this.store.event(id, 'live-reattach', { attemptId, invocationId: attempt.invocationId }));
    return this.invoke(ticket, host, { reattach: true });
  }
  async invoke(ticket, host, { reattach = false } = {}) {
    let result, state, error;
    try {
      if (reattach) result = await host.reattach(structuredClone(ticket));
      else result = await this.start(ticket, host);
      requireThat(result && ['returned', 'blocked'].includes(result.status) && typeof result.sessionId === 'string' && typeof result.summary === 'string', 'invalid-host-result', '유효한 호스트 실행 결과가 없습니다.');
      const returned = { id: ticket.invocationId, missionId: ticket.missionId, attemptId: ticket.id, planVersion: ticket.planVersion,
        codeAgentWorkId: ticket.codeAgentWorkId, result, at: now() };
      returned.seal = sealOf(returned);
      this.store.transaction(() => {
        this.store.put('host-return', returned);
        this.store.event(ticket.missionId, 'host-returned', { invocationId: returned.id, attemptId: ticket.id });
      });
      state = await host.inspect(ticket.project, undefined, result.sessionId);
    } catch (e) { error = { code: e.code ?? 'host-error', message: '호스트 실행 또는 결과 관측을 확인하지 못했습니다. 자동 재실행하지 않습니다.' }; }
    return this.record(ticket, result, state, error);
  }
  start(ticket, host) {
    {
      const beforeStart = () => {
        if (ticket.recovery) requireThat(snapshotTree(ticket.project.path).digest === ticket.recovery.tree.digest, 'stale-recovery', '복구 시작 전 파일이 변경됐습니다.');
        const m = this.store.need('mission', ticket.missionId), a = m.attempts.find(a => a.id === ticket.id);
        requireThat(a?.state === 'running' && a.token === ticket.token && a.invocationId === ticket.invocationId && m.state !== 'paused' && !m.planningHold &&
          this.store.lock(ticket.projectId)?.attempt_id === ticket.id, 'dispatch-interrupted', '호스트 시작 전에 배정 상태가 변경됐습니다.');
        requireThat(!taskHeld(this.store, m, ticket.taskId), 'recovery-held', '현재 작업에 영향을 주는 보류가 있습니다.');
        if (ticket.sessionId) this.continuationInputs(m, ticket.projectId, ticket.taskId);
        else {
          requireThat(this.engine.projectVersionsMatch(m, ticket.taskId), 'stale-context', '호스트 시작 전에 계획 근거가 변경됐습니다.');
          if (ticket.baseline) requireThat(snapshotTree(ticket.project.path).digest === ticket.baseline.digest, 'stale-context', '배정 기준 파일이 바뀌었습니다.');
        }
      };
      beforeStart();
      return host.execute(structuredClone(ticket), { beforeStart });
    }
  }
  record(ticket, result, state, error) {
    return this.store.transaction(() => {
      const m = this.store.need('mission', ticket.missionId), attempt = m.attempts.find(a => a.id === ticket.id);
      requireThat(attempt?.token === ticket.token && attempt.invocationId === ticket.invocationId && attempt.state === 'running' && m.plans.at(-1).version === ticket.planVersion &&
        taskState(m, ticket.taskId).attemptIds.at(-1) === ticket.id, 'stale-result', '현재 실행 시도와 결과가 다릅니다.');
      const wrongWork = state?.work && state.work.id !== ticket.codeAgentWorkId;
      let disposition = error || wrongWork ? 'unknown' :
        state.resume?.code === 'needs-human' || state.consents?.open?.length || state.questions?.unanswered?.length || state.questions?.unverified?.length ? 'waiting-decision' :
          state.resume?.code === 'unobservable' || state.resume?.code === 'ownership-conflict' ? 'unknown' :
            result.status === 'blocked' || denialsBlock(result) || state.resume?.code !== 'ready' ? 'blocked' : 'awaiting-verification';
      if (state && !ownsLease(state, result?.sessionId)) disposition = 'unknown';
      const turn = { id: randomUUID(), at: now(), expectedState: ticket.expectedState, state: state ?? null, result: result ?? null, error: error ?? null, disposition };
      attempt.turns.push(turn); attempt.state = disposition; attempt.hostReturnedAt = now();
      taskState(m, ticket.taskId).state = disposition;
      const d = this.engine.decision(m, 'observe-live-result', {
        reason: wrongWork ? '다른 code-agent 작업이 관측되어 결과를 격리합니다.' : error?.message ?? '호스트 회차와 code-agent 상태를 기록했습니다. 작업 완료 판정은 별도 검증이 필요합니다.',
        evidence: [attempt.decisionId, `turn-sha256:${hash(turn)}`], alternatives: ['후속 검증', '기존 호스트에서 질문·동의 처리', '실행 소유권 확인'],
        nextAction: disposition, verification: ticket.task.verification,
      });
      if (m.state !== 'paused') m.state = disposition === 'waiting-decision' ? 'waiting-decision' : 'blocked';
      m.reason = d.reason;
      this.engine.save(m, 'live-observed', { attemptId: attempt.id, turnId: turn.id, disposition, decisionId: d.id });
      return this.engine.describe(m.id);
    });
  }
  async continue(id, attemptId, host, { expectedRevision, expectedState, recoveryRunId, automatic = false } = {}) {
    requireThat(host?.mode === 'live' && host.name === 'claude' && typeof host.inspect === 'function' && typeof host.execute === 'function', 'invalid-runner', 'Claude 개발 호스트가 필요합니다.');
    string(expectedState, 'expectedState');
    const before = this.engine.checked(id, expectedRevision), attempt = before.attempts.find(a => a.id === attemptId);
    requireThat(before.mode === 'live' && !before.planningHold && !taskHeld(this.store, before, attempt?.taskId) && before.state !== 'paused' && attempt?.mode === 'live' && !attempt.recoveryBusy && !attempt.reconciliationPending &&
      (['waiting-decision', 'awaiting-verification', 'blocked', 'verification-failed'].includes(attempt.state) || attempt.state === 'verified' && host.transport === 'code-agent-master'),
    'invalid-state', '종료가 관측된 호스트 회차만 이어갈 수 있습니다. unknown은 자동 재실행하지 않습니다.');
    const project = this.store.need('project', attempt.projectId);
    const sessionId = attempt.turns.at(-1).result.sessionId;
    const state = await host.inspect(project, expectedState, sessionId);
    requireThat(state.stateVersion === expectedState, 'stale-remote-state', '상태 버전이 다릅니다.');
    // 통신 계약: 검증된 시도는 code-agent 작업이 반영 자리를 떠났거나 반영 확인이 위임 수정 요청을 받았을 때만 이어 간다(반영 자리에서 다시 검증한다)
    requireThat(attempt.state !== 'verified' || state.work?.id === attempt.codeAgentWorkId && (state.work.phase !== 'deliver' || revisingTurn(this.store, attempt, state)),
      'invalid-state', '검증된 시도는 같은 작업이 반영 자리를 떠났거나 반영 확인이 위임 수정 요청을 받았을 때만 이어 갑니다.');
    // 직전 회차가 기다린 동의·질문을 위임 판단(사람이 준 권한 범위)으로 모두 처리했으면 그 회차에 한해 이어 간다 — 승인 자체는 code-agent 가 확인했다
    const delegated = Boolean(attempt.delegatedTurnId && attempt.delegatedTurnId === attempt.turns.at(-1)?.id);
    ready(state, attempt.codeAgentWorkId, false, sessionId, delegated, delegated && host.transport === 'code-agent-master' && revisingTurn(this.store, attempt, state));
    if (automatic) {
      requireThat((delegated || state.request?.status === 'confirmed' && state.approval?.status === 'approved') && !state.findings?.blocking && !denialsBlock(attempt.turns.at(-1)?.result),
        'remote-unapproved', '자동 계속 실행에는 기존 요구 확정·승인(또는 그 회차의 위임 판단 처리)·권한 확인이 필요합니다.');
      requireThat((attempt.autoContinuationStates ?? []).length < 8 && !(attempt.autoContinuationStates ?? []).includes(expectedState), 'continuation-limit', '동일 상태 반복 또는 자동 계속 실행 한도입니다.');
    }
    const recovery = recoveryRunId ? this.store.need('recovery-run', recoveryRunId) : undefined;
    if (recovery) requireThat(recovery.missionId === id && recovery.attemptId === attemptId && recovery.sourceVerificationRunId === attempt.verificationRunId &&
      recovery.state === 'executing' && recovery.verdict.allowed && recovery.proposal.action === 'repair' && snapshotTree(project.path).digest === recovery.tree.digest,
    'stale-recovery', '현재 실패·파일에 결합된 복구 판단만 실행할 수 있습니다.');
    const ticket = this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision), current = m.attempts.find(a => a.id === attemptId);
      requireThat(m.plans.at(-1).version === current.planVersion && this.store.lock(project.id)?.attempt_id === attemptId, 'stale-state', '계획 또는 실행 소유권이 다릅니다.');
      // 자기 프로젝트의 code 근거만 변경을 허용한다. 정책·계약·다른 프로젝트의 변경은 다시 판단해야 한다.
      this.continuationInputs(m, project.id, current.taskId);
      if (automatic) current.autoContinuationStates = [...(current.autoContinuationStates ?? []), expectedState];
      const task = m.plans.at(-1).proposal.tasks.find(t => t.id === current.taskId);
      const d = this.engine.decision(m, 'continue-live', { reason: '기존 작업 ID와 현재 code-agent 실행 가능 상태를 확인했습니다.', automatic,
        evidence: [current.decisionId, `code-agent-state:${state.stateVersion}`], alternatives: ['현재 상태 유지', '기존 작업 계속'], nextAction: task.goal, verification: task.verification });
      current.invocationId = randomUUID(); current.state = 'running'; taskState(m, current.taskId).state = 'running'; m.state = 'executing'; m.reason = '개발 호스트 계속 실행';
      this.engine.save(m, 'live-continued', { attemptId, decisionId: d.id });
      return { ...current, decisionId: d.id, expectedState, sessionId, task, project, goal: m.goal, criteria: m.criteria,
        ...(recovery ? { recovery: { runId: recovery.id, proposal: recovery.proposal, tree: recovery.tree } } : {}),
        ...(delegated && current.delegationNote ? { note: `${current.delegationNote}${changeRequests(this.store, current).map(d => `\n확인 요청 ${d.target}(${d.action}) 수정 요청 전문: ${d.reason}`).join('')}\n위임 판단 결과를 확인하고 ca-next 절차대로 이어 간다.` } : {}),
        inputEvidence: task.dependsOn.flatMap(dep => taskState(m, dep).evidenceIds.map(e => this.store.need('evidence', e))) };
    });
    return this.invoke(ticket, host);
  }
}

