import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Store } from '../packages/storage/store.mjs';
import { Catalog } from '../packages/catalog/catalog.mjs';
import { observeProject } from '../packages/code-agent-adapter/observe.mjs';
import { hash } from '../packages/domain/contracts.mjs';

if (!process.argv[2]) throw new Error('node scripts/smoke-code-agent.mjs <code-agent CLI 절대 경로>');
const cli = resolve(process.argv[2]);
const parent = realpathSync(tmpdir());
const root = realpathSync(mkdtempSync(join(parent, 'master-agent-smoke-')));
let store;
function snapshot(path) {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry =>
    [entry.name, entry.isDirectory() ? snapshot(join(path, entry.name)) : hash(readFileSync(join(path, entry.name)).toString('base64'))]);
}
try {
  const project = join(root, 'project'); mkdirSync(project);
  execFileSync('git', ['init', '--quiet', project], { stdio: 'pipe' });
  mkdirSync(join(project, '.code-agent')); writeFileSync(join(project, '.code-agent/version'), 'state-contract-smoke-fixture');
  store = new Store(join(root, 'state.db'));
  new Catalog(store).register({ id: 'smoke', name: '상태 계약 검증용 임시 저장소', path: project, domains: ['fixture'], capabilities: [], constraints: [], currentPlans: [], references: ['smoke-fixture@1'] });
  const before = snapshot(project);
  const observation = await observeProject(store, 'smoke', { cliPath: cli });
  assert.equal(observation.status, 'observed', JSON.stringify(observation));
  assert.equal(observation.state.schemaVersion, 1);
  assert.equal(observation.state.resume.code, 'no-work');
  assert.deepEqual(snapshot(project), before);
  console.log(JSON.stringify({ passed: true, schema: observation.state.schema, resume: observation.state.resume.code, projectUnchanged: true, scope: '실제 CLI 상태 조회 계약만 확인; 전체 설치·개발 실행은 미검증' }));
} finally {
  store?.close();
  if (dirname(root) !== parent || !basename(root).startsWith('master-agent-smoke-')) throw new Error('임시 경로 경계 오류');
  rmSync(root, { recursive: true, force: true });
}
