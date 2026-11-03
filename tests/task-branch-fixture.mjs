import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verificationFixture } from './verification-fixture.mjs';
import { sealOf } from '../packages/verification/seal.mjs';
import { queueTaskBranch } from '../packages/verification/task-branch.mjs';
import { ControlError } from '../packages/code-agent-adapter/control.mjs';

/** Git 쓰기는 기존 시험처럼 격리된 임시 저장소에서만 수행한다. 실제 연결·운영 프로젝트는 사용하지 않는다. */
export function branchFixture(t, { taskNumber = 'TASK-42' } = {}) {
  const f = verificationFixture(t), path = f.projects[0].path;
  const git = (...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe', windowsHide: true }).trim();
  const base = git('rev-parse', 'HEAD');
  let m = f.store.need('mission', f.mission.id);
  if (taskNumber) m.taskNumber = taskNumber;
  f.store.put('mission', m, m.revision);
  const commit = (label, parent) => {
    // 날짜가 아닌 인계 순서로 선택하는 시험을 위해 모든 commit 시각을 고정한다.
    const tree = git('rev-parse', `${base}^{tree}`);
    return execFileSync('git', ['-C', path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', parent ?? base, '-m', label],
      { encoding: 'utf8', stdio: 'pipe', windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } }).trim();
  };
  const handoff = (name, hash, { projectId = 'one', localFiles = false, queue = true, missionId = f.mission.id } = {}) => f.store.transaction(() => {
    const current = f.store.need('mission', missionId), attempt = { id: `a-${name}`, taskId: name, projectId, codeAgentWorkId: `MA-${name}`, state: 'succeeded', turns: [], planVersion: 1 };
    const e = { id: randomUUID(), missionId, taskId: name, projectId, attemptId: attempt.id, planVersion: 1, provenance: 'live-verification', tree: { head: hash },
      checks: [{ id: `check-${name}`, passed: true, criterionIds: ['value'] }], delivery: localFiles ? { level: 'local-files' } : { level: 'local-commit-with-consent-record', commit: hash } };
    e.seal = sealOf(e); f.store.put('evidence', e);
    // 배열은 인계의 역순이다.
    current.attempts.unshift(attempt); current.tasks.unshift({ id: name, state: 'succeeded', attemptIds: [attempt.id], evidenceIds: [e.id] });
    current.plans[0].proposal.tasks.unshift({ ...f.tasks[0], id: name, projectId, goal: `${name} 변경` });
    f.store.put('mission', current, current.revision);
    f.store.event(missionId, 'live-handed-off', { attemptId: attempt.id, evidenceId: e.id });
    if (queue) queueTaskBranch(f.store, current, e, attempt);
    return e;
  });
  const finish = () => {
    const current = f.store.need('mission', f.mission.id);
    current.tasks = current.tasks.filter(t => t.state === 'succeeded');
    current.plans[0].proposal.tasks = current.plans[0].proposal.tasks.filter(t => current.tasks.some(s => s.id === t.id));
    current.state = 'succeeded'; f.store.put('mission', current, current.revision);
  };
  const calls = [], commands = new Map(); let fail, loseResponse = false, supported = true;
  const host = { client() { return { async result(type, options) {
    calls.push({ type, ...options });
    if (type === 'hello') return { commands: { mutating: supported ? ['task-branch'] : [] } };
    if (type !== 'task-branch') throw new Error(type);
    if (commands.has(options.commandId)) return commands.get(options.commandId);
    if (fail) throw new ControlError({ code: fail, message: `시험 ${fail}` });
    const { taskNumber, commit } = options.payload;
    const ref = `refs/heads/task/${taskNumber}`;
    let old;
    try { old = git('rev-parse', '--verify', ref); } catch { /* absent */ }
    if (old) {
      try { git('merge-base', '--is-ancestor', old, commit); }
      catch { throw new ControlError({ code: 'conflict', message: 'fast-forward만 허용' }); }
    }
    git('update-ref', ref, commit, old ?? '0'.repeat(40));
    const result = { branch: `task/${taskNumber}`, commit }; commands.set(options.commandId, result);
    if (loseResponse) { loseResponse = false; const error = new Error('응답 유실'); error.code = 'control-unavailable'; throw error; }
    return result;
  } }; } };
  return { ...f, path, git, base, commit, handoff, finish, calls, executionHost: f.host, host,
    fail(code) { fail = code; }, lose() { loseResponse = true; }, support(value) { supported = value; } };
}

export async function realDelivered(t, { taskNumber = 'TASK-42' } = {}) {
  const f = branchFixture(t, { taskNumber });
  f.verifier.configure(f.mission.id, { ...f.recipes[0], delivery: { mode: 'code-agent-commit', metadataPaths: ['delivery.md'] } }, f.options('one').expectedRevision);
  const attempt = await f.dispatch('edit-one'); await f.verify(attempt);
  const directory = join(f.path, '.code-agent', 'approvals', attempt.codeAgentWorkId); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'consents.jsonl'), JSON.stringify({ id: 'fixture-consent', action: 'deliver', status: 'this-commit', createdAt: new Date().toISOString(),
    preparedSession: { host: 'claude', id: 'fixture-session' }, observed: [{ choices: ['반영'] }] }) + '\n');
  writeFileSync(join(f.path, 'delivery.md'), '반영 기록\n');
  f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture delivery');
  f.git('branch', `feature/${attempt.codeAgentWorkId}`);
  Object.assign(f.states.one, { stateVersion: 'delivered', work: null, request: null, resume: { code: 'no-work' } });
  return { ...f, attempt };
}
