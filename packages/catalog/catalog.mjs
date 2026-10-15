import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateProject, requireThat, string, strings, now } from '../domain/contracts.mjs';

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
    string(input.id, 'group.id'); string(input.name, 'group.name'); strings(input.projectIds, 'group.projectIds');
    return this.store.transaction(() => {
      input.projectIds.forEach(id => this.store.need('project', id));
      return this.store.put('group', { id: input.id, name: input.name, projectIds: input.projectIds }, expectedRevision);
    });
  }
  snapshot(scope) {
    const groups = scope.groupIds.map(id => this.store.need('group', id));
    const ids = [...new Set([...scope.projectIds, ...groups.flatMap(g => g.projectIds)])].sort();
    requireThat(ids.length, 'empty-scope', '대상 프로젝트가 없습니다.');
    const projects = ids.map(id => this.store.need('project', id));
    return { projectIds: ids, projects: projects.map(p => ({ id: p.id, path: p.path })), groups: groups.map(g => ({ id: g.id, revision: g.revision, projectIds: g.projectIds })) };
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
