import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { demoDefinition } from '../packages/simulation/demo.mjs';

const cleanups = new WeakMap();
export function cleanup(t, fn) { cleanups.get(t).push(fn); }
export function temporary(t) {
  const parent = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(parent, 'master-agent-test-')));
  cleanups.set(t, []);
  t.after(() => {
    for (const fn of cleanups.get(t).reverse()) fn();
    if (dirname(root) !== parent || !basename(root).startsWith('master-agent-test-')) throw new Error('임시 경로 경계 오류');
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
export function setup(t, { plan = true } = {}) {
  const root = temporary(t);
  const db = join(root, 'state.db');
  const store = new Store(db);
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  cleanup(t, close);
  const engine = new Engine(store);
  const fixture = demoDefinition(join(root, 'projects'), 'test');
  for (const p of fixture.projects) { mkdirSync(p.path, { recursive: true }); engine.catalog.register(p); }
  engine.catalog.group(fixture.group);
  let mission = engine.create(fixture.mission);
  if (plan) mission = engine.plan(mission.id, fixture.plan, mission.revision);
  return { root, db, store, engine, fixture, mission, close };
}
