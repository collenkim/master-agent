import { execFileSync } from 'node:child_process';
import { childEnv } from '../runner/process.mjs';
import { requireThat } from '../domain/contracts.mjs';
import { assertSealed } from './seal.mjs';

// 이 모듈의 Git 명령은 조회뿐이다. ref 갱신은 code-agent master call의 책임이다.
const git = (path, args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', shell: false, windowsHide: true,
  timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ GIT_OPTIONAL_LOCKS: '0' }) }).trim();
const objectId = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
export function commitExists(path, commit) {
  if (!objectId(commit)) return false;
  try { return git(path, ['cat-file', '-t', commit]) === 'commit'; } catch { return false; }
}
export function containsCommit(path, ancestor, commit) {
  if (!commitExists(path, ancestor) || !commitExists(path, commit)) return false;
  try { git(path, ['merge-base', '--is-ancestor', ancestor, commit]); return true; } catch { return false; }
}
export function localBranches(path) {
  return git(path, ['for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads/']).split('\n').filter(Boolean)
    .map(line => { const [name, commit] = line.trim().split(' '); return { name, commit }; });
}

/** 배열·시각 대신 인계 트랜잭션의 이벤트 순번을 사용한다. 명령 기록은 이벤트 정리 뒤에도 그 순번을 보존한다. */
export function projectHandoffs(store, mission, projectId) {
  const events = new Map(store.events(mission.id).filter(e => e.type === 'live-handed-off').map(e => [e.evidenceId, e.sequence]));
  const commands = new Map(store.list('control-command', { missionId: mission.id }).filter(c => c.type === 'task-branch').map(c => [c.evidenceId, c.handoffSequence]));
  return store.list('evidence', { missionId: mission.id }).filter(e => e.projectId === projectId && e.provenance === 'live-verification')
    .map(e => {
      const attempt = mission.attempts.find(a => a.id === e.attemptId && a.projectId === projectId && a.taskId === e.taskId && a.state === 'succeeded');
      requireThat(attempt, 'invalid-evidence', `인계 증거 ${e.id}의 완료된 작업을 확인할 수 없습니다.`);
      assertSealed(e);
      const sequence = events.get(e.id) ?? commands.get(e.id);
      requireThat(Number.isSafeInteger(sequence), 'handoff-order-missing', `인계 ${e.id}의 순서 기록이 없습니다. 이벤트·명령 기록을 확인하세요.`);
      return { evidence: e, attempt, sequence, base: e.delivery?.commit ?? e.tree?.head, commit: e.delivery?.level === 'local-commit-with-consent-record' ? e.delivery.commit : null };
    }).sort((a, b) => a.sequence - b.sequence);
}

export function assertProjectChain(project, handoffs) {
  const last = handoffs.at(-1);
  if (!last) return;
  for (const row of handoffs) requireThat(containsCommit(project.path, row.base, last.base), 'delivery-history',
    `프로젝트 ${project.id}의 마지막 인계 기준 ${last.base ?? '없음'}이 앞선 인계 ${row.evidence.taskId}의 커밋 ${row.base ?? '없음'}을 포함하지 않습니다. 커밋 연결을 확인하세요. 자동 병합·reset은 하지 않습니다.`);
}

export function dispatchBase(store, mission, project, workId, remote) {
  // 같은 work ID의 재배정·기존 원격 작업에는 새 기준을 주입하지 않는다.
  if (remote?.work?.id === workId || mission.attempts.some(a => a.projectId === project.id && a.codeAgentWorkId === workId)) return undefined;
  const rows = projectHandoffs(store, mission, project.id);
  assertProjectChain(project, rows);
  return rows.at(-1)?.base;
}
