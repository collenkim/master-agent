import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { temporary } from './helpers.mjs';
import { projectCandidates } from '../packages/dashboard/project-candidates.mjs';

function install(path) {
  mkdirSync(join(path, '.code-agent'), { recursive: true });
  writeFileSync(join(path, '.code-agent/version'), 'test');
  return path;
}

test('candidate discovery finds installed projects once, includes registered markers and skips dependencies, hidden and deep folders', async t => {
  const root = temporary(t), options = { cwd: root, home: dirname(root) };
  const first = install(join(root, 'first')), second = install(join(root, 'services', 'second'));
  mkdirSync(join(root, 'not-installed'));
  for (const path of ['node_modules/dependency', '.hidden/private', 'nested/too/deep']) install(join(root, path));
  const result = await projectCandidates([{ id: 'first-id', name: '등록된 서비스', path: first }], options);
  assert.equal(result.truncated, false);
  assert.equal(result.projects.length, 2);
  assert.equal(result.projects.find(p => p.path === first).registeredId, 'first-id');
  assert.equal(result.projects.find(p => p.path === first).name, '등록된 서비스');
  assert.equal(result.projects.find(p => p.path === second).registeredId, null);
  assert.ok(result.roots.includes(root));
  const bounded = await projectCandidates([], { ...options, maxDirectories: 1 });
  assert.equal(bounded.truncated, true);
});

test('candidate discovery uses the resolved code-agent source workspace and handles missing roots', async t => {
  const root = temporary(t), cwd = join(root, 'control'), workspace = join(root, 'workspace');
  mkdirSync(cwd);
  const packageRoot = join(workspace, 'code-agent'); mkdirSync(join(packageRoot, 'dist/agent'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'code-agent' }));
  const project = install(join(workspace, 'service'));
  const result = await projectCandidates([], { cwd, home: root, cliPath: join(packageRoot, 'dist/agent/cli.js') });
  assert.ok(result.roots.includes(workspace));
  assert.deepEqual(result.projects.map(p => p.path), [project]);
  assert.equal(result.truncated, false);
});
