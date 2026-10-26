import { phaseGraph } from './operation-graph.mjs';
import { randomUUID } from 'node:crypto';
import { Engine } from './engine.mjs';
import { Knowledge } from '../knowledge/sources.mjs';
import { Planner } from '../reasoning/planner.mjs';
import { snapshotTree, changesBetween } from '../verification/tree.mjs';
import { requireThat, now } from '../domain/contracts.mjs';

/** 외부 작업을 종료시키지 않는다. 종료가 관측된 실패 시도만 보존·정리한다. */
export class Replanning {
  constructor(store) { this.store = store; this.engine = new Engine(store); }
  refresh(id, expectedRevision) {
    return this.store.transaction(() => {
      const m = this.engine.checked(id, expectedRevision);
      requireThat(m.replanPending && ['blocked', 'waiting-decision'].includes(m.state) &&
        !m.attempts.some(a => a.recoveryBusy || a.mode === 'live' && !['succeeded', 'abandoned'].includes(a.state)),
      'invalid-state', '인계가 끝난 재계획 대기 목표만 재동기화할 수 있습니다.');
      const trees = {}, changes = [], snapshots = [], knowledge = new Knowledge(this.store), at = now();
      for (const projectId of m.scope.projectIds) {
        requireThat(!this.store.lock(projectId), 'project-busy', '재계획 대상에 다른 실행 소유권이 있습니다.');
        const project = this.store.need('project', projectId), before = m.replanContext.trees[projectId];
        const after = snapshotTree(project.path);
        trees[projectId] = after;
        if (before.digest !== after.digest || before.head !== after.head) changes.push({ projectId, at,
          from: { digest: before.digest, head: before.head }, to: { digest: after.digest, head: after.head },
          files: changesBetween(before, after).map(path => ({ path,
            fromDigest: before.files.find(f => f.path === path)?.digest ?? null,
            toDigest: after.files.find(f => f.path === path)?.digest ?? null })) });
        const old = this.store.need('knowledge-snapshot', project.knowledgeSnapshotId);
        snapshots.push(knowledge.collect(projectId, { schemaVersion: 1, sources: old.sources.map(({ path, kind }) => ({ path, kind })) },
          project.revision, { inTransaction: true }).snapshot.id);
      }
      for (const projectId of m.scope.projectIds) {
        const current = snapshotTree(this.store.need('project', projectId).path);
        requireThat(current.digest === trees[projectId].digest && current.head === trees[projectId].head,
          'stale-replan', '재동기화 중 파일 또는 HEAD가 변경됐습니다. 다시 조회하세요.');
      }
      const d = this.engine.decision(m, 'refresh-replan', { actor: 'operator', reason: '인계 이후 바뀐 파일과 HEAD를 기록하고 최신 근거로 재분석합니다.',
        evidence: [m.replanContext.id, ...snapshots], alternatives: ['기존 기준 유지', '변경 내역을 보존하고 재동기화'], nextAction: 'reanalyze',
        verification: '인계 상태·목표 버전·프로젝트 잠금·근거 수집 전후 트리 대조', treeChanges: changes });
      m.replanContext = { ...m.replanContext, trees, sourceSnapshotIds: snapshots,
        treeChanges: [...(m.replanContext.treeChanges ?? []), ...changes], refreshedAt: at, refreshDecisionId: d.id };
      delete m.replanRefreshRequired;
      m.state = 'blocked'; m.planningHold = true; m.reason = '재동기화를 마쳤습니다. 최신 근거로 새 계획을 분석해야 합니다.';
      return this.engine.save(m, 'replan-refreshed', { decisionId: d.id });
    });
  }
  async transition(id, attemptId, host, provider, { expectedRevision, expectedState } = {}) {
    return phaseGraph(this.store, 'replan', randomUUID(), [
      { name: 'inspect-settlement', run: async () => {
        const before = this.engine.checked(id, expectedRevision), attempt = before.attempts.find(a => a.id === attemptId);
        requireThat(before.mode === 'live' && ['blocked', 'waiting-decision'].includes(before.state) && attempt?.state === 'verification-failed' && !attempt.recoveryBusy &&
          attempt.recoveryRunId && attempt.planVersion === before.plans.at(-1).version &&
          before.tasks.find(t => t.id === attempt.taskId)?.attemptIds.at(-1) === attemptId && this.store.lock(attempt.projectId)?.attempt_id === attemptId,
        'invalid-state', '현재 실패 시도의 재계획 보류와 소유권이 필요합니다.');
        const recovery = this.store.need('recovery-run', attempt.recoveryRunId);
        requireThat(recovery.missionId === id && recovery.attemptId === attemptId && recovery.sourceVerificationRunId === attempt.verificationRunId &&
          recovery.state === 'held' && recovery.proposal.action === 'replan', 'invalid-replan', '현재 실패에 결합된 재계획 제안이 필요합니다.');
        requireThat(!before.attempts.some(a => a.id !== attemptId && a.mode === 'live' && !['succeeded', 'abandoned'].includes(a.state)), 'unsettled-attempt', '다른 실제 실행 시도를 먼저 정리해야 합니다.');
        const trees = {}, remotes = {};
        for (const projectId of before.scope.projectIds) {
          const project = this.store.need('project', projectId), lock = this.store.lock(projectId);
          requireThat(!lock || lock.attempt_id === attemptId, 'project-busy', '다른 실행이 프로젝트를 소유하고 있습니다.');
          const remote = await host.inspect(project, projectId === attempt.projectId ? expectedState : undefined);
          requireThat((projectId !== attempt.projectId || remote.stateVersion === expectedState) && remote.work === null && remote.request === null &&
            remote.resume?.code === 'no-work' && remote.consents?.readable && Array.isArray(remote.consents.open) && !remote.consents.open.length &&
            !remote.questions?.unanswered?.length && !remote.questions?.unverified?.length && ['none', 'released'].includes(remote.ownership?.lease?.state),
          'handoff-pending', '모든 대상의 외부 작업·접수·질문·동의·임대 종료가 필요합니다.');
          trees[projectId] = snapshotTree(project.path); remotes[projectId] = remote;
        }
        requireThat(trees[attempt.projectId].digest === recovery.tree.digest && trees[attempt.projectId].head === recovery.tree.head,
          'stale-replan', '재계획 판단 후 변경된 파일·커밋은 자동으로 수용하지 않습니다.');

        return { before, attempt, recovery, trees, remotes };
      } },
      { name: 'preserve-and-refresh', run: async f => {
        const { attempt, recovery, trees, remotes } = f;
        const result = this.store.transaction(() => {
          const m = this.engine.checked(id, expectedRevision), a = m.attempts.find(a => a.id === attemptId);
          const handoffId = randomUUID();
          const d = this.engine.decision(m, 'handoff-replan', { reason: recovery.proposal.summary, evidence: [recovery.id, attempt.verificationRunId],
            alternatives: ['현재 작업 보존 후 대기', '최신 근거로 재계획'], nextAction: 'reanalyze', verification: '외부 종료·파일 보존·소유권·최신 근거 대조' });
          const knowledge = new Knowledge(this.store), snapshots = [];
          for (const projectId of m.scope.projectIds) {
            const project = this.store.need('project', projectId), old = this.store.need('knowledge-snapshot', project.knowledgeSnapshotId);
            const snapshot = knowledge.collect(projectId, { schemaVersion: 1, sources: old.sources.map(({ path, kind }) => ({ path, kind })) }, project.revision, { inTransaction: true }).snapshot;
            snapshots.push(snapshot.id);
            const current = snapshotTree(project.path);
            requireThat(current.digest === trees[projectId].digest && current.head === trees[projectId].head, 'stale-replan', '근거 재수집 중 파일이 변경됐습니다.');
            requireThat(!this.store.lock(projectId) || this.store.lock(projectId).attempt_id === attemptId, 'project-busy', '실행 소유권이 변경됐습니다.');
          }
          const handoff = { id: handoffId, missionId: id, attemptId, planVersion: a.planVersion, recoveryId: recovery.id,
            proposal: recovery.proposal, trees, remotes, sourceSnapshotIds: snapshots, decisionId: d.id, at: now() };
          this.store.put('replan-handoff', handoff);
          a.state = 'abandoned'; a.finishedAt = now(); a.replanHandoffId = handoffId;
          m.tasks.find(t => t.id === a.taskId).state = 'abandoned';
          this.store.release(a.projectId, a.id);
          m.replanPending = true; m.replanContext = handoff; m.planningHold = true; delete m.recoveryHold;
          m.state = 'blocked'; m.reason = '기존 변경을 보존했습니다. 최신 근거로 새 계획을 분석해야 합니다.';
          return this.engine.save(m, 'replan-handed-off', { handoffId, decisionId: d.id });
        });

        return { revision: result.revision };
      } },
      { name: 'analyze', run: async f => ({ result: provider
        ? await new Planner(this.store).analyze(id, provider, { expectedRevision: f.revision })
        : { mission: this.engine.describe(id) } }) },
    ]);
  }
}
