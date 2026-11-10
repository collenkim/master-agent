import { logHostError } from '../runner/diagnostics.mjs';
import { randomUUID } from 'node:crypto';
import { Engine, taskState } from './engine.mjs';
import { Knowledge } from '../knowledge/sources.mjs';
import { DomainError, hash, now, requireThat, string } from '../domain/contracts.mjs';
import { snapshotTree } from '../verification/tree.mjs';
import { sealOf } from '../verification/seal.mjs';
import { predecessorContracts } from '../verification/handoff-contracts.mjs';
import { taskHeld, relevantSource } from './scope.mjs';
import { remoteStateSummary } from './remote-state.mjs';
import { dispatchBase } from '../verification/project-history.mjs';
import { KNOWLEDGE_GUIDANCE, deliveryBlock, dispatchEvidence, leaseHold, taskEvidence } from '../knowledge/evidence.mjs';
import { modeOf } from '../knowledge/retrieval.mjs';
import { gateVerification, receiverCapability } from '../knowledge/handoff.mjs';
import { renewForTask } from '../knowledge/lease.mjs';

/** 지식 인계 배정 사전 확인 — 근거가 걸린 작업만 hello 공지를 보고 임대를 연장한다(트랜잭션 밖, 시도를 만들기 전). 보류는 코드로 던진다 */
async function knowledgePreflight(store, plan, task, project, host, options = {}) {
  const mode = modeOf(store, project.id);
  // hello 공지(통신 계약 호스트만). 공지 조회 실패는 미지원과 구별한다(receiver-unreachable)
  const hello = typeof host.knowledgeHello === 'function' ? await host.knowledgeHello(project) : null;
  const capability = receiverCapability(hello);
  const lease = await renewForTask(store, plan.knowledge?.bundleId, mode, options);
  try { return dispatchEvidence(store, plan, task, project, { mode, capability, lease }); }
  catch (error) {
    if (error.handoff) store.transaction(() => store.event(plan.missionId ?? task.missionId ?? project.id, 'knowledge-handoff-held', { taskId: task.id, projectId: project.id, code: error.code,
      required: error.handoff.required, optional: error.handoff.optional, receiver: error.handoff.receiver }));
    throw error;
  }
}
/**
 * 접수 결과를 시도의 인계 기록에 옮긴다(첫 회차만). 접수(accepted)는 수신자가 참조를 받아 저장했다는 뜻일 뿐 근거 검증 통과가 아니다.
 * 필수 참조가 있는데 접수·저장을 확인하지 못했거나 code-agent 진행 게이트가 막았으면 그 시도를 막힘으로 둔다(완료 판정·자동 계속 금지)
 */
function deliveryOf(handoff, result, error) {
  const k = result?.control?.knowledge;
  const state = k?.state ?? (error?.code === 'knowledge-handoff-rejected' ? 'rejected' : error ? 'unconfirmed' : 'unreported');
  return { state, runId: result?.control?.runId ?? null, acceptedRefs: k?.acceptedRefs ?? null, stored: k?.stored ?? 'unchecked',
    verification: k?.verification ?? { state: 'not-reported' }, ...(k?.rejected ? { rejected: k.rejected } : {}), at: now() };
}
/** 진행 게이트를 공지한 수신자의 최신 판정(상태 조회의 knowledge)으로 시도의 검증 관찰을 갱신한다 — 같은 작업·같은 인계일 때만 */
function refreshedHandoff(handoff, state, workId) {
  if (handoff?.status !== 'prepared' || !handoff.delivery || !handoff.receiver?.gate || !state?.knowledge || state.work?.id !== workId) return handoff;
  const verification = gateVerification(state.knowledge, handoff, workId);
  return verification.state === 'not-reported' ? handoff : { ...handoff, delivery: { ...handoff.delivery, verification } };
}


// 결과가 호스트를 생략하면 저장된 실행 호스트를 사용한다. 둘 다 없는 과거 기록만 기존 Claude 계약을 따른다.
function leaseOwner(result, attempt) {
  return { host: result?.control?.hostKind ?? attempt?.executionHost ?? 'claude', session: result?.sessionId };
}
// other-work 는 현재 작업 밖의 임대다 — code-agent 도 다음 진행 명령에서 넘겨받는다(lease.ts leaseDecision).
// 현재 작업 ID의 일치는 record/ready에서 별도로 검사한다.
function ownsLease(state, owner) {
  const lease = state.ownership?.lease;
  return ['none', 'released', 'other-work'].includes(lease?.state) || Boolean(owner?.session && ['claude', 'codex'].includes(owner.host) &&
    lease?.host === owner.host && lease.session === owner.session && ['held', 'idle'].includes(lease.state));
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
function ready(state, workId, fresh, owner, delegated = false, revising = false) {
  requireThat(state && typeof state.stateVersion === 'string', 'invalid-remote-state', '상태 버전이 필요합니다.');
  requireThat(ownsLease(state, owner), 'remote-busy', '다른 호스트의 임대가 남아 있습니다. 종료·해제를 확인하세요.');
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
  constructor(store, { env = process.env } = {}) { this.store = store; this.engine = new Engine(store); this.env = env; }
  continuationInputs(mission, projectId, taskId) {
    const plan = mission.plans.at(-1);
    requireThat(plan.projectVersions.every(p => this.store.need('project', p.id).revision === p.revision), 'stale-context', '프로젝트 카탈로그가 변경됐습니다.');
    for (const id of plan.sourceSnapshotIds ?? []) {
      const snapshot = this.store.need('knowledge-snapshot', id);
      new Knowledge(this.store).assertFresh({ ...snapshot, sources: snapshot.sources.filter(s => s.kind !== 'code' || snapshot.projectId !== projectId && !mission.liveCheckpoints?.[snapshot.projectId] && relevantSource(this.store, mission, taskId, snapshot)) });
    }
  }
  async dispatch(id, taskId, host, { expectedRevision, expectedState, workId, wait = true } = {}) {
    requireThat(host?.mode === 'live' && host.name === 'code-agent' && host.transport === 'code-agent-master' && typeof host.inspect === 'function' && typeof host.execute === 'function', 'invalid-runner', 'code-agent 관리 실행 호스트가 필요합니다.');
    string(expectedState, 'expectedState');
    const before = this.engine.checked(id, expectedRevision);
    requireThat(before.mode === 'live', 'wrong-mode', 'live 목표만 실제 호스트로 배정할 수 있습니다.');
    const plan = before.plans.at(-1), task = plan?.proposal.tasks.find(t => t.id === taskId);
    requireThat(task && taskState(before, taskId).state === 'queued', 'invalid-state', '계획의 대기 작업만 배정할 수 있습니다.');
    const project = this.store.need('project', task.projectId);
    const executionCapabilities = ['code-agent:managed', 'code-agent:claude', 'code-agent:codex'];
    requireThat(executionCapabilities.some(c => project.capabilities.includes(c) && task.requiredCapabilities.includes(c)) && !task.requiredCapabilities.includes('simulation'),
      'capability-mismatch', '프로젝트와 작업에 해당 실행 경로의 code-agent 기능이 필요합니다.');
    host.checkInstallation?.(project);
    const state = await host.inspect(project, expectedState);
    requireThat(state.stateVersion === expectedState, 'stale-remote-state', '조회한 상태와 다릅니다.');
    const codeAgentWorkId = workId ?? `MA-${randomUUID()}`;
    requireThat(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(codeAgentWorkId), 'invalid-input', 'code-agent 작업 ID 형식이 잘못됐습니다.');
    ready(state, codeAgentWorkId, true);
    const recipe = before.verificationRecipes?.[taskId];
    requireThat(!recipe || recipe.planVersion === plan.version, 'stale-recipe', '현재 계획의 검증 계약이 아닙니다.');
    const baseline = recipe ? snapshotTree(project.path) : undefined;
    // 계획이 agent-knowledge 항목을 근거로 쓴 작업만: 모드와 무관하게 봉인 묶음·연결 범위·원본 변경을 확인하고, 수신자 공지·임대로 인계를 정한다.
    // 필수 근거를 보낼 수 없으면 시도를 만들지 않고 그 작업만 막는다. 근거가 없는 작업은 hello·생산자를 부르지 않는다(기존 경로 그대로)
    const knowledge = task.knowledgeRefs?.length ? await knowledgePreflight(this.store, { ...plan, missionId: id }, task, project, host, { env: this.env }) : null;
    const ticket = this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision);
      if (knowledge) taskEvidence(this.store, m.plans.at(-1), task);
      requireThat(['planned', 'executing', 'blocked', 'waiting-decision'].includes(m.state) && !m.planningHold && !taskHeld(this.store, m, taskId), 'invalid-state', '현재 목표는 배정할 수 없습니다.');
      requireThat(this.engine.projectVersionsMatch(m, taskId), 'stale-context', '계획 근거가 변경됐습니다. 재계획이 필요합니다.');
      requireThat(task.dependsOn.every(dep => taskState(m, dep).state === 'succeeded'), 'dependency-pending', '선행 작업의 검증된 완료가 필요합니다.');
      const codeAgentBase = dispatchBase(this.store, m, project, codeAgentWorkId, state);
      const d = this.engine.decision(m, 'dispatch-live', {
        reason: task.rationale, evidence: [...task.references, `code-agent-state:${state.stateVersion}`], alternatives: ['상태 재검토', '설치된 호스트에 배정'],
        nextAction: task.goal, verification: task.verification, codeAgentWorkId, provider: host.name,
        inputHash: hash({ task, goal: m.goal, state, codeAgentWorkId }),
        ...(knowledge ? { knowledge: { status: knowledge.status, ...(knowledge.reason ? { reason: knowledge.reason } : {}), count: knowledge.count, required: knowledge.required, bundleId: knowledge.bundleId,
          ...(knowledge.status === 'prepared' ? { version: knowledge.version, hash: knowledge.hash, sent: knowledge.sent, sentRequired: knowledge.sentRequired } : {}) } } : {}),
      });
      const attempt = { id: randomUUID(), token: randomUUID(), missionId: id, taskId, projectId: project.id, planVersion: plan.version,
        ...(m.taskNumber === undefined ? {} : { taskNumber: m.taskNumber }),
        mode: 'live', state: 'running', invocationId: randomUUID(), codeAgentWorkId, initialState: remoteStateSummary(state), provider: host.name, model: host.model ?? 'cli-default', decisionId: d.id, startedAt: now(), turns: [],
        ...(recipe ? { recipe: structuredClone(recipe), baseline } : {}), ...(knowledge ? { knowledgeHandoff: knowledge } : {}) };
      this.store.acquire(project.id, id, attempt.id);
      m.attempts.push(attempt); const t = taskState(m, taskId); t.state = 'running'; t.attemptIds.push(attempt.id);
      m.state = 'executing'; m.reason = `개발 호스트에 ${taskId} 배정`;
      const prepared = { ...attempt, ...(codeAgentBase ? { codeAgentBase } : {}), expectedState, task, project, goal: m.goal, criteria: m.criteria, inputContracts: predecessorContracts(this.store, m, task),
        inputEvidence: task.dependsOn.flatMap(dep => taskState(m, dep).evidenceIds.map(e => this.store.need('evidence', e))) };
      host.validateTicket?.(prepared);
      this.engine.save(m, 'live-dispatched', { attemptId: attempt.id, decisionId: d.id });
      return prepared;
    });
    return this.invoke(ticket, host, { wait });
  }
  /** master 재시작 뒤 실행 중으로 남은 시도에 다시 붙는다 — 같은 호출의 실행을 찾아 결과를 받고, 실행을 새로 만들지 않는다 */
  async reattach(id, attemptId, host, { wait = true } = {}) {
    requireThat(host?.transport === 'code-agent-master' && typeof host.reattach === 'function', 'invalid-runner', 'master 통신 계약 호스트만 실행에 다시 붙을 수 있습니다.');
    const m = this.store.need('mission', id), attempt = m.attempts.find(a => a.id === attemptId);
    requireThat(m.mode === 'live' && attempt?.mode === 'live' && attempt.state === 'running' && this.store.lock(attempt.projectId)?.attempt_id === attemptId, 'invalid-state', '실행 중으로 기록된 현재 시도만 다시 붙습니다.');
    const task = m.plans.at(-1).proposal.tasks.find(t => t.id === attempt.taskId);
    // 실행 중인 시도의 근거 세대를 계속 붙잡는다(최선 노력 — 실행은 이미 code-agent에 있다)
    if (attempt.knowledgeHandoff?.status === 'prepared') await renewForTask(this.store, m.plans.at(-1).knowledge?.bundleId, modeOf(this.store, attempt.projectId), { env: this.env }).catch(() => null);
    const ticket = { ...attempt, expectedState: attempt.turns.at(-1)?.state?.stateVersion ?? attempt.initialState?.stateVersion, sessionId: attempt.turns.at(-1)?.result?.sessionId,
      task, project: this.store.need('project', attempt.projectId), goal: m.goal, criteria: m.criteria, inputEvidence: [] };
    if (wait || !this.store.events(id).some(e => e.type === 'live-reattach' && e.invocationId === attempt.invocationId)) {
      this.store.transaction(() => this.store.event(id, 'live-reattach', { attemptId, invocationId: attempt.invocationId }));
    }
    return this.invoke(ticket, host, { reattach: true, wait });
  }
  async invoke(ticket, host, { reattach = false, wait = true } = {}) {
    let result, state, error;
    try {
      if (reattach) result = await host.reattach(structuredClone(ticket), { wait });
      else result = await this.start(ticket, host, { wait });
      if (!wait && host.transport === 'code-agent-master' && result?.status === 'pending') return this.engine.describe(ticket.missionId);
      requireThat(result && ['returned', 'blocked'].includes(result.status) && typeof result.sessionId === 'string' && typeof result.summary === 'string', 'invalid-host-result', '유효한 호스트 실행 결과가 없습니다.');
      const returned = { id: ticket.invocationId, missionId: ticket.missionId, attemptId: ticket.id, planVersion: ticket.planVersion,
        codeAgentWorkId: ticket.codeAgentWorkId, result, at: now() };
      returned.seal = sealOf(returned);
      this.store.transaction(() => {
        this.store.put('host-return', returned);
        this.store.event(ticket.missionId, 'host-returned', { invocationId: returned.id, attemptId: ticket.id });
      });
      state = await host.inspect(ticket.project, undefined, result.sessionId);
    } catch (e) {
      logHostError(this.store, ticket.missionId, e);
      error = { code: e.code ?? 'host-error', message: '호스트 실행 또는 결과 관측을 확인하지 못했습니다. 자동 재실행하지 않습니다.' };
    }
    return this.record(ticket, result, state, error);
  }
  start(ticket, host, { wait = true } = {}) {
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
      return host.execute(structuredClone(ticket), { beforeStart, wait });
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
      if (state && !ownsLease(state, leaseOwner(result, attempt))) disposition = 'unknown';
      // 첫 회차(start)만 인계를 실었다 — 이어 실행은 code-agent가 처음 실행의 인계를 그대로 쓴다
      // 첫 회차가 접수 뒤 응답·추적을 잃어 미확인으로 남았으면(재부착이 같은 실행의 접수 기록을 돌려준다) 그 기록으로 고친다
      const prior = attempt.knowledgeHandoff?.delivery;
      if (attempt.knowledgeHandoff?.status === 'prepared' && !ticket.sessionId && (!prior || ['unconfirmed', 'unreported'].includes(prior.state) && result?.control?.knowledge)) {
        const delivery = deliveryOf(attempt.knowledgeHandoff, result, error);
        attempt.knowledgeHandoff = { ...attempt.knowledgeHandoff, delivery };
        this.store.event(m.id, 'knowledge-handoff-recorded', { attemptId: attempt.id, state: delivery.state, stored: delivery.stored, verification: delivery.verification.state, hash: attempt.knowledgeHandoff.hash });
      }
      // 회차마다 code-agent 진행 게이트의 최신 판정을 반영한다. 필수 근거가 막히면(접수·저장 미확인, 재검증 필요, 재계획 판정) 그 시도만 막힘으로 둔다
      if (attempt.knowledgeHandoff?.delivery) {
        attempt.knowledgeHandoff = refreshedHandoff(attempt.knowledgeHandoff, state, attempt.codeAgentWorkId);
        // 필수 근거 인계를 확인하지 못한 시도는 동의·질문 대기여도 막는다 — 위임 판단이 그 근거 위의 동의를 처리하지 않게 한다(결과 미확인 unknown 은 그대로)
        if (deliveryBlock(attempt.knowledgeHandoff) && disposition !== 'unknown') disposition = 'blocked';
      }
      const turn = { id: randomUUID(), at: now(), expectedState: ticket.expectedState, state: remoteStateSummary(state, result?.control?.runId), result: result ?? null, error: error ?? null, disposition };
      attempt.turns.push(turn); attempt.state = disposition; attempt.hostReturnedAt = now();
      if (['claude', 'codex'].includes(result?.control?.hostKind)) attempt.executionHost = result.control.hostKind;
      taskState(m, ticket.taskId).state = disposition;
      const d = this.engine.decision(m, 'observe-live-result', {
        reason: wrongWork ? '다른 code-agent 작업이 관측되어 결과를 격리합니다.' : error?.message ?? '호스트 회차와 code-agent 상태를 기록했습니다. 작업 완료 판정은 별도 검증이 필요합니다.',
        evidence: [attempt.decisionId, `turn-sha256:${hash(turn)}`], alternatives: ['후속 검증', '기존 호스트에서 질문·동의 처리', '실행 소유권 확인'],
        nextAction: disposition, verification: ticket.task.verification,
      });
      if (m.state !== 'paused') m.state = m.tasks.some(t => t.state === 'running') ? 'executing' : disposition === 'waiting-decision' ? 'waiting-decision' : 'blocked';
      m.reason = d.reason;
      this.engine.save(m, 'live-observed', { attemptId: attempt.id, turnId: turn.id, disposition, decisionId: d.id });
      return this.engine.describe(m.id);
    });
  }
  /**
   * 이어 실행 전 지식 인계 확인 — 새 근거를 싣지 않는다(code-agent가 처음 실행의 인계를 그대로 쓴다). 필수 근거를 실은 시도만:
   * 접수·저장을 확인하지 못했거나 재확인 실패가 기록됐으면 같은 근거로 이어 가지 않는다. enabled면 세대 임대를 연장하고, 세대가 사라졌으면 막는다(재계획 필요)
   */
  async knowledgeContinuation(mission, attempt, project, state = null) {
    // 사람이 code-agent 에서 다시 검증했을 수 있다 — 지금 상태 조회의 게이트 판정이 있으면 그것으로 판단한다
    const handoff = refreshedHandoff(attempt?.knowledgeHandoff, state, attempt?.codeAgentWorkId);
    if (handoff?.status !== 'prepared' || !handoff.sentRequired) return;
    const failed = deliveryBlock(handoff);
    if (failed) throw new DomainError(failed, KNOWLEDGE_GUIDANCE[failed]);
    const mode = modeOf(this.store, project.id);
    const block = leaseHold(await renewForTask(this.store, mission.plans.at(-1).knowledge?.bundleId, mode, { env: this.env }));
    if (block && (block !== 'knowledge-lease-failed' || mode === 'enabled')) throw new DomainError(block, KNOWLEDGE_GUIDANCE[block]);
  }
  /**
   * code-agent 진행 게이트가 인계 필수 근거를 아직 검증하지 못해(knowledge-blocked · knowledge-reverify) 멈춘 작업을 같은 참조로 한 번 다시 검증하게 한다.
   * 새 검색·새 참조·required 낮추기는 하지 않는다. 시도마다 한 번만(같은 commandId — 응답을 잃어도 다시 실행되지 않는다). 그래도 막히면 그 작업만 막힘으로 두고
   * 사람·재계획을 기다린다(무한 재시도 금지). 근거가 지금 근거와 맞지 않는 판정(knowledge-replan)은 재검증하지 않는다
   */
  async reverifyKnowledge(id, attemptId, host, { expectedRevision, expectedState } = {}) {
    requireThat(typeof host?.knowledgeVerify === 'function' && typeof host.inspect === 'function', 'invalid-runner', '인계 근거 재검증을 지원하는 관리 실행 호스트가 필요합니다.');
    const before = this.engine.checked(id, expectedRevision), attempt = before.attempts.find(a => a.id === attemptId);
    const handoff = attempt?.knowledgeHandoff;
    requireThat(attempt?.mode === 'live' && ['blocked', 'waiting-decision', 'awaiting-verification'].includes(attempt.state) && handoff?.status === 'prepared' && handoff.sentRequired > 0, 'invalid-state', '필수 인계 근거를 보낸 막힌 시도만 재검증합니다.');
    requireThat(handoff.receiver?.commands?.includes('verify'), 'knowledge-verification-pending', KNOWLEDGE_GUIDANCE['knowledge-verification-pending']);
    requireThat(!handoff.reverify, 'knowledge-verification-pending', KNOWLEDGE_GUIDANCE['knowledge-verification-pending']);
    const project = this.store.need('project', attempt.projectId);
    const state = await host.inspect(project, expectedState, attempt.turns.at(-1)?.result?.sessionId);
    if (expectedState) requireThat(state.stateVersion === expectedState, 'stale-remote-state', '상태 버전이 다릅니다.');
    requireThat(state.resume?.code === 'knowledge-blocked' && state.work?.id === attempt.codeAgentWorkId && state.knowledge?.action === 'knowledge-reverify' && state.knowledge.digest === handoff.digest,
      'remote-not-ready', '같은 인계의 재검증으로 풀리는 근거 게이트가 아닙니다.');
    const commandId = `kv-${attempt.id}`;
    let result, error;
    try { result = await host.knowledgeVerify(project, attempt.codeAgentWorkId, commandId); } catch (e) { error = e; }
    return this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision), current = m.attempts.find(a => a.id === attemptId);
      const verification = result ? gateVerification(result.knowledge, current.knowledgeHandoff, current.codeAgentWorkId) : null;
      current.knowledgeHandoff = { ...current.knowledgeHandoff, reverify: { at: now(), commandId, state: verification?.state ?? 'error', resume: result?.resume?.code ?? null,
        ...(error ? { error: { code: error.controlCode ?? error.code ?? 'error', message: String(error.message ?? '').slice(0, 300) } } : {}) },
        ...(verification && current.knowledgeHandoff.delivery ? { delivery: { ...current.knowledgeHandoff.delivery, verification } } : {}) };
      this.store.event(m.id, 'knowledge-reverified', { attemptId, commandId, state: verification?.state ?? 'error', resume: result?.resume?.code ?? null });
      this.engine.save(m, 'knowledge-reverified', { attemptId, state: verification?.state ?? 'error' });
      return this.engine.describe(m.id);
    });
  }
  async continue(id, attemptId, host, { expectedRevision, expectedState, recoveryRunId, automatic = false, wait = true } = {}) {
    requireThat(host?.mode === 'live' && host.name === 'code-agent' && host.transport === 'code-agent-master' && typeof host.inspect === 'function' && typeof host.execute === 'function', 'invalid-runner', 'code-agent 관리 실행 호스트가 필요합니다.');
    string(expectedState, 'expectedState');
    const before = this.engine.checked(id, expectedRevision), attempt = before.attempts.find(a => a.id === attemptId);
    requireThat(before.mode === 'live' && !before.planningHold && !taskHeld(this.store, before, attempt?.taskId) && before.state !== 'paused' && attempt?.mode === 'live' && !attempt.recoveryBusy && !attempt.reconciliationPending &&
      (['waiting-decision', 'awaiting-verification', 'blocked', 'verification-failed'].includes(attempt.state) || attempt.state === 'verified' && host.transport === 'code-agent-master'),
    'invalid-state', '종료가 관측된 호스트 회차만 이어갈 수 있습니다. unknown은 자동 재실행하지 않습니다.');
    const project = this.store.need('project', attempt.projectId);
    const sessionId = attempt.turns.at(-1).result.sessionId;
    requireThat(attempt.turns.at(-1).result.control?.sessionConfirmed !== false, 'unconfirmed-session', 'code-agent가 실행 세션을 확인하지 못했습니다. 새 세션으로 대체하지 않고 상태 확인을 기다립니다.');
    const state = await host.inspect(project, expectedState, sessionId);
    requireThat(state.stateVersion === expectedState, 'stale-remote-state', '상태 버전이 다릅니다.');
    // 통신 계약: 검증된 시도는 code-agent 작업이 반영 자리를 떠났거나 반영 확인이 위임 수정 요청을 받았을 때만 이어 간다(반영 자리에서 다시 검증한다)
    requireThat(attempt.state !== 'verified' || state.work?.id === attempt.codeAgentWorkId && (state.work.phase !== 'deliver' || revisingTurn(this.store, attempt, state)),
      'invalid-state', '검증된 시도는 같은 작업이 반영 자리를 떠났거나 반영 확인이 위임 수정 요청을 받았을 때만 이어 갑니다.');
    // 직전 회차가 기다린 동의·질문을 위임 판단(사람이 준 권한 범위)으로 모두 처리했으면 그 회차에 한해 이어 간다 — 승인 자체는 code-agent 가 확인했다
    const delegated = Boolean(attempt.delegatedTurnId && attempt.delegatedTurnId === attempt.turns.at(-1)?.id);
    ready(state, attempt.codeAgentWorkId, false, leaseOwner(attempt.turns.at(-1).result, attempt), delegated, delegated && host.transport === 'code-agent-master' && revisingTurn(this.store, attempt, state));
    if (automatic) {
      requireThat((delegated || state.request?.status === 'confirmed' && state.approval?.status === 'approved') && !state.findings?.blocking && !denialsBlock(attempt.turns.at(-1)?.result),
        'remote-unapproved', '자동 계속 실행에는 기존 요구 확정·승인(또는 그 회차의 위임 판단 처리)·권한 확인이 필요합니다.');
      requireThat((attempt.autoContinuationStates ?? []).length < 8 && !(attempt.autoContinuationStates ?? []).includes(expectedState), 'continuation-limit', '동일 상태 반복 또는 자동 계속 실행 한도입니다.');
    }
    await this.knowledgeContinuation(before, attempt, project, state);
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
      // 이어 실행은 작업 자신의 변경이 원본을 바꿀 수 있으므로 봉인 묶음·연결 범위만 다시 확인한다(모드와 무관). 수집한 정책 문서의 변경은 위 continuationInputs가 막는다
      if (task.knowledgeRefs?.length) taskEvidence(this.store, m.plans.at(-1), task);
      const d = this.engine.decision(m, 'continue-live', { reason: '기존 작업 ID와 현재 code-agent 실행 가능 상태를 확인했습니다.', automatic,
        evidence: [current.decisionId, `code-agent-state:${state.stateVersion}`], alternatives: ['현재 상태 유지', '기존 작업 계속'], nextAction: task.goal, verification: task.verification });
      current.invocationId = randomUUID(); current.state = 'running'; taskState(m, current.taskId).state = 'running'; m.state = 'executing'; m.reason = '개발 호스트 계속 실행';
      const prepared = { ...current, decisionId: d.id, expectedState, sessionId, task, project, goal: m.goal, criteria: m.criteria, inputContracts: predecessorContracts(this.store, m, task),
        ...(recovery ? { recovery: { runId: recovery.id, proposal: recovery.proposal, tree: recovery.tree } } : {}),
        ...(delegated && current.delegationNote ? { note: `${current.delegationNote}${changeRequests(this.store, current).map(d => `\n확인 요청 ${d.target}(${d.action}) 수정 요청 전문: ${d.reason}`).join('')}\n위임 판단 결과를 확인하고 ca-next 절차대로 이어 간다.` } : {}),
        inputEvidence: task.dependsOn.flatMap(dep => taskState(m, dep).evidenceIds.map(e => this.store.need('evidence', e))) };
      host.validateTicket?.(prepared);
      this.engine.save(m, 'live-continued', { attemptId, decisionId: d.id });
      return prepared;
    });
    return this.invoke(ticket, host, { wait });
  }
}

