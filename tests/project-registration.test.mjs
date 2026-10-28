import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { setup } from './helpers.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { SimulationRunner } from '../packages/simulation/runner.mjs';
import { acceptRequest } from '../packages/orchestrator/requests.mjs';

async function dashboardFixture(t) {
  const context = setup(t);
  const dashboard = await startDashboard({ dbPath: context.db, port: 0, observe: false,
    candidateOptions: { cwd: context.root, home: dirname(context.root) } });
  const { token } = await (await fetch(dashboard.url + '/api/overview')).json();
  const post = async (path, body, headers = {}) => {
    const response = await fetch(dashboard.url + path, { method: 'POST',
      headers: { Origin: dashboard.url, 'Content-Type': 'application/json', 'X-Master-Token': token, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const draft = id => {
    const path = join(context.root, id); mkdirSync(path);
    return { id, name: `프로젝트 ${id}`, path, domains: ['주문'] };
  };
  return { ...context, dashboard, post, draft };
}

function registrationTest(name, run) {
  test(name, async t => {
    const context = await dashboardFixture(t);
    try { await run(context); } finally { await context.dashboard.close(); }
  });
}

registrationTest('group deletion keeps projects and accepted scope, permits existing work and rejects new use of the deleted identity', async ({ store, engine, fixture, mission, dashboard, post, draft }) => {
  const group = store.need('group', fixture.group.id), projects = store.list('project');
  const input = { targetType: 'group', targetId: group.id, groupRevision: group.revision, goal: '기존 접수', requestKey: 'before-delete' };
  const { request } = acceptRequest(store, input);
  const before = engine.describe(mission.id), accepted = store.need('mission', request.id);
  const removed = await post('/api/groups/delete', { id: group.id, revision: group.revision });
  assert.equal(removed.status, 200);
  assert.ok(store.need('group', group.id).deletedAt);
  assert.deepEqual(store.list('project'), projects);
  assert.deepEqual(engine.describe(mission.id), before);
  assert.deepEqual(store.need('mission', request.id), accepted);
  assert.deepEqual(store.need('target-request', request.id), request);
  const overview = await (await fetch(dashboard.url + '/api/overview')).json();
  assert.equal(overview.groups.some(g => g.id === group.id), false);
  assert.equal(overview.projects.length, projects.length);
  assert.ok(overview.requests.some(r => r.id === request.id));
  assert.equal((await post('/api/requests', input)).body.id, request.id);
  for (const groupRevision of [undefined, group.revision, group.revision + 1]) {
    assert.equal((await post('/api/requests', { ...input, groupRevision, requestKey: 'after-delete' })).status, 404);
  }
  const orphan = draft('orphan');
  for (const revision of [group.revision, group.revision + 1]) {
    assert.equal((await post('/api/groups', { group: { ...group, projectIds: [orphan.id] }, revision, newProjects: [orphan] })).status, 404);
    assert.equal(store.get('project', orphan.id), undefined);
  }
  assert.equal((await post('/api/groups', { group })).status, 409);
  assert.throws(() => engine.catalog.membership(group.id, projects[0].id, 'add', group.revision + 1), { code: 'not-found' });
  assert.throws(() => engine.catalog.snapshot({ groupIds: [group.id], projectIds: [] }), { code: 'not-found' });
  const finished = await engine.run(mission.id, new SimulationRunner());
  assert.equal(finished.state, 'simulation-complete');
  assert.deepEqual(finished.scope, before.scope);
});

registrationTest('empty group deletion requires dashboard authentication and current version; stale tabs cannot delete an edited group', async ({ engine, store, post }) => {
  const group = engine.catalog.group({ id: 'empty-delete', name: '빈 그룹', projectIds: [] });
  const input = { id: group.id, revision: group.revision };
  for (const headers of [{ 'X-Master-Token': '' }, { Origin: 'https://other.example' }]) {
    assert.equal((await post('/api/groups/delete', input, headers)).status, 403);
  }
  for (const revision of [undefined, 0, -1, '1', 1.5]) {
    assert.equal((await post('/api/groups/delete', { id: group.id, revision })).status, 400);
  }
  assert.equal((await post('/api/groups/delete', { id: 'missing', revision: 1 })).status, 404);
  assert.deepEqual(store.need('group', group.id), group);
  const edited = engine.catalog.group({ ...group, name: '바뀐 그룹' }, group.revision);
  assert.equal((await post('/api/groups/delete', input)).status, 409);
  assert.deepEqual(store.need('group', group.id), edited);
  assert.equal((await post('/api/groups/delete', { id: group.id, revision: edited.revision })).status, 200);
  assert.equal((await post('/api/groups/delete', { id: group.id, revision: edited.revision })).status, 404);
  assert.deepEqual(engine.catalog.groups().map(g => g.id), ['test-commerce']);
});

registrationTest('manual registration persists an existing folder without installing, granting control or accepting forged evidence', async ({ store, post, draft }) => {
  const project = draft('manual');
  const result = await post('/api/projects', { project: { ...project, knowledgeSnapshotId: 'forged', control: { owner: true } } });
  assert.equal(result.status, 201);
  const saved = store.need('project', project.id);
  assert.deepEqual(saved.references, ['operator:project:manual']);
  assert.deepEqual(saved.constraints, []);
  assert.equal(saved.knowledgeSnapshotId, undefined);
  assert.equal(saved.control, undefined);
  assert.deepEqual(store.list('control-binding'), []);
  assert.deepEqual(readdirSync(project.path), []);
  assert.equal((await post('/api/projects', { project }, { 'X-Master-Token': '' })).status, 403);
  assert.equal((await post('/api/projects', { project }, { Origin: 'https://other.example' })).status, 403);
});

registrationTest('manual registration rejects relative, absent and file paths, malformed metadata and duplicate real directories', async ({ root, store, post, draft }) => {
  const project = draft('valid');
  const file = join(root, 'file.txt'); writeFileSync(file, 'unchanged');
  for (const path of ['relative-project', join(root, 'absent'), file]) {
    const response = await post('/api/projects', { project: { ...project, path } });
    assert.equal(response.status, 400); assert.equal(response.body.error, 'invalid-path');
  }
  assert.equal((await post('/api/projects', { project: { ...project, domains: [] } })).status, 400);
  assert.equal((await post('/api/projects', { project: { ...project, references: 'invalid' } })).status, 400);
  assert.equal((await post('/api/projects', { project })).status, 201);
  const duplicate = await post('/api/projects', { project: { ...project, id: 'duplicate', path: join(project.path, '..', 'valid') } });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error, 'duplicate-path');
  const other = draft('other');
  const duplicateId = await post('/api/projects', { project: { ...other, id: project.id } });
  assert.equal(duplicateId.status, 409); assert.equal(duplicateId.body.error, 'already-exists');
  assert.equal(store.list('project').length, 4);
});

registrationTest('group creation and editing register new projects together with selected existing members', async ({ fixture, store, post, draft }) => {
  const first = draft('first'), second = draft('second');
  const group = { id: 'manual-group', name: '수동 그룹', projectIds: [fixture.projects[0].id, first.id] };
  const created = await post('/api/groups', { group, newProjects: [first] });
  assert.equal(created.status, 200);
  assert.deepEqual(store.need('group', group.id).projectIds, group.projectIds);
  assert.equal(store.need('project', first.id).name, first.name);
  const edited = await post('/api/groups', { group: { ...group, projectIds: [first.id, second.id] },
    revision: created.body.revision, newProjects: [second] });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.projectIds, [first.id, second.id]);
  assert.equal(store.need('project', second.id).name, second.name);
  assert.ok(store.need('project', fixture.projects[0].id));
});

registrationTest('invalid or duplicate later drafts roll back both the group and earlier project/path records', async ({ root, store, post, draft }) => {
  const first = draft('first'), second = draft('second');
  const group = { id: 'atomic-group', name: '원자적 그룹', projectIds: [first.id, second.id] };
  for (const invalid of [{ ...second, path: join(root, 'missing') }, { ...second, path: first.path }, { ...second, id: first.id }, { ...second, domains: [] }]) {
    const result = await post('/api/groups', { group, newProjects: [first, invalid] });
    assert.ok([400, 409].includes(result.status));
    assert.equal(store.list('project').length, 3);
    assert.equal(store.list('group').some(g => g.id === group.id), false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM paths').get().count, 3);
  }
  assert.equal((await post('/api/groups', { group, newProjects: [first, second] })).status, 200);
});

registrationTest('stale group edits and unselected drafts cannot register orphan projects or change group membership', async ({ fixture, store, post, draft }) => {
  const group = store.need('group', fixture.group.id), project = draft('unselected');
  const stale = await post('/api/groups', { group: { ...group, projectIds: [...group.projectIds, project.id] },
    revision: group.revision + 1, newProjects: [project] });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'stale-state');
  const unselected = await post('/api/groups', { group, revision: group.revision, newProjects: [project] });
  assert.equal(unselected.status, 400);
  assert.equal(store.list('project').length, 3);
  assert.deepEqual(store.need('group', group.id), group);
});

registrationTest('candidate list requires dashboard authentication, ignores client scan paths and never registers automatically', async ({ root, store, post, draft }) => {
  const project = draft('installed');
  const initial = await post('/api/project-candidates', {});
  assert.equal(initial.body.projects.some(p => p.path === project.path), false);
  mkdirSync(join(project.path, '.code-agent')); writeFileSync(join(project.path, '.code-agent/version'), 'test');
  const before = store.list('project');
  assert.equal((await post('/api/project-candidates', {}, { 'X-Master-Token': '' })).status, 403);
  assert.equal((await post('/api/project-candidates', {}, { Origin: 'https://other.example' })).status, 403);
  const result = await post('/api/project-candidates', { path: dirname(root) });
  assert.equal(result.status, 200);
  assert.equal(result.body.projects.find(p => p.path === project.path).registeredId, null);
  assert.deepEqual(store.list('project'), before);
  assert.deepEqual(readdirSync(project.path), ['.code-agent']);
  assert.equal(result.body.roots.includes(dirname(root)), false);
  assert.equal((await post('/api/projects', { project })).status, 201);
  const refreshed = await post('/api/project-candidates', {});
  assert.equal(refreshed.body.projects.find(p => p.path === project.path).registeredId, project.id);
});

registrationTest('deletion releases registration and all group memberships while keeping files and historical identity', async ({ store, engine, fixture, mission, dashboard, post }) => {
  await engine.run(mission.id, new SimulationRunner());
  const project = store.need('project', fixture.projects[0].id), before = engine.describe(mission.id);
  const group = store.need('group', fixture.group.id);
  const other = engine.catalog.group({ id: 'other-group', name: '다른 그룹', projectIds: [project.id] });
  mkdirSync(join(project.path, '.code-agent')); writeFileSync(join(project.path, '.code-agent/version'), 'kept');
  writeFileSync(join(project.path, 'source.txt'), 'user source');
  // An independent code-agent cursor does not prevent removing master registration.
  writeFileSync(join(project.path, '.code-agent/active.json'), '{"id":"independent-work"}');
  const removed = await post('/api/projects/delete', { id: project.id, revision: project.revision });
  assert.equal(removed.status, 200);
  assert.deepEqual(new Set(removed.body.removedFromGroups), new Set([group.id, other.id]));
  assert.equal(store.need('group', group.id).revision, group.revision + 1);
  assert.equal(store.need('group', group.id).projectIds.includes(project.id), false);
  assert.deepEqual(store.need('group', other.id).projectIds, []);
  assert.ok(store.need('project', project.id).deletedAt);
  assert.equal(engine.catalog.status().some(p => p.id === project.id), false);
  assert.equal(store.db.prepare('SELECT project_id FROM paths WHERE path=?').get(project.path), undefined);
  assert.equal(readFileSync(join(project.path, 'source.txt'), 'utf8'), 'user source');
  assert.equal(readFileSync(join(project.path, '.code-agent/version'), 'utf8'), 'kept');
  assert.deepEqual(engine.describe(mission.id), before);
  const overview = await (await fetch(dashboard.url + '/api/overview')).json();
  assert.equal(overview.projects.length, 2);
  assert.equal(overview.missions.find(m => m.id === mission.id).status, 'completed');
  const candidates = await post('/api/project-candidates', {});
  assert.equal(candidates.body.projects.find(p => p.path.toLowerCase() === project.path.toLowerCase()).registeredId, null);
  assert.equal((await post('/api/projects', { project })).body.error, 'already-exists');
  const fresh = await post('/api/projects', { project: { ...project, id: 'new-identity' } });
  assert.equal(fresh.status, 201); assert.equal(fresh.body.deletedAt, undefined);
  assert.deepEqual(engine.describe(mission.id), before);
  assert.equal(store.need('mission', mission.id).scope.projectIds.includes('new-identity'), false);
  assert.throws(() => engine.catalog.snapshot({ projectIds: [project.id], groupIds: [] }), { code: 'not-found' });
  assert.throws(() => store.acquire(project.id, mission.id, 'archived'), { code: 'not-found' });
  const request = await post('/api/requests', { targetType: 'project', targetId: project.id, goal: '삭제된 대상' });
  assert.equal(request.status, 404);
  const oldGroup = await post('/api/groups', { group, revision: group.revision });
  assert.equal(oldGroup.status, 409);
  assert.equal((await post('/api/groups', { group: { ...other, projectIds: [project.id] }, revision: other.revision + 1 })).status, 404);
});

registrationTest('deletion requires authentication and exact revision and leaves registration intact on rejection', async ({ store, engine, post, draft }) => {
  const project = engine.catalog.registerManual(draft('deleting'));
  const input = { id: project.id, revision: project.revision };
  for (const headers of [{ 'X-Master-Token': '' }, { Origin: 'https://other.example' }]) {
    assert.equal((await post('/api/projects/delete', input, headers)).status, 403);
  }
  assert.equal((await post('/api/projects/delete', { id: project.id })).status, 400);
  assert.equal((await post('/api/projects/delete', { ...input, revision: project.revision + 1 })).status, 409);
  assert.deepEqual(store.need('project', project.id), project);
  assert.equal((await post('/api/projects/delete', input)).status, 200);
  assert.equal((await post('/api/projects/delete', input)).status, 404);
});

registrationTest('unfinished missions and active execution or update locks prevent deletion', async ({ store, engine, fixture, post, draft }) => {
  const project = store.need('project', fixture.projects[0].id), group = store.need('group', fixture.group.id);
  const busy = await post('/api/projects/delete', { id: project.id, revision: project.revision });
  assert.equal(busy.status, 409); assert.equal(busy.body.error, 'project-in-use');
  assert.deepEqual(store.need('group', group.id), group);
  assert.deepEqual(store.need('project', project.id), project);
  const independent = engine.catalog.registerManual(draft('locked'));
  const input = { id: independent.id, revision: independent.revision };
  store.acquire(independent.id, 'mission', 'attempt');
  assert.equal((await post('/api/projects/delete', input)).body.error, 'project-busy');
  store.release(independent.id, 'attempt');
  const maintenance = store.put('project-maintenance', { id: independent.id, active: true });
  assert.equal((await post('/api/projects/delete', input)).body.error, 'project-busy');
  store.put('project-maintenance', { ...maintenance, active: false }, maintenance.revision);
  const batch = store.put('agent-update', { id: 'preparing', state: 'running', host: hostname(), pid: process.pid,
    projects: [{ id: independent.id, state: 'ready' }] });
  assert.equal((await post('/api/projects/delete', input)).body.error, 'project-busy');
  store.put('agent-update', { ...batch, state: 'completed' }, batch.revision);
  assert.equal((await post('/api/projects/delete', input)).status, 200);
});
