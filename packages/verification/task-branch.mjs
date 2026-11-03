import { randomUUID } from 'node:crypto';
import { now, requireThat } from '../domain/contracts.mjs';
import { commitExists, containsCommit, localBranches, projectHandoffs, assertProjectChain } from './project-history.mjs';

export const taskBranchRecordId = evidenceId => `task-branch-${evidenceId}`;

/** handoff 트랜잭션 안에서만 호출한다. 증거·delivery-run을 수정하지 않는다. */
export function queueTaskBranch(store, mission, evidence, attempt) {
  const id = taskBranchRecordId(evidence.id);
  const handoffSequence = store.events(mission.id).find(e => e.type === 'live-handed-off' && e.evidenceId === evidence.id)?.sequence;
  requireThat(Number.isSafeInteger(handoffSequence), 'handoff-order-missing', '인계 이벤트가 먼저 저장되어야 합니다.');
  const commit = evidence.delivery?.level === 'local-commit-with-consent-record' ? evidence.delivery.commit : null;
  const reason = !mission.taskNumber ? 'TASK 번호가 없어 작업 브랜치를 안내합니다.' : !commit ? 'local-files 인계에는 유효한 작업 반영 커밋이 없습니다.' : null;
  const record = store.put('control-command', { id, type: 'task-branch', commandId: id, missionId: mission.id, projectId: evidence.projectId,
    evidenceId: evidence.id, attemptId: attempt.id, handoffSequence,
    payload: { taskNumber: mission.taskNumber ?? null, workId: attempt.codeAgentWorkId, commit },
    state: reason ? 'skipped' : 'pending', reason, createdAt: now() });
  store.event(mission.id, 'task-branch-requested', { commandId: id, evidenceId: evidence.id, projectId: evidence.projectId, state: record.state });
  return record;
}

function recordResult(store, id, commandId, state, reason, code = null) {
  return store.transaction(() => {
    const record = store.need('control-command', id);
    // 동시에 끝난 동일 요청의 오래된 실패가 성공을 덮지 않는다.
    if (record.commandId !== commandId || ['completed', 'superseded'].includes(record.state)) return record;
    const saved = store.put('control-command', { ...record, state, reason, code, updatedAt: now() }, record.revision);
    store.event(record.missionId, 'task-branch-result', { commandId, projectId: record.projectId, evidenceId: record.evidenceId, state, reason, code });
    return saved;
  });
}

/** 전용 복구 경로. pending/sending은 동일 commandId로 재전송하고, 확정 거부의 새 명령은 명시적으로만 만든다. */
export async function recoverTaskBranches(store, missionId, host, { newCommand = false } = {}) {
  const mission = store.need('mission', missionId);
  requireThat(mission.mode === 'live', 'wrong-mode', 'live 목표의 task 브랜치만 복구합니다.');
  // 이전 버전에서 끝난 인계도 남아 있는 순서 기록을 통해 명시적 복구할 수 있다.
  for (const projectId of new Set(mission.attempts.filter(a => a.state === 'succeeded').map(a => a.projectId))) {
    for (const row of projectHandoffs(store, mission, projectId)) {
      if (!store.get('control-command', taskBranchRecordId(row.evidence.id))) store.transaction(() => {
        if (!store.get('control-command', taskBranchRecordId(row.evidence.id))) queueTaskBranch(store, mission, row.evidence, row.attempt);
      });
    }
  }
  const records = store.list('control-command', { missionId }).filter(r => r.type === 'task-branch').sort((a, b) => b.handoffSequence - a.handoffSequence);
  const results = [];
  for (const original of records) {
    let record = store.need('control-command', original.id);
    if (['completed', 'superseded', 'skipped'].includes(record.state)) { results.push(record); continue; }
    if (record.state === 'failed' && !newCommand) { results.push(record); continue; }
    try {
      const project = store.need('project', record.projectId);
      const latest = () => projectHandoffs(store, store.need('mission', missionId), project.id).at(-1);
      if (latest()?.evidence.id !== record.evidenceId) {
        results.push(recordResult(store, record.id, record.commandId, 'superseded', '뒤 작업이 인계되어 이전 요청을 생략합니다. 최신 요청을 확인하세요.')); continue;
      }
      requireThat(commitExists(project.path, record.payload.commit), 'invalid-state', '요청의 반영 커밋을 저장소에서 확인할 수 없습니다.');
      assertProjectChain(project, projectHandoffs(store, store.need('mission', missionId), project.id));
      const client = host.client(project), hello = await client.result('hello');
      if (!hello.commands?.mutating?.includes('task-branch')) {
        results.push(recordResult(store, record.id, record.commandId, 'unsupported', 'code-agent가 task-branch를 지원하지 않습니다. 실제 작업 브랜치로 PR을 만드세요.', 'unsupported')); continue;
      }
      if (latest()?.evidence.id !== record.evidenceId) {
        results.push(recordResult(store, record.id, record.commandId, 'superseded', '기능 확인 중 뒤 작업이 인계되어 이전 요청을 생략합니다.')); continue;
      }
      const branch = localBranches(project.path).find(b => b.name === `task/${record.payload.taskNumber}`);
      requireThat(!branch || containsCommit(project.path, branch.commit, record.payload.commit), 'conflict',
        '기존 task 브랜치가 요청 커밋의 조상이 아닙니다. 이전 TASK의 브랜치·병합 상태를 사람이 확인해야 합니다. 자동 reset은 하지 않습니다.');
      record = store.transaction(() => {
        const current = store.need('control-command', record.id);
        if (['completed', 'superseded'].includes(current.state)) return current;
        const commandId = current.state === 'failed' && newCommand ? `task-branch-${randomUUID()}` : current.commandId;
        const saved = store.put('control-command', { ...current, commandId, state: 'sending', reason: 'code-agent 응답 대기. 중단 시 같은 commandId로 재전송합니다.', updatedAt: now() }, current.revision);
        store.event(missionId, 'task-branch-sending', { commandId, previousCommandId: current.commandId, projectId: project.id, payload: saved.payload });
        return saved;
      });
      if (record.state !== 'sending') { results.push(record); continue; }
      await client.result('task-branch', { commandId: record.commandId, payload: record.payload });
      const currentBranch = localBranches(project.path).find(b => b.name === `task/${record.payload.taskNumber}`);
      requireThat(currentBranch?.commit === record.payload.commit, 'invalid-state', '응답 후 실제 task 브랜치가 요청한 반영 커밋을 가리키지 않습니다.');
      results.push(recordResult(store, record.id, record.commandId, 'completed', 'task 브랜치가 반영 커밋을 가리킵니다.'));
    } catch (error) {
      const code = error.controlCode ?? error.code ?? 'task-branch-error';
      const uncertain = !error.controlCode && (record.state === 'sending' || code === 'control-unavailable');
      results.push(recordResult(store, record.id, record.commandId, code === 'unsupported' ? 'unsupported' : uncertain ? 'pending' : 'failed', error.message, code));
    }
  }
  return results;
}
