import { realpathSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { pendingHumanResponse } from '../code-agent-adapter/interactions.mjs';
import { validateProject, requireThat, string, strings, now, object } from '../domain/contracts.mjs';

export function normalizedPath(path) {
  const actual = realpathSync(resolve(path));
  requireThat(statSync(actual).isDirectory(), 'invalid-path', '프로젝트 경로는 디렉터리여야 합니다.');
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
}
export class Catalog {
  constructor(store) { this.store = store; }
  projects() { return this.store.list('project').filter(p => !p.deletedAt); }
  groups() { return this.store.list('group').filter(g => !g.deletedAt); }
  activeGroup(id) {
    const group = this.store.need('group', id);
    requireThat(!group.deletedAt, 'not-found', `그룹 ${id}는 삭제되었습니다. 새 그룹은 다른 ID로 만드세요.`);
    return group;
  }
  removeGroup(id, expectedRevision) {
    string(id, 'group.id');
    requireThat(Number.isInteger(expectedRevision) && expectedRevision > 0, 'invalid-input', '그룹 버전이 필요합니다.');
    return this.store.transaction(() => {
      const group = this.activeGroup(id);
      requireThat(group.revision === expectedRevision, 'stale-state', '그룹 구성이 변경되었습니다. 다시 조회하세요.');
      // Accepted missions retain their own scope; deleting a group never cancels their work.
      const removed = this.store.put('group', { ...group, deletedAt: now() }, expectedRevision);
      return { id, deletedAt: removed.deletedAt };
    });
  }
  active(id) {
    const project = this.store.need('project', id);
    requireThat(!project.deletedAt, 'not-found', `프로젝트 ${id}는 등록 해제되었습니다. 다시 등록하려면 새 ID를 사용하세요.`);
    return project;
  }
  remove(id, expectedRevision) {
    string(id, 'project.id');
    requireThat(Number.isInteger(expectedRevision) && expectedRevision > 0, 'invalid-input', '프로젝트 버전이 필요합니다.');
    return this.store.transaction(() => {
      const project = this.active(id);
      requireThat(project.revision === expectedRevision, 'stale-state', '프로젝트 정보가 변경되었습니다. 다시 조회하세요.');
      requireThat(!this.store.lock(id) && !this.store.get('project-maintenance', id)?.active,
        'project-busy', '프로젝트 실행 또는 업데이트 잠금이 있습니다. 완료하거나 중단 상태를 먼저 점검하세요.');
      requireThat(!pendingHumanResponse(this.store, id), 'project-busy', '사람 응답의 전송·적용 결과를 먼저 확인하세요.');
      const mission = this.store.list('mission').find(m => m.scope.projectIds.includes(id) && !['simulation-complete', 'succeeded', 'cancelled'].includes(m.state));
      requireThat(!mission, 'project-in-use', `미완료 목표 ${mission?.id}에서 사용하는 프로젝트입니다. 목표를 완료하거나 취소한 뒤 삭제하세요.`);
      const updating = this.store.list('agent-update').some(batch => {
        if (batch.state !== 'running' || !batch.projects.some(p => p.id === id && ['ready', 'running'].includes(p.state))) return false;
        if (batch.host !== hostname()) return true;
        try { process.kill(batch.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
      });
      requireThat(!updating, 'project-busy', '이 프로젝트를 포함한 일괄 업데이트가 진행 중입니다. 완료 후 삭제하세요.');
      const groups = this.groups().filter(g => g.projectIds.includes(id));
      for (const group of groups) this.store.put('group', { ...group, projectIds: group.projectIds.filter(pid => pid !== id) }, group.revision);
      // Keep immutable identity and historical references; release only the active path registration.
      const removed = this.store.put('project', { ...project, deletedAt: now() }, expectedRevision);
      this.store.db.prepare('DELETE FROM paths WHERE project_id=?').run(id);
      return { id, deletedAt: removed.deletedAt, removedFromGroups: groups.map(g => g.id) };
    });
  }
  register(input, { inTransaction = false } = {}) {
    validateProject(input);
    const path = normalizedPath(input.path);
    const persist = () => {
      requireThat(!this.store.db.prepare('SELECT project_id FROM paths WHERE path=?').get(path), 'duplicate-path', '이미 등록된 실행 경로입니다.');
      const project = this.store.put('project', { ...input, path, registeredAt: now() });
      this.store.db.prepare('INSERT INTO paths VALUES (?,?)').run(path, input.id);
      return project;
    };
    return inTransaction ? persist() : this.store.transaction(persist);
  }
  manualProject(input) {
    object(input, 'project');
    string(input.path, 'project.path');
    if (input.references !== undefined) strings(input.references, 'references');
    requireThat(isAbsolute(input.path), 'invalid-path', '프로젝트 폴더의 절대 경로를 입력하세요.');
    try { normalizedPath(input.path); }
    catch { requireThat(false, 'invalid-path', `${input.name ?? input.id ?? '프로젝트'}: 존재하고 접근 가능한 프로젝트 폴더를 입력하세요.`); }
    // Registration is an operator declaration, not collected policy/code evidence or a control grant.
    return { id: input.id, name: input.name, path: input.path, domains: input.domains,
      capabilities: input.capabilities ?? ['code-agent:managed'], constraints: input.constraints ?? [], currentPlans: input.currentPlans ?? [],
      references: input.references?.length ? input.references : [`operator:project:${input.id}`] };
  }
  registerManual(input) { return this.register(this.manualProject(input)); }
  updateKnowledge(id, patch, expectedRevision) {
    return this.store.transaction(() => {
      const project = this.active(id);
      const next = { ...project };
      for (const field of ['domains', 'capabilities', 'constraints', 'currentPlans', 'references']) if (patch[field] !== undefined) next[field] = patch[field];
      validateProject(next);
      return this.store.put('project', next, expectedRevision);
    });
  }
  group(input, expectedRevision = 0, { newProjects = [] } = {}) {
    object(input, 'group');
    string(input.id, 'group.id'); string(input.name, 'group.name'); strings(input.projectIds, 'group.projectIds');
    requireThat(Number.isInteger(expectedRevision) && expectedRevision >= 0, 'invalid-input', '그룹 버전이 필요합니다.');
    requireThat(input.description === undefined || typeof input.description === 'string', 'invalid-input', '서비스 범위 설명은 문자열이어야 합니다.');
    requireThat(Array.isArray(newProjects) && newProjects.length <= 100, 'invalid-input', '새 프로젝트는 최대 100개까지 등록할 수 있습니다.');
    return this.store.transaction(() => {
      const current = this.store.get('group', input.id);
      if (expectedRevision > 0) this.activeGroup(input.id);
      requireThat(expectedRevision === 0 ? !current : current?.revision === expectedRevision,
        expectedRevision === 0 ? 'already-exists' : 'stale-state', '그룹이 이미 존재하거나 변경되었습니다. 다시 조회하세요.');
      for (const draft of newProjects) {
        const project = this.manualProject(draft);
        requireThat(input.projectIds.includes(project.id), 'invalid-input', '새 프로젝트는 이 그룹의 소속으로 선택해야 합니다.');
        this.register(project, { inTransaction: true });
      }
      input.projectIds.forEach(id => this.active(id));
      return this.store.put('group', { id: input.id, name: input.name, description: input.description ?? '', projectIds: input.projectIds }, expectedRevision);
    });
  }
  membership(id, projectId, action, expectedRevision) {
    requireThat(['add', 'remove'].includes(action), 'invalid-input', '그룹 구성원 추가 또는 제외가 필요합니다.');
    const group = this.activeGroup(id);
    requireThat(group.revision === expectedRevision, 'stale-state', '그룹이 변경되었습니다. 다시 조회하세요.');
    this.active(projectId);
    const projectIds = action === 'add' ? [...new Set([...group.projectIds, projectId])] : group.projectIds.filter(pid => pid !== projectId);
    return this.group({ ...group, projectIds }, expectedRevision);
  }
  snapshot(scope) {
    const groups = scope.groupIds.map(id => this.activeGroup(id));
    const ids = [...new Set([...scope.projectIds, ...groups.flatMap(g => g.projectIds)])].sort();
    requireThat(ids.length, 'empty-scope', '대상 프로젝트가 없습니다.');
    const projects = ids.map(id => this.active(id));
    return { projectIds: ids, projects: projects.map(p => ({ id: p.id, path: p.path })), groups: groups.map(g => ({ id: g.id, name: g.name, description: g.description ?? '', revision: g.revision, projectIds: g.projectIds })) };
  }
  status() {
    return this.projects().map(p => {
      const lock = this.store.lock(p.id) ?? null;
      const attempt = lock ? this.store.need('mission', lock.mission_id).attempts.find(a => a.id === lock.attempt_id) : null;
      return { ...p, observation: this.store.get('observation', p.id) ?? { status: 'unobserved' }, execution: lock,
        executionStatus: attempt ? { mode: attempt.mode, state: attempt.state, taskId: attempt.taskId,
          codeAgentWorkId: attempt.codeAgentWorkId ?? null, lastTurn: attempt.turns?.at(-1) ?? null } : null };
    });
  }
}
