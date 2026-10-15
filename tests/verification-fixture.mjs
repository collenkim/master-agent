import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { temporary, cleanup } from './helpers.mjs';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { LiveExecution } from '../packages/orchestrator/live.mjs';
import { LiveVerification } from '../packages/verification/live-verification.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';
import { snapshotTree } from '../packages/verification/tree.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';

export function verificationFixture(t) {
  const root = temporary(t), store = new Store(join(root, 'state.db')); cleanup(t, () => store.close());
  const engine = new Engine(store), live = new LiveExecution(store), verifier = new LiveVerification(store), states = {};
  const tasks = [], projects = [];
  for (const id of ['one', 'two']) {
    const path = join(root, id); mkdirSync(path);
    writeFileSync(join(path, 'source.mjs'), 'export const value = 1;\n');
    writeFileSync(join(path, 'policy.txt'), '검증 범위 밖 파일을 변경하지 않는다.\n');
    writeFileSync(join(path, 'check.mjs'), "import assert from 'node:assert/strict'; import { value } from './source.mjs'; assert.equal(value,2); console.log('실제 입력 검증 통과');\n");
    const git = args => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
    git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline']);
    let p = engine.catalog.register({ id, name: id, path, domains: ['fixture'], capabilities: ['code-agent:claude'], constraints: [], currentPlans: [], references: ['fixture'] });
    p = new Knowledge(store).collect(id, { schemaVersion: 1, sources: [{ path: 'source.mjs', kind: 'code' }, { path: 'policy.txt', kind: 'policy' }] }, p.revision).project;
    projects.push(p);
    states[id] = { schema: 'code-agent.state', schemaVersion: 1, stateVersion: 'initial', work: null, request: null, approval: null,
      consents: { readable: true, open: [] }, ownership: { process: 'unverified', lease: { state: 'none' } }, resume: { code: 'no-work' }, questions: null };
    tasks.push({ id: `edit-${id}`, projectId: id, domain: 'fixture', kind: 'implementation', goal: 'value를 2로 변경', rationale: '합성 검증 시나리오',
      references: p.references, dependsOn: [], criteria: ['value'], allowedChanges: ['source.mjs'], exclusions: ['policy.txt'], outputs: ['result'], requiredCapabilities: ['code-agent:claude'], verification: '실제 Node assertion' });
  }
  tasks.push({ ...tasks[0], id: 'integrate', kind: 'integration', dependsOn: ['edit-one', 'edit-two'], allowedChanges: [], goal: '두 프로젝트 실제 값 검증' });
  let mission = engine.create({ mode: 'live', goal: '두 프로젝트를 실제 검증으로 완료', requestKey: 'verification', scope: { projectIds: ['one', 'two'], groupIds: [] }, criteria: [{ id: 'value', description: '두 값이 2다.' }] });
  mission = engine.plan(mission.id, { schemaVersion: 1, summary: '검증 연결 고정 시험 계획', unresolved: [], tasks }, mission.revision);
  const recipes = tasks.map(task => ({ schemaVersion: 1, taskId: task.id, allowedPaths: task.allowedChanges,
    checks: (task.kind === 'integration' ? projects : projects.filter(p => p.id === task.projectId)).map(p => ({ id: `check-${p.id}`, executable: process.execPath, args: [join(p.path, 'check.mjs')], criterionIds: ['value'], timeoutMs: 5000 })),
    artifacts: [{ name: 'result', checkId: `check-${task.projectId}` }] }));
  for (const recipe of recipes) mission = verifier.configure(mission.id, recipe, mission.revision);
  const host = { mode: 'live', name: 'claude', async inspect(project) { return structuredClone(states[project.id]); },
    async execute(ticket, { beforeStart } = {}) {
      beforeStart?.();
      if (ticket.task.kind === 'implementation') writeFileSync(join(ticket.project.path, 'source.mjs'), 'export const value = 2;\n');
      const state = states[ticket.project.id];
      Object.assign(state, { stateVersion: `executed-${ticket.id}`, work: { id: ticket.codeAgentWorkId, phase: 'deliver' }, request: { status: 'confirmed' }, approval: { status: 'approved' },
        resume: { code: 'needs-human', next: { action: 'deliver-consent' } }, verification: { bound: { valid: true }, phases: { check: { passed: true }, test: { passed: true } } } });
      return { status: 'returned', sessionId: 'fixture-session', summary: '가짜 호스트 변경; 검증 명령은 실제 실행', permissionDenials: [] };
    } };
  const options = p => ({ expectedRevision: store.need('mission', mission.id).revision, expectedState: states[p].stateVersion });
  const dispatch = async taskId => {
    const task = tasks.find(t => t.id === taskId);
    await live.dispatch(mission.id, taskId, host, options(task.projectId));
    return store.need('mission', mission.id).attempts.at(-1);
  };
  const verify = attempt => verifier.verify(mission.id, attempt.id, host, options(attempt.projectId));
  const release = async attempt => {
    Object.assign(states[attempt.projectId], { stateVersion: `released-${attempt.id}`, work: null, request: null, resume: { code: 'no-work' } });
    return verifier.handoff(mission.id, attempt.id, host, options(attempt.projectId));
  };
  return { root, store, engine, live, verifier, mission, projects, tasks, recipes, states, host, dispatch, verify, release, options };
}

