import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateProject, requireThat, string, strings, now, object } from '../domain/contracts.mjs';

export function normalizedPath(path) {
  const actual = realpathSync(resolve(path));
  requireThat(statSync(actual).isDirectory(), 'invalid-path', '프로젝트 경로는 디렉터리여야 합니다.');
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
}
export class Catalog {
  constructor(store) { this.store = store; }
  register(input) {
    validateProject(input);
    const path = normalizedPath(input.path);
    return this.store.transaction(() => {
      requireThat(!this.store.db.prepare('SELECT project_id FROM paths WHERE path=?').get(path), 'duplicate-path', '이미 등록된 실행 경로입니다.');
      const project = this.store.put('project', { ...input, path, registeredAt: now() });
      this.store.db.prepare('INSERT INTO paths VALUES (?,?)').run(path, input.id);
      return project;
    });
  }
  updateKnowledge(id, patch, expectedRevision) {
    return this.store.transaction(() => {
      const project = this.store.need('project', id);
      const next = { ...project };
      for (const field of ['domains', 'capabilities', 'constraints', 'currentPlans', 'references']) if (patch[field] !== undefined) next[field] = patch[field];
      validateProject(next);
      return this.store.put('project', next, expectedRevision);
    });
  }
  group(input, expectedRevision = 0) {
    object(input, 'group');
    string(input.id, 'group.id'); string(input.name, 'group.name'); strings(input.projectIds, 'group.projectIds');
    requireThat(Number.isInteger(expectedRevision) && expectedRevision >= 0, 'invalid-input', '그룹 버전이 필요합니다.');
    requireThat(input.description === undefined || typeof input.description === 'string', 'invalid-input', '서비스 범위 설명은 문자열이어야 합니다.');
    return this.store.transaction(() => {
      input.projectIds.forEach(id => this.store.need('project', id));
      return this.store.put('group', { id: input.id, name: input.name, description: input.description ?? '', projectIds: input.projectIds }, expectedRevision);
    });
  }
  membership(id, projectId, action, expectedRevision) {
    requireThat(['add', 'remove'].includes(action), 'invalid-input', '그룹 구성원 추가 또는 제외가 필요합니다.');
    const group = this.store.need('group', id);
    requireThat(group.revision === expectedRevision, 'stale-state', '그룹이 변경되었습니다. 다시 조회하세요.');
    this.store.need('project', projectId);
    const projectIds = action === 'add' ? [...new Set([...group.projectIds, projectId])] : group.projectIds.filter(pid => pid !== projectId);
    return this.group({ ...group, projectIds }, expectedRevision);
  }
  snapshot(scope) {
    const groups = scope.groupIds.map(id => this.store.need('group', id));
    const ids = [...new Set([...scope.projectIds, ...groups.flatMap(g => g.projectIds)])].sort();
    requireThat(ids.length, 'empty-scope', '대상 프로젝트가 없습니다.');
    const projects = ids.map(id => this.store.need('project', id));
    return { projectIds: ids, projects: projects.map(p => ({ id: p.id, path: p.path })), groups: groups.map(g => ({ id: g.id, name: g.name, description: g.description ?? '', revision: g.revision, projectIds: g.projectIds })) };
  }
  status() {
    return this.store.list('project').map(p => {
      const lock = this.store.lock(p.id) ?? null;
      const attempt = lock ? this.store.need('mission', lock.mission_id).attempts.find(a => a.id === lock.attempt_id) : null;
      return { ...p, observation: this.store.get('observation', p.id) ?? { status: 'unobserved' }, execution: lock,
        executionStatus: attempt ? { mode: attempt.mode, state: attempt.state, taskId: attempt.taskId,
          codeAgentWorkId: attempt.codeAgentWorkId ?? null, lastTurn: attempt.turns?.at(-1) ?? null } : null };
    });
  }
}
