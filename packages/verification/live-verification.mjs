import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, extname } from 'node:path';
import { Engine } from '../orchestrator/engine.mjs';
import { hash, now, requireThat, string, strings } from '../domain/contracts.mjs';
import { runCheck } from './command.mjs';
import { snapshotTree, safeRelative, changesBetween, checkpointsCurrent, allowedChange } from './tree.mjs';
import { Knowledge } from '../knowledge/sources.mjs';
import { relevantSource } from '../orchestrator/scope.mjs';
import { validateDelivery, verifyDelivery, inspectDelivery } from './delivery.mjs';
import { validateExports, bindExports } from './handoff-contracts.mjs';

const activePlan = m => m.plans.at(-1);
const taskState = (m, id) => m.tasks.find(t => t.id === id);
const sealOf = value => { const { seal, revision, ...body } = value; return hash(body); };
const assertSealed = value => requireThat(value.seal === sealOf(value), 'invalid-evidence', '검증 증거의 내용이 변경됐습니다.');

export function validateRecipe(recipe, task) {
  requireThat(recipe?.schemaVersion === 1 && recipe.taskId === task.id, 'invalid-recipe', '현재 작업의 검증 계약이 필요합니다.');
  strings(recipe.allowedPaths, 'allowedPaths'); recipe.allowedPaths.forEach(safeRelative);
  requireThat(recipe.codeAgentRecords === undefined || typeof recipe.codeAgentRecords === 'boolean', 'invalid-recipe', 'codeAgentRecords 는 true/false 입니다.');
  if (recipe.delivery) validateDelivery(recipe.delivery);
  requireThat(Array.isArray(recipe.checks) && recipe.checks.length && recipe.checks.length <= 32, 'invalid-recipe', '검증 명령 1~32개가 필요합니다.');
  strings(recipe.checks.map(c => c.id), 'check.id', true);
  for (const check of recipe.checks) {
    string(check.executable, 'executable');
    requireThat(isAbsolute(check.executable) && existsSync(check.executable) && !['.cmd', '.bat', '.ps1', '.sh'].includes(extname(check.executable).toLowerCase()), 'invalid-recipe', '검증기는 존재하는 절대 실행 파일 경로를 사용합니다. 셸 래퍼는 지원하지 않습니다.');
    requireThat(Array.isArray(check.args) && check.args.every(a => typeof a === 'string'), 'invalid-recipe', 'args는 문자열 배열이어야 합니다.');
    strings(check.criterionIds, 'criterionIds', true);
    requireThat(check.criterionIds.every(c => task.criteria.includes(c)), 'invalid-recipe', '작업의 완료 조건만 검증할 수 있습니다.');
    requireThat(Number.isInteger(check.timeoutMs) && check.timeoutMs > 0 && check.timeoutMs <= 3600000, 'invalid-recipe', '명령 시간 제한은 1~3600000ms입니다.');
  }
  requireThat(task.criteria.every(c => recipe.checks.some(check => check.criterionIds.includes(c))), 'missing-verification', '모든 작업 조건을 검증 명령에 연결해야 합니다.');
  validateExports(recipe);
  requireThat(Array.isArray(recipe.artifacts), 'invalid-recipe', '산출물의 파일 또는 검증 출력 연결이 필요합니다.');
  strings(recipe.artifacts.map(a => a.name), 'artifact.name');
  requireThat(task.outputs.every(name => recipe.artifacts.some(a => a.name === name)), 'missing-artifact', '계획의 모든 산출물을 연결해야 합니다.');
  for (const artifact of recipe.artifacts) {
    requireThat(task.outputs.includes(artifact.name) && Boolean(artifact.path) !== Boolean(artifact.checkId), 'invalid-recipe', '산출물에는 path 또는 checkId 중 하나를 지정하세요.');
    if (artifact.path) safeRelative(artifact.path);
    else requireThat(recipe.checks.some(c => c.id === artifact.checkId), 'invalid-recipe', '산출물에 연결한 검증 명령이 없습니다.');
  }
}

export class LiveVerification {
  constructor(store) { this.store = store; this.engine = new Engine(store); }
  inputsCurrent(mission, projectId, taskId) {
    const plan = activePlan(mission);
    requireThat(plan.projectVersions.every(p => this.store.need('project', p.id).revision === p.revision), 'stale-context', '검증 중 프로젝트 정의가 변경됐습니다.');
    for (const id of plan.sourceSnapshotIds ?? []) {
      const snapshot = this.store.need('knowledge-snapshot', id);
      new Knowledge(this.store).assertFresh({ ...snapshot, sources: snapshot.sources.filter(s => s.kind !== 'code' || snapshot.projectId !== projectId && !mission.liveCheckpoints?.[snapshot.projectId] && relevantSource(this.store, mission, taskId, snapshot)) });
    }
  }
  configure(id, recipe, expectedRevision, template) {
    return this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision), plan = activePlan(m), task = plan?.proposal.tasks.find(t => t.id === recipe.taskId);
      requireThat(m.mode === 'live' && task && ['planned', 'blocked', 'executing', 'waiting-decision'].includes(m.state) && !m.planningHold && taskState(m, task.id).state === 'queued', 'invalid-state', '배정 전 대기 작업에만 검증 계약을 등록할 수 있습니다.');
      validateRecipe(recipe, task);
      const d = this.engine.decision(m, 'configure-verification', { actor: template ? 'rule-engine' : 'operator', template: template ?? null, reason: '배정 전에 정확한 변경 파일과 조건별 실행 검증을 등록합니다.',
        evidence: task.references, alternatives: ['계약 보완', '현재 계약 적용'], nextAction: 'dispatch-live', verification: task.verification, inputHash: hash(recipe) });
      m.verificationRecipes ??= {};
      m.verificationRecipes[task.id] = { ...structuredClone(recipe), planVersion: plan.version, decisionId: d.id, hash: hash(recipe) };
      return this.engine.save(m, 'verification-configured', { taskId: task.id, decisionId: d.id });
    });
  }
  locate(id, attemptId, revision) {
    const m = this.engine.checked(id, revision), attempt = m.attempts.find(a => a.id === attemptId);
    requireThat(m.mode === 'live' && !m.planningHold && m.state !== 'paused' && attempt?.mode === 'live' && attempt.planVersion === activePlan(m).version &&
      taskState(m, attempt.taskId).attemptIds.at(-1) === attempt.id && this.store.lock(attempt.projectId)?.attempt_id === attempt.id, 'invalid-state', '현재 계획의 잠금을 가진 live 시도만 검증할 수 있습니다.');
    return { m, attempt, task: activePlan(m).proposal.tasks.find(t => t.id === attempt.taskId), project: this.store.need('project', attempt.projectId) };
  }
  remoteReady(state, attempt) {
    const session = attempt.turns.at(-1)?.result?.sessionId;
    requireThat(state.work?.id === attempt.codeAgentWorkId && state.request?.status === 'confirmed' && state.approval?.status === 'approved', 'remote-unapproved', '같은 작업의 요구 확정과 유효한 계획 승인이 필요합니다.');
    // 반영 직전의 대기는 두 꼴이다 — 반영 동의를 아직 준비하지 않음(deliver-consent), 또는 준비한 반영 동의 하나가 응답을 기다림.
    // 반영 동의 준비는 작업 트리를 바꾸지 않으므로 같은 자리로 본다(그 응답은 이 검증이 끝난 뒤에만 판단한다)
    const open = state.consents?.open ?? [];
    const deliverPending = open.length === 1 && open[0].action === 'deliver' && open[0].status === 'pending' && state.work?.phase === 'deliver' &&
      state.resume?.code === 'needs-human' && state.resume.next?.action === 'consent';
    requireThat(state.consents?.readable && (!open.length || deliverPending) && !state.questions?.unanswered?.length && !state.questions?.unverified?.length && !state.findings?.blocking &&
      ['ready', 'needs-human'].includes(state.resume?.code) && (state.resume.code !== 'needs-human' || state.resume.next?.action === 'deliver-consent' || deliverPending), 'remote-not-ready', '진행 중 동의·질문·실패·사람 판단을 먼저 해결해야 합니다.');
    const lease = state.ownership?.lease;
    requireThat(['none', 'released'].includes(lease?.state) || lease?.host === 'claude' && lease.session === session && ['held', 'idle'].includes(lease.state), 'remote-busy', '검증할 세션의 임대가 아닙니다.');
    requireThat(state.verification?.bound?.valid === true && state.verification.phases?.check?.passed === true && state.verification.phases?.test?.passed === true,
      'missing-remote-evidence', '현재 트리와 결합된 code-agent check·test 성공 기록이 필요합니다.');
  }
  async verify(id, attemptId, host, { expectedRevision, expectedState, recoveryRunId } = {}) {
    string(expectedState, 'expectedState');
    const { m, attempt, task, project } = this.locate(id, attemptId, expectedRevision);
    requireThat(['awaiting-verification', 'blocked', 'waiting-decision', 'verification-failed'].includes(attempt.state) && attempt.baseline && attempt.recipe && !attempt.recoveryBusy, 'invalid-state', '검증 계약과 배정 시점 스냅샷이 있는 종료된 시도만 검증할 수 있습니다.');
    validateRecipe(attempt.recipe, task);
    const session = attempt.turns.at(-1)?.result?.sessionId;
    const remote = await host.inspect(project, expectedState, session);
    requireThat(remote.stateVersion === expectedState, 'stale-remote-state', '원격 상태가 변경됐습니다.');
    this.remoteReady(remote, attempt);
    this.inputsCurrent(m, project.id, task.id);
    const before = snapshotTree(project.path), changedPaths = changesBetween(attempt.baseline, before);
    if (recoveryRunId) {
      const recovery = this.store.need('recovery-run', recoveryRunId);
      requireThat(recovery.missionId === id && recovery.attemptId === attemptId && recovery.sourceVerificationRunId === attempt.verificationRunId && recovery.state === 'executing' &&
        recovery.verdict.allowed && recovery.proposal.action === 'reverify' && before.digest === recovery.tree.digest && before.head === recovery.tree.head,
      'stale-recovery', '현재 실패·파일에 결합된 재검증 판단이 필요합니다.');
    }
    requireThat(before.head === attempt.baseline.head, 'unexpected-commit', '검증 전에 HEAD가 변경됐습니다. 기준을 다시 검토해야 합니다.');
    const outside = changedPaths.filter(path => !allowedChange(attempt.recipe, attempt.codeAgentWorkId, path));
    requireThat(!outside.length, 'out-of-scope-change', `허용되지 않은 변경: ${outside.join(', ')}`);
    // 통합 검증 동안 다른 프로젝트의 산출물이 바뀌어도 성공하지 않는다.
    requireThat(checkpointsCurrent(m, project.id), 'stale-evidence', '선행 프로젝트의 검증된 파일이 변경됐습니다.');
    const runId = randomUUID();
    this.store.transaction(() => {
      const current = this.locate(id, attemptId, expectedRevision);
      const d = this.engine.decision(current.m, 'verify-live', { reason: '배정 범위와 승인·code-agent 검증을 대조한 뒤 독립 검증 명령을 실행합니다.',
        evidence: [attempt.decisionId, `tree:${before.digest}`, `state:${expectedState}`], alternatives: ['추가 수정', '검증 실행'], nextAction: 'run-verification', verification: task.verification, inputHash: hash(attempt.recipe) });
      this.store.put('verification-run', { id: runId, missionId: id, attemptId, state: 'running', before, remote, changedPaths, decisionId: d.id, checks: [], startedAt: now() });
      current.attempt.activeVerificationRunId = runId;
      current.attempt.state = 'verifying'; taskState(current.m, task.id).state = 'verifying';
      this.engine.save(current.m, 'verification-started', { runId, attemptId, decisionId: d.id });
    });
    const checks = []; let failure, after, remoteAfter, artifacts, contracts;
    try {
      for (const check of attempt.recipe.checks) {
        requireThat(this.store.need('mission', id).state !== 'paused', 'verification-paused', '일시 정지되어 새 검증 명령을 시작하지 않습니다.');
        const active = this.store.need('mission', id).attempts.find(a => a.id === attemptId);
        requireThat(active?.state === 'verifying' && active.activeVerificationRunId === runId, 'stale-result', '현재 검증 실행 권한이 없습니다.');
        try {
          const output = await runCheck(this.store, { missionId: id, attemptId, verificationRunId: runId }, check, project.path);
          checks.push({ id: check.id, criterionIds: check.criterionIds, passed: output.exitCode === 0, exitCode: output.exitCode,
            output: output.stdout.slice(0, 16000), diagnostic: output.stderr.slice(0, 16000), outputHash: hash(output.stdout), diagnosticHash: hash(output.stderr) });
          requireThat(output.exitCode === 0, 'provider-exit', '검증 명령이 실패했습니다.');
        } catch (error) {
          if (!checks.some(c => c.id === check.id)) checks.push({ id: check.id, criterionIds: check.criterionIds, passed: false, error: error.code ?? 'command-error' }); throw error;
        }
      }
      after = snapshotTree(project.path);
      requireThat(after.digest === before.digest && after.head === before.head, 'verification-mutated-tree', '검증 명령 실행 중 파일 또는 HEAD가 바뀌었습니다.');
      requireThat(checkpointsCurrent(m, project.id), 'stale-evidence', '검증 중 선행 프로젝트의 산출물이 바뀌었습니다.');
      artifacts = attempt.recipe.artifacts.map(a => {
        const item = a.path ? after.files.find(f => f.path === a.path) : checks.find(c => c.id === a.checkId);
        requireThat(item, 'missing-artifact', `실제 산출물이 없습니다: ${a.name}`);
        return { ...a, digest: a.path ? item.digest : item.outputHash };
      });
      remoteAfter = await host.inspect(project, expectedState, session);
      contracts = bindExports(attempt.recipe, after, checks);
      requireThat(remoteAfter.stateVersion === expectedState, 'stale-remote-state', '검증 중 원격 상태가 바뀌었습니다.');
      this.remoteReady(remoteAfter, attempt);
      this.inputsCurrent(this.store.need('mission', id), project.id, task.id);
    } catch (e) { failure = { code: e.code ?? 'verification-error', message: '독립 검증 또는 입력 대조를 통과하지 못했습니다.' }; }
    if (failure?.code === 'provider-exit' || failure?.code === 'verification-paused') {
      try {
        after = snapshotTree(project.path);
        requireThat(after.digest === before.digest && after.head === before.head, 'verification-mutated-tree', '실패한 검증 중 파일이 변경됐습니다.');
      } catch (error) { failure.code = error.code ?? 'verification-error'; }
    }
    return this.store.transaction(() => {
      const current = this.store.need('mission', id), a = current.attempts.find(a => a.id === attemptId), run = this.store.need('verification-run', runId);
      requireThat(a?.state === 'verifying' && a.activeVerificationRunId === runId && a.planVersion === activePlan(current).version, 'stale-result', '검증 결과의 시도가 변경됐습니다.');
      const uncertain = failure && !['provider-exit', 'verification-paused'].includes(failure.code);
      const disposition = failure ? uncertain ? 'unknown' : 'verification-failed' : 'verified';
      run.state = disposition; run.checks = checks; run.artifacts = artifacts ?? []; run.error = failure ?? null; run.after = after ?? null; run.remoteAfter = remoteAfter ?? null; run.finishedAt = now();
      run.contracts = failure ? [] : contracts;
      run.seal = sealOf(run); this.store.put('verification-run', run, run.revision);
      a.state = disposition; a.verificationRunId = runId; taskState(current, task.id).state = disposition;
      if (disposition === 'verified' || disposition === 'verification-failed') delete a.reconciliationPending;
      const d = this.engine.decision(current, 'record-verification', { reason: failure ? failure.message : '변경 범위·실제 검증 명령·원격 승인과 트리 결합을 확인했습니다. 반영 인계를 기다립니다.',
        evidence: [runId, `verification:${run.seal}`], alternatives: ['수정 후 재검증', '기존 반영 절차 완료 대기'], nextAction: disposition, verification: task.verification });
      if (current.state !== 'paused') current.state = 'blocked'; current.reason = d.reason;
      return this.engine.save(current, 'verification-recorded', { runId, disposition, decisionId: d.id });
    });
  }
  async handoff(id, attemptId, host, { expectedRevision, expectedState } = {}) {
    string(expectedState, 'expectedState');
    const { m, attempt, project, task } = this.locate(id, attemptId, expectedRevision);
    requireThat(attempt.state === 'verified', 'invalid-state', '독립 검증을 통과한 시도만 인계할 수 있습니다.');
    const run = this.store.need('verification-run', attempt.verificationRunId); assertSealed(run);
    requireThat(run.state === 'verified' && run.attemptId === attempt.id && run.missionId === m.id, 'invalid-evidence', '현재 시도의 검증 결과가 아닙니다.');
    const remote = await host.inspect(project, expectedState);
    // 작업이 없을 때 남은 임대(other-work)는 끝난 작업의 기록이다 — code-agent 도 다음 진행 명령에서 넘겨받는다
    requireThat(remote.stateVersion === expectedState && remote.resume?.code === 'no-work' && remote.work === null && remote.request === null && remote.consents?.readable && !remote.consents.open.length &&
      ['none', 'released', 'other-work'].includes(remote.ownership?.lease?.state), 'handoff-pending', '기존 code-agent 반영 절차와 세션 임대 해제가 끝나야 인계할 수 있습니다.');
    const tree = snapshotTree(project.path);
    this.inputsCurrent(m, project.id, task.id);
    requireThat(checkpointsCurrent(m, project.id), 'stale-evidence', '선행 검증 산출물이 변경됐습니다.');
    let delivery;
    if (attempt.recipe.delivery) {
      if (attempt.deliveryRunId) {
        delivery = this.store.need('delivery-run', attempt.deliveryRunId); assertSealed(delivery);
        requireThat(delivery.state === 'verified' && delivery.missionId === id && delivery.attemptId === attemptId && delivery.verificationRunId === run.id && delivery.after.digest === tree.digest && delivery.after.head === tree.head,
          'delivery-pending', '현재 시도·파일의 검증된 반영 기록이 필요합니다.');
        inspectDelivery(project, attempt, run, tree, this.store);
      } else {
        const result = await verifyDelivery(this, id, attempt, project, run, tree, host, expectedRevision, expectedState);
        delivery = result.record; expectedRevision = result.revision;
      }
    } else requireThat(tree.digest === run.after.digest, 'stale-evidence', '검증 이후 파일이 변경됐습니다. 인계할 수 없습니다.');
    return this.store.transaction(() => {
      const current = this.locate(id, attemptId, expectedRevision);
      const d = this.engine.decision(current.m, 'handoff-live', { reason: '검증된 파일 내용과 code-agent의 활성 작업·임대 없음을 확인해 로컬 산출물을 인계합니다.',
        evidence: [run.id, `tree:${tree.digest}`, `state:${expectedState}`], alternatives: ['인계 보류', '검증된 작업 완료'], nextAction: 'dispatch-ready-task', verification: task.verification });
      const evidence = { id: randomUUID(), missionId: id, taskId: task.id, attemptId, planVersion: attempt.planVersion, projectId: project.id,
        provenance: 'live-verification', verificationRunId: run.id, checks: run.checks, tree, artifacts: run.artifacts, contracts: run.contracts ?? [], decisionId: d.id, remote, at: now(),
        delivery: delivery ? { level: 'local-commit-with-consent-record', runId: delivery.id, commit: delivery.details.commit, receiptHash: delivery.details.receiptHash } : { level: 'local-files' } };
      evidence.seal = sealOf(evidence); this.store.put('evidence', evidence);
      current.attempt.state = 'succeeded'; current.attempt.finishedAt = now();
      const t = taskState(current.m, task.id); t.state = 'succeeded'; t.evidenceIds.push(evidence.id);
      current.m.liveCheckpoints ??= {}; current.m.liveCheckpoints[project.id] = tree;
      current.m.state = 'planned'; current.m.reason = d.reason;
      this.store.release(project.id, attemptId);
      return this.engine.save(current.m, 'live-handed-off', { attemptId, evidenceId: evidence.id, decisionId: d.id });
    });
  }
  complete(id, expectedRevision) {
    return this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision);
      requireThat(m.mode === 'live' && ['planned', 'executing', 'blocked'].includes(m.state) && !m.planningHold && m.tasks.length && m.tasks.every(t => t.state === 'succeeded'), 'incomplete', '현재 live 계획의 모든 작업 인계가 필요합니다.');
      requireThat(this.engine.projectVersionsMatch(m), 'stale-evidence', '완료 판정 시 프로젝트 조건이 바뀌었습니다.');
      const evidence = m.tasks.flatMap(t => t.evidenceIds.map(id => this.store.need('evidence', id)));
      for (const e of evidence) {
        assertSealed(e);
        const run = this.store.need('verification-run', e.verificationRunId); assertSealed(run);
        if (e.delivery?.runId) {
          const delivery = this.store.need('delivery-run', e.delivery.runId); assertSealed(delivery);
          requireThat(delivery.state === 'verified' && delivery.missionId === id && delivery.attemptId === e.attemptId && delivery.verificationRunId === run.id && delivery.after.digest === e.tree.digest && delivery.after.head === e.tree.head && delivery.checks.every(c => c.passed), 'invalid-evidence', '현재 증거에 결합된 반영 후 검증이 필요합니다.');
        }
        requireThat(e.provenance === 'live-verification' && e.missionId === id && e.planVersion === activePlan(m).version && e.attemptId === taskState(m, e.taskId).attemptIds.at(-1) && run.state === 'verified' && run.missionId === id && run.attemptId === e.attemptId, 'invalid-evidence', '현재 계획·시도의 실제 검증 증거만 사용할 수 있습니다.');
      }
      for (const task of activePlan(m).proposal.tasks) requireThat(task.criteria.every(c => evidence.some(e => e.taskId === task.id && e.checks.some(check => check.passed && check.criterionIds.includes(c)))), 'missing-verification', '작업별 완료 조건 검증이 빠졌습니다.');
      const d = this.engine.decision(m, 'complete-live', { reason: '현재 계획의 모든 작업이 독립 검증과 로컬 산출물 인계를 마쳤습니다.', evidence: evidence.map(e => e.id),
        alternatives: ['추가 검토', '목표 완료'], nextAction: 'succeeded', verification: '계획·시도·검증 증거·현재 파일 내용 대조' });
      m.state = 'succeeded'; m.reason = d.reason;
      return this.engine.save(m, 'live-completed', { decisionId: d.id });
    });
  }
}
