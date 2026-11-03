import { projectHandoffs, assertProjectChain, commitExists, localBranches } from './project-history.mjs';
import { taskBranchRecordId } from './task-branch.mjs';

const statusLabels = { pending: '미처리', sending: '미처리 · 응답 확인 필요', failed: '실패', unsupported: '미지원', completed: '완료', skipped: '생략', superseded: '뒤 작업으로 대체' };
const branchLabels = { unavailable: '확인 불가', 'no-delivery-commit': '반영 커밋 없음', 'not-requested': 'TASK 번호 없음', missing: '브랜치 없음', current: '최종 반영 커밋과 일치', stale: '최종 반영 커밋과 불일치' };
function commandView(store, mission, row) {
  const record = row && store.get('control-command', taskBranchRecordId(row.evidence.id));
  const state = record?.state ?? 'pending';
  const retry = `master-agent mission task-branch ${mission.id} --control`;
  const action = ['pending', 'sending'].includes(state) ? retry : state === 'failed' ? `원인을 해결한 뒤 ${retry} --new-command` :
    state === 'unsupported' ? `실제 작업 브랜치로 PR을 만드세요. task-branch 지원 버전 연결 후에는 ${retry}` :
      state === 'completed' ? '아래 실제 브랜치 상태를 확인하고 안내된 브랜치로 PR을 만드세요.' : record?.reason ?? '인계 기록을 확인하세요.';
  return { state, label: statusLabels[state], commandId: record?.commandId ?? null,
    reason: record ? record.reason ?? '인계 저장 후 task 브랜치 처리를 기다립니다.' : '브랜치 요청 기록이 없습니다.', code: record?.code ?? null, action };
}

/** CLI·대시보드 공통 읽기 전용 계산. 분석 완료 판정·명령 전송·Git 쓰기를 하지 않는다. */
export function missionPullRequests(store, id) {
  const mission = store.need('mission', id), plan = mission.plans.at(-1)?.proposal;
  const complete = mission.mode === 'live' && mission.tasks.length > 0 && mission.tasks.every(t => t.state === 'succeeded');
  const projects = [...new Set((plan?.tasks ?? []).map(t => t.projectId))].map(projectId => {
    const project = store.need('project', projectId);
    const title = mission.taskNumber ? `[${mission.taskNumber}] ${mission.goal}` : mission.goal;
    const result = { projectId, projectName: project.name, ready: false, status: 'PR 준비 미완료', branch: null, commit: null,
      taskBranch: { name: mission.taskNumber ? `task/${mission.taskNumber}` : null, state: 'unavailable', label: branchLabels.unavailable, commit: null },
      update: null, reason: '', squashMessage: title, tasks: [] };
    try {
      const rows = projectHandoffs(store, mission, projectId), last = rows.at(-1);
      result.commit = [...rows].reverse().find(r => r.commit)?.commit ?? null;
      result.update = commandView(store, mission, last);
      result.tasks = rows.map(({ evidence: e, attempt: a, commit }) => ({ taskId: e.taskId, workId: a.codeAgentWorkId,
        goal: mission.plans.find(p => p.version === e.planVersion)?.proposal.tasks.find(t => t.id === e.taskId)?.goal ?? e.taskId,
        commit, level: e.delivery?.level, detailPath: `doc/work/${a.codeAgentWorkId}/10-pr.md`,
        checks: e.checks.map(c => ({ id: c.id, passed: c.passed, criterionIds: c.criterionIds })) }));
      result.squashMessage = [title, '', '작업', ...result.tasks.map(t => `- ${t.workId}: ${t.goal} (${t.commit?.slice(0, 12) ?? '반영 커밋 없음 · local-files'})`),
        '', '완료 조건', ...mission.criteria.map(c => `- ${c.description}`), '', '검증 결과',
        ...result.tasks.map(t => `- ${t.workId}: ${t.checks.map(c => `${c.id} ${c.passed ? '통과' : '실패'}`).join(', ')}; 상세: ${t.detailPath}`)].join('\n');
      if (!last) { result.reason = '이 프로젝트의 완료된 인계가 없습니다.'; return result; }
      assertProjectChain(project, rows);
      if (rows.some(r => !r.commit || !commitExists(project.path, r.commit))) {
        result.reason = '유효한 작업 반영 커밋이 없는 인계가 있습니다. local-files의 tree.head는 미커밋 산출물의 반영을 증명하지 않습니다.';
        result.taskBranch.state = 'no-delivery-commit'; result.taskBranch.label = branchLabels['no-delivery-commit']; return result;
      }
      const branches = localBranches(project.path), task = branches.find(b => b.name === result.taskBranch.name);
      result.taskBranch.commit = task?.commit ?? null;
      result.taskBranch.state = !result.taskBranch.name ? 'not-requested' : !task ? 'missing' : task.commit === last.commit ? 'current' : 'stale';
      result.taskBranch.label = branchLabels[result.taskBranch.state];
      const useTask = result.taskBranch.state === 'current' && result.update.state === 'completed';
      // code-agent 작업 브랜치(kind/workId)를 실제 ref와 대조한다. 이름을 만들어 안내하지 않는다.
      const work = branches.filter(b => b.commit === last.commit && (b.name === last.attempt.codeAgentWorkId || b.name.endsWith(`/${last.attempt.codeAgentWorkId}`)));
      result.branch = useTask ? task.name : work.length === 1 ? work[0].name : null;
      const fallback = !mission.taskNumber ? 'TASK 번호가 없어 실제 작업 브랜치를 사용합니다.' :
        `task 브랜치 처리: ${result.update.label}; 실제 상태: ${result.taskBranch.label}. ${result.update.reason}`;
      result.reason = useTask ? 'task 브랜치가 최종 반영 커밋을 가리킵니다.' : fallback;
      if (!result.branch) result.reason += ' 최종 반영 커밋을 가리키는 작업 브랜치를 확인할 수 없습니다.';
      if (!complete) result.reason = `목표의 모든 작업 인계를 기다립니다. ${result.reason}`;
      result.ready = complete && Boolean(result.branch);
      result.status = result.ready ? 'PR 준비 완료' : 'PR 준비 미완료';
    } catch (error) { result.reason = error.message; result.code = error.code ?? 'git-read-failed'; }
    return result;
  });
  return { missionId: id, complete, projects };
}
