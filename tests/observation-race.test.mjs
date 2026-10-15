import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeProject } from '../packages/code-agent-adapter/observe.mjs';
import { setup } from './helpers.mjs';

test('늦게 끝난 이전 관측이 최신 관측을 덮지 않는다', async t => {
  const { store, fixture, root } = setup(t);
  const project = fixture.projects[0];
  mkdirSync(join(project.path, '.code-agent')); writeFileSync(join(project.path, '.code-agent/version'), 'fixture');
  const oldCli = join(root, 'old.mjs'), newCli = join(root, 'new.mjs');
  const state = { schema: 'code-agent.state', schemaVersion: 1, observedAt: new Date().toISOString(), stateVersion: 'new', repo: { root: project.path }, work: null, resume: { code: 'no-work', reasons: [] }, ownership: { process: 'unverified', lease: { state: 'none' } }, unknown: [] };
  writeFileSync(oldCli, 'setTimeout(() => console.log("broken old output"), 300);');
  writeFileSync(newCli, `console.log(${JSON.stringify(JSON.stringify(state))});`);
  const oldRequest = observeProject(store, project.id, { cliPath: oldCli });
  const newRequest = observeProject(store, project.id, { cliPath: newCli });
  await Promise.all([oldRequest, newRequest]);
  assert.equal(store.need('observation', project.id).state.stateVersion, 'new');
  assert.equal(store.need('observation', project.id).status, 'observed');
});
